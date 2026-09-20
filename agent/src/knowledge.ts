import { createHash } from "node:crypto";
import { z } from "zod";
import { Conflict, Id, RefSchema, parseJSON, type EvidenceRef } from "./contracts";
import type { Store } from "./store";

const refs = z.array(RefSchema).min(1).max(32);
export const EntityInput = z
  .object({
    key: Id,
    kind: z.enum(["person", "object", "place", "event", "topic"]),
    label: z.string().min(1).max(200),
    aliases: z.array(z.string().min(1).max(200)).max(16).default([]),
    galleryId: Id.optional(),
    refs,
  })
  .strict();
export const RelationInput = z
  .object({
    key: Id,
    subjectId: Id,
    predicate: z.string().min(1).max(100),
    targetId: Id.optional(),
    value: z.string().min(1).max(2000).optional(),
    validFrom: z.number().finite().nonnegative(),
    validTo: z.number().finite().nonnegative().optional(),
    certainty: z.enum(["observed", "reported", "uncertain"]),
    refs,
  })
  .strict()
  .refine((a) => Boolean(a.targetId) !== Boolean(a.value), "Choose targetId or value")
  .refine((a) => a.validTo === undefined || a.validTo >= a.validFrom, "Invalid validity interval");

interface NodeRow {
  id: string;
  key: string;
  kind: string;
  gallery_id: string | null;
}
interface Claim {
  id: string;
  version: number;
  active: number;
  text: string;
  refs: string;
  created_at: number;
}
type EntityDescription = Omit<z.output<typeof EntityInput>, "key" | "refs" | "galleryId"> & {
  galleryId: string | null;
};
interface GraphEntity extends EntityDescription {
  id: string;
  refs: EvidenceRef[];
}
type GraphRelation = z.output<typeof RelationInput> & {
  id: string;
  version: number;
  status: "current" | "superseded";
  recordedAt: number;
};

/** Topology is SQLite; claim content and revisions use the existing evidence-backed
 * memory lifecycle. No new graph daemon, vector engine or parallel identity system. */
