# History search

2026-09-20 UTC, `chud3-ai-agent`. The user chose psi-style history grep instead of
semantic retrieval. The reference is `psi` on `feat/multi-user-discord`, specifically
`packages/grep-history/src/index.ts` and `packages/tools/src/grep-history-tool.ts`.
That checkout is reference-only and was not modified.

## Retrieval path

1. `grep_history` runs real ripgrep with short keywords or regex alternatives.
2. Matches include original source text, source/receipt times, identity uncertainty
   and exact evidence references. Use them directly when sufficient.
3. `read_evidence` supplies full details including word timings; `temporal_context`
   supplies nearby source-time events when context is needed.
4. The agent can expand its keywords or widen a time range. Search itself does no
   semantic matching. A failed keyword search is not proof an event never happened.

`search_memory` remains SQLite keyword FTS over saved notes/evidence, and
`query_graph` follows explicit saved relationships. Neither uses embeddings.
The MiniLM bridge, its tool, and `KAWK_MEMORY_URL` were removed from runtime/config.
The separate perception/memory prototype was not modified.

## Journal and archives

The grep input is a JSONL stream from the account's durable SQLite evidence journal.
This covers current finalized transcripts, observations and tool/context events,
including speech Jev ignored and the current hour before export. It avoids copying
history into another index or loading the entire history into model context.

Hourly JSONL archives still retain every transcript revision. The normal agent search
uses current final revisions, so archived partials and superseded/deleted statements
cannot silently become current facts. Search strips per-word arrays from its input;
the full source remains available through `read_evidence`. Internal agent/model chat
messages are stored separately and are not part of this perception-history tool.

Existing retention policies still apply: raw speech has no automatic expiry by
default, while unpinned observations/context normally expire after seven days.

## API and limits

Install ripgrep on the host (`brew install ripgrep` on macOS). Startup requires `rg`
on PATH. This is a fixed read-only subprocess, not the agent's general code runner.

```ts
const from = Date.now() - 24 * 60 * 60 * 1000;
const found = await client.grepHistory({
  pattern: "keys|keyring",
  from,
  limit: 20,
});
if (found.nextCursor !== null) {
  const next = await client.grepHistory({
    pattern: "keys|keyring",
    from,
    after: found.nextCursor,
  });
}
```

HTTP: `POST /v1/history/grep`, under the existing bearer/account scope. The request
cannot select an account or filesystem path. Optional `kind`, `from/to`, `personId`
and `speakerId` filters are applied before streaming. `personId` is co-visible
identity; `speakerId` is verified speaker identity. Time filters use source intervals.

Patterns are case-insensitive ripgrep regex by default; `fixedStrings: true` selects
literal matching, and `caseSensitive: true` preserves case. They match the serialized
JSONL fields (text and metadata); JSON escaping still applies. Arguments are passed
directly, with `--regexp` consuming the pattern and `--no-config` disabling local rg
configuration. No shell, custom regex engine or caller-supplied SQL is used.

Results are in ingestion order. A page contains at most 100 matches (default 20),
with about 48k characters of source JSON per page. `truncated`/`nextCursor` report
additional matches; use the same filters when paging. Searches have a ten-second
deadline and respect cancellation. Invalid patterns/failures are errors, not empty
successful results. Concurrent corrections are revalidated before returning citations;
correction after retrieval invalidates dependent tasks through the existing lifecycle.

Old bridge imports are retired from retrieval on database open because remote
versions can no longer be checked. Their original payloads remain in SQLite, while
dependent claims/notifications are invalidated. Local captured sources are preserved.

## Verification

These checks describe the history-grep change before Docker was replaced. Current
runner behavior and checks are in [LOCAL_RUNNER.md](LOCAL_RUNNER.md).

- `bun run check`: 57 passed; three Docker cases are run separately.
- `bun run test:runner`: 3 passed (code execution, browser and cleanup/isolation).
- Strict TypeScript unused checks and `git diff --check`: passed.
- New coverage exercises current-hour/no-Jev history, restart, account isolation,
  source-time/person/speaker filters, regex/literal/option-like patterns, pagination,
  result limits, cancellation, correction/deletion, task invalidation and old imports.

The [first live run](../agent/data/perf/2026-09-20T03-20-50-408Z/REPORT.md) used
synthetic history with real OpenAI (`gpt-5.6-sol`, reasoning `none`) and Jev, fallback
disabled. All four tasks invoked `grep_history` and retrieved their supporting
history. Class, William and notebook answers were delivered. The correct keys answer
was rejected by Jev delivery review: **3/4 end-to-end passed**, retained as a failure.
The six grep calls took 10–16 ms on these small fixtures; this is not a large-history
benchmark. Model calls, not grep, accounted for most of the response time.

The guidance was then clarified to use complete returned evidence directly, avoiding
an unnecessary extra model turn just to read the same text again. The
[second live run](../agent/data/perf/2026-09-20T03-22-38-318Z/REPORT.md) passed **4/4**:

| Recall task | Ingest to delivered result |
|---|---:|
| Keys after two sightings | 6.56s |
| Calculus class and homework | 8.61s |
| William conversation, preserving unknown speaker | 6.40s |
| Older notebook observation | 3.81s |

All four invoked `grep_history`. Jev's delivery rules/thresholds were not changed;
the first failure remains evidence of classifier variability, not a fixed classifier
bug. These are single synthetic-history samples, not latency or accuracy guarantees.
