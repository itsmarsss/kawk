import { z } from "zod";
import { setImmediate } from "node:timers/promises";
import { Conflict, Id, refOf, type Evidence, type EvidenceRef } from "./contracts";
import type { Store } from "./store";

export const HistoryQuery = z
  .object({
    pattern: z
      .string()
      .min(1)
      .max(1000)
      .refine((s) => !/[\r\n\0]/.test(s), "Use a single-line pattern"),
    fixedStrings: z.boolean().default(false),
    caseSensitive: z.boolean().default(false),
    kind: z.enum(["transcript", "observation", "context"]).optional(),
    from: z.number().finite().nonnegative().optional(),
    to: z.number().finite().nonnegative().optional(),
    personId: Id.optional(),
    speakerId: Id.optional(),
    limit: z.number().int().min(1).max(100).default(20),
    after: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).default(0),
  })
  .strict()
  .refine(
    (v) => v.from === undefined || v.to === undefined || v.to >= v.from,
    "Invalid time window",
  );

export type HistoryMatch = Omit<Evidence, "owner" | "words"> & {
  cursor: number;
  evidenceRef: EvidenceRef;
};
export interface HistoryResult {
  matches: HistoryMatch[];
  truncated: boolean;
  nextCursor: number | null;
}

/** Psi-style ripgrep over JSONL, streamed from the durable journal. This includes
 * the unexported hour without searching stale revisions in archival files. No
 * embedding service, temporary history copy, shell, or model-generated SQL. */
export async function grepHistory(
  store: Store,
  owner: string,
  input: z.input<typeof HistoryQuery>,
  signal?: AbortSignal,
): Promise<HistoryResult> {
  const query = HistoryQuery.parse(input);
  const abort = AbortSignal.any([AbortSignal.timeout(10000), ...(signal ? [signal] : [])]);
  abort.throwIfAborted();
  const rg = Bun.which("rg");
  if (!rg) throw new Error("History search requires ripgrep (rg) on PATH");
  const clauses = [
    "e.owner=?",
    "e.deleted=0",
    "json_extract(e.payload,'$.final')=1",
    "e.revision=(SELECT MAX(revision) FROM evidence WHERE owner=e.owner AND id=e.id)",
  ];
  const bindings: (string | number)[] = [owner];
  for (const [field, value] of [
    ["kind", query.kind],
    ["speakerId", query.speakerId],
  ] as const) {
    if (value !== undefined) {
      clauses.push(`json_extract(e.payload,'$.${field}')=?`);
      bindings.push(value);
    }
  }
  if (query.personId) {
    clauses.push("EXISTS (SELECT 1 FROM json_each(e.payload,'$.personIds') WHERE value=?)");
    bindings.push(query.personId);
  }
  if (query.from !== undefined) {
    clauses.push("json_extract(e.payload,'$.sourceEnd')>=?");
    bindings.push(query.from);
  }
  if (query.to !== undefined) {
    clauses.push("json_extract(e.payload,'$.sourceStart')<=?");
    bindings.push(query.to);
  }
  const ceiling = store.one<{ id: number }>(
    "SELECT COALESCE(MAX(rowid),0) AS id FROM evidence WHERE owner=?",
    owner,
  )!.id;
  let cursor = query.after;
  let inputError: unknown;
  const encoder = new TextEncoder();
  const stdin = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        abort.throwIfAborted();
        const rows = store.all<{ cursor: number; payload: string; received_at: number }>(
          `SELECT e.rowid AS cursor,json_remove(e.payload,'$.words') AS payload,e.received_at
           FROM evidence e WHERE ${clauses.join(" AND ")} AND e.rowid>? AND e.rowid<=?
           ORDER BY e.rowid LIMIT 64`,
          ...bindings,
          cursor,
          ceiling,
        );
        if (!rows.length) return controller.close();
        cursor = rows.at(-1)!.cursor;
        controller.enqueue(
          encoder.encode(
            rows
              .map(
                (r) =>
                  JSON.stringify({
                    cursor: r.cursor,
                    receivedAt: r.received_at,
                    ...JSON.parse(r.payload),
                  }) + "\n",
              )
              .join(""),
          ),
        );
        // Let perception ingestion and cancellation run between bounded batches.
        await setImmediate();
      } catch (error) {
        inputError = error;
        controller.error(error);
      }
    },
  });
  const args = [
    rg,
    "--no-config",
    "--text",
    "--color=never",
    "--no-heading",
    "--no-filename",
    "--no-line-number",
    "--max-count",
    String(query.limit + 1),
  ];
  if (!query.caseSensitive) args.push("--ignore-case");
  if (query.fixedStrings) args.push("--fixed-strings");
  // The pattern is one argv value, including leading '-'; only stdin is searched.
  args.push("--regexp", query.pattern, "--", "-");
  const process = Bun.spawn(args, { stdin, stdout: "pipe", stderr: "pipe", signal: abort });
  const [stdout, stderr, code] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  abort.throwIfAborted();
  if (inputError) throw inputError;
  if (code !== 0 && code !== 1) throw new Error(`ripgrep failed: ${stderr.trim().slice(0, 2000)}`);
  const matches: HistoryMatch[] = [];
  let size = 0;
  let truncated = false;
  for (const line of stdout.split("\n").filter(Boolean)) {
    if (matches.length === query.limit || (matches.length > 0 && size + line.length > 48000)) {
      truncated = true;
      break;
    }
    const match = JSON.parse(line) as Omit<HistoryMatch, "evidenceRef">;
    matches.push({ ...match, evidenceRef: refOf(match) });
    size += line.length;
  }
  // A correction/deletion during the async scan must not become a factual result.
  if (
    matches.length &&
    !store.valid(
      owner,
      matches.map((m) => m.evidenceRef),
    )
  )
    throw new Conflict("History changed during search; retry with current evidence");
  return { matches, truncated, nextCursor: truncated ? matches.at(-1)!.cursor : null };
}
