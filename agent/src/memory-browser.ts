import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { EvidenceRef } from './contracts';
import type { Store } from './store';

const Query = z.object({
  kind: z.enum(['facts', 'reminders']).default('facts'),
  query: z.string().trim().max(2000).default(''),
  from: z.coerce.number().finite().nonnegative().optional(),
  to: z.coerce.number().finite().nonnegative().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(40),
  cursor: z.string().max(1000).optional(),
  history: z.enum(['true', 'false']).default('false').transform(v => v === 'true'),
}).strict().refine(v => v.from === undefined || v.to === undefined || v.from <= v.to, 'Invalid time range');
const Cursor = z.object({ filter: z.string(), snapshot: z.number().int().nonnegative(),
  at: z.number().finite().nonnegative(), row: z.number().int().positive() }).strict();

/** A paged inspection of durable agent memory. GET never schedules or wakes work. */
export function browseAgentMemory(store: Store, owner: string, input: Record<string, string>) {
  const { cursor: encoded, limit, ...filter } = Query.parse(input);
  const signature = createHash('sha256').update(JSON.stringify({ owner, ...filter })).digest('hex');
  let cursor: z.output<typeof Cursor> | undefined;
  if (encoded) {
    try { cursor = Cursor.parse(JSON.parse(Buffer.from(encoded, 'base64url').toString())); }
    catch { throw new z.ZodError([{ code: 'custom', path: ['cursor'], message: 'Invalid memory cursor' }]); }
    if (cursor.filter !== signature) throw new z.ZodError([{ code: 'custom', path: ['cursor'], message: 'Memory filters changed; start a new page' }]);
  }
  const table = filter.kind === 'facts' ? 'memories' : 'reminders';
  const conditions = ['m.owner=?', "m.text!=''", `json_array_length(m.refs)>0 AND NOT EXISTS (
    SELECT 1 FROM json_each(m.refs) r WHERE NOT EXISTS (
      SELECT 1 FROM evidence e WHERE e.owner=m.owner AND e.id=json_extract(r.value,'$.eventId')
      AND e.revision=json_extract(r.value,'$.revision') AND e.deleted=0 AND json_extract(e.payload,'$.final')=1
      AND NOT EXISTS(SELECT 1 FROM evidence newer WHERE newer.owner=e.owner AND newer.id=e.id AND newer.revision>e.revision)))`];
  const args: (string | number)[] = [owner];
  if (filter.kind === 'facts' && !filter.history) conditions.push('m.active=1');
  if (filter.query) { conditions.push('instr(lower(m.text),lower(?))>0'); args.push(filter.query); }
  if (filter.from !== undefined) { conditions.push('m.created_at>=?'); args.push(filter.from); }
  if (filter.to !== undefined) { conditions.push('m.created_at<=?'); args.push(filter.to); }
  const snapshot = cursor?.snapshot ?? store.one<{ n: number }>(`SELECT coalesce(MAX(rowid),0) n FROM ${table} WHERE owner=?`, owner)!.n;
  conditions.push('m.rowid<=?'); args.push(snapshot);
  const total = store.one<{ n: number }>(`SELECT COUNT(*) n FROM ${table} m WHERE ${conditions.join(' AND ')}`, ...args)!.n;
  if (cursor) {
    conditions.push('(m.created_at<? OR (m.created_at=? AND m.rowid<?))'); args.push(cursor.at, cursor.at, cursor.row);
  }
  type Row = { rowid: number; id: string; text: string; refs: string; created_at: number; key?: string;
    kind?: string; version?: number; active?: number; state?: string; due_at?: number | null;
    person_id?: string | null; expires_at?: number; task_id?: string };
  const rows = store.all<Row>(`SELECT m.*,m.rowid rowid FROM ${table} m WHERE ${conditions.join(' AND ')}
    ORDER BY m.created_at DESC,m.rowid DESC LIMIT ?`, ...args, limit + 1);
  const page = rows.slice(0, limit), last = page.at(-1);
  const labels = new Map<string, string>();
  const label = (id: string) => {
    if (labels.has(id)) return labels.get(id)!;
    const head = store.one<{ id: string }>('SELECT id FROM memories WHERE owner=? AND key=? AND active=1', owner, `graph.entity:${id}`);
    const memory = head && store.memory(owner, head.id);
    let name = id;
    if (memory) { try { const value = JSON.parse(memory.text); if (typeof value.label === 'string') name = value.label; } catch { /* legacy text */ } }
    labels.set(id, name); return name;
  };
  const items = page.map(row => {
    const refs: EvidenceRef[] = JSON.parse(row.refs);
    const sources = refs.map(ref => {
      const e = store.latest(owner, ref.eventId)!;
      return { ...ref, text: e.text, sourceStart: e.sourceStart, sourceEnd: e.sourceEnd, kind: e.kind, provenance: e.provenance };
    });
    let structured: Record<string, unknown> | null = null;
    if (row.key?.startsWith('graph.')) {
      try { const value = JSON.parse(row.text); if (value && typeof value === 'object' && !Array.isArray(value)) structured = value; } catch { /* legacy plain text */ }
    }
    const title = filter.kind === 'reminders' ? 'Reminder' : typeof structured?.label === 'string' ? structured.label
      : typeof structured?.predicate === 'string' ? `Relation · ${structured.predicate}` : row.kind === 'summary' ? 'Summary' : 'Agent fact';
    let text = row.text;
    if (typeof structured?.label === 'string') text = `${structured.kind ?? 'Entity'} · ${structured.label}`;
    if (typeof structured?.subjectId === 'string' && typeof structured.predicate === 'string')
      text = `${label(structured.subjectId)} · ${structured.predicate} · ${typeof structured.targetId === 'string' ? label(structured.targetId) : String(structured.value ?? '')}`;
    return { id: row.id, kind: filter.kind, at: row.created_at, title, text,
      status: filter.kind === 'reminders' ? row.state! : row.active ? 'current' : 'superseded',
      captureId: null, entityId: null,
      data: filter.kind === 'reminders'
        ? { id: row.id, text: row.text, state: row.state, dueAt: row.due_at, personId: row.person_id,
            expiresAt: row.expires_at, taskId: row.task_id, createdAt: row.created_at, refs, sources }
        : { id: row.id, key: row.key, kind: row.kind, version: row.version, text: row.text,
            createdAt: row.created_at, active: Boolean(row.active), refs, sources, structured },
    };
  });
  return { kind: filter.kind, items, total, nextCursor: rows.length > limit && last
    ? Buffer.from(JSON.stringify({ filter: signature, snapshot, at: last.created_at, row: last.rowid })).toString('base64url') : null };
}