export class KnowledgeGraph {
  constructor(private store: Store) {}
  entity(owner: string, input: z.input<typeof EntityInput>) {
    const value = EntityInput.parse(input),
      { store } = this;
    return store.atomic(() => {
      if (!store.valid(owner, value.refs)) throw new Conflict("Entity needs current evidence");
      if (
        value.galleryId &&
        (value.kind !== "person" ||
          !value.refs.some((ref) =>
            store.latest(owner, ref.eventId)?.personIds.includes(value.galleryId!),
          ))
      )
        throw new Conflict("Gallery identity must be present in cited face evidence");
      // Repeated face IDs cannot create a second person just because a name changed.
      const key = value.galleryId ? `gallery:${value.galleryId}` : value.key;
      const old = store.one<NodeRow>(
        "SELECT * FROM graph_nodes WHERE owner=? AND key=?",
        owner,
        key,
      );
      if (old && (old.kind !== value.kind || old.gallery_id !== (value.galleryId ?? null)))
        throw new Conflict("Entity identity/kind changed");
      const id =
        old?.id ??
        `entity-${createHash("sha256")
          .update(JSON.stringify([owner, key]))
          .digest("hex")
          .slice(0, 32)}`;
      store.run(
        "INSERT OR IGNORE INTO graph_nodes VALUES(?,?,?,?,?)",
        owner,
        id,
        key,
        value.kind,
        value.galleryId ?? null,
      );
      const memory = store.remember(
        owner,
        `graph.entity:${id}`,
        JSON.stringify({
          label: value.label,
          aliases: value.aliases,
          kind: value.kind,
          galleryId: value.galleryId ?? null,
        }),
        "fact",
        value.refs,
      );
      return {
        id,
        ...parseJSON<EntityDescription>(memory.text),
        version: memory.version,
        refs: memory.refs,
      };
    });
  }
  node(owner: string, id: string): GraphEntity | null {
    const node = this.store.one<NodeRow>(
      "SELECT * FROM graph_nodes WHERE owner=? AND id=?",
      owner,
      id,
    );
    if (!node) return null;
    const head = this.store.one<{ id: string }>(
      "SELECT id FROM memories WHERE owner=? AND key=? AND active=1",
      owner,
      `graph.entity:${id}`,
    );
    const memory = head && this.store.memory(owner, head.id);
    return memory ? { id, ...parseJSON<EntityDescription>(memory.text), refs: memory.refs } : null;
  }
  relation(owner: string, input: z.input<typeof RelationInput>) {
    const value = RelationInput.parse(input),
      { store } = this;
    return store.atomic(() => {
      const subject = this.node(owner, value.subjectId);
      const target = value.targetId ? this.node(owner, value.targetId) : null;
      if (!subject || (value.targetId && !target))
        throw new Conflict("Unknown or invalidated graph entity");
      const sources = [...value.refs, ...subject.refs, ...(target?.refs ?? [])] as EvidenceRef[];
      // Claim data is only in memories.text, so existing deletion purges it too.
      const memory = store.remember(
        owner,
        `graph.relation:${value.key}`,
        JSON.stringify(value),
        "fact",
        [...new Map(sources.map((r) => [`${r.eventId}@${r.revision}`, r])).values()],
      );
      store.run(
        "INSERT OR IGNORE INTO graph_links VALUES(?,?,?,?)",
        owner,
        memory.id,
        value.subjectId,
        value.targetId ?? null,
      );
      return { id: memory.id, version: memory.version, ...value };
    });
  }
  query(
    owner: string,
    options: {
      query?: string;
      entityId?: string;
      from?: number;
      to?: number;
      history?: boolean;
    } = {},
  ) {
    const roots = options.entityId
      ? [options.entityId]
      : this.store
          .all<{ id: string }>(
            `SELECT n.id FROM graph_nodes n JOIN memories m ON m.owner=n.owner AND m.key='graph.entity:'||n.id
       WHERE n.owner=? AND m.active=1 AND instr(lower(m.text),lower(?))>0 LIMIT 20`,
            owner,
            options.query ?? "",
          )
          .map((n) => n.id);
    const nodes = new Map<string, GraphEntity>();
    const claims = new Map<string, GraphRelation>();
    for (const root of roots) {
      if (nodes.size >= 50 || claims.size >= 100) break;
      // Two hops, bounded output; SQLite handles traversal and cycle deduplication.
      const reachable = this.store.all<{ id: string }>(
        `WITH RECURSIVE reach(id,depth) AS (
        SELECT ?,0 UNION SELECT CASE WHEN l.subject=r.id THEN l.target ELSE l.subject END,r.depth+1
        FROM reach r JOIN graph_links l ON l.owner=? AND (l.subject=r.id OR l.target=r.id)
        JOIN memories m ON m.id=l.memory_id WHERE r.depth<2 AND l.target IS NOT NULL AND m.active=1)
        SELECT DISTINCT id FROM reach LIMIT 50`,
        root,
        owner,
      );
      for (const { id } of reachable) {
        if (nodes.size >= 50 || claims.size >= 100) break;
        const node = this.node(owner, id);
        if (!node) continue;
        nodes.set(id, node);
        for (const row of this.store.all<Claim>(
          `SELECT m.* FROM graph_links l JOIN memories m ON m.id=l.memory_id
          WHERE l.owner=? AND (l.subject=? OR l.target=?) AND m.text!='' ${options.history ? "" : "AND m.active=1"} ORDER BY m.created_at DESC LIMIT 100`,
          owner,
          id,
          id,
        )) {
          const refs: EvidenceRef[] = JSON.parse(row.refs);
          if (!this.store.valid(owner, refs)) continue;
          const value = parseJSON<z.output<typeof RelationInput>>(row.text);
          if (
            (options.from !== undefined && (value.validTo ?? Infinity) < options.from) ||
            (options.to !== undefined && value.validFrom > options.to)
          )
            continue;
          claims.set(row.id, {
            id: row.id,
            version: row.version,
            status: row.active ? "current" : "superseded",
            recordedAt: row.created_at,
            ...value,
            refs,
          });
        }
      }
    }
    return {
      entities: [...nodes.values()].slice(0, 50),
      relations: [...claims.values()].slice(0, 100),
      truncated: nodes.size >= 50 || claims.size >= 100,
    };
  }
}
