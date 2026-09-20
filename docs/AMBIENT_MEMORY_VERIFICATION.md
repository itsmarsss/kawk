# Ambient memory verification — 2026-09-20 UTC

Historical verification for the initial extension. The later user-requested removal
of semantic retrieval and its current verification are in [history search](HISTORY_SEARCH.md).

Worktree: `chud3-ai-agent`. Original task reference: the long KAWK objective in Codex thread `01a0b757-aa5e-73a0-b1d2-43e564bf4683` (“Build 4D video scene demo”). Current user request covers identity assumptions, durable transcripts, graph/memory, reminders, timing and varied agent tasks. The follow-up asked for established libraries and regression protection.

## Dependencies and regression checks

- Calendar/timezones: pinned `@js-temporal/polyfill@0.5.1`; custom DST enumeration was removed.
- Atomic transcript-file writes: pinned `write-file-atomic@7.0.1`; tested on Bun 1.3.2.
- Durable data, FTS and graph traversal: existing SQLite; no new graph daemon.
- Semantic memory: read-only adapter to the existing MiniLM/sqlite-vec service; no duplicate embedding engine.
- `bun run check`: **51 passed**, 3 Docker cases skipped in this command.
- Separate `bun run test:runner`: **3 passed** (code, browser, cleanup/isolation).
- `bunx tsc --noEmit --noUnusedLocals --noUnusedParameters`: passed.
- `git diff --check`: passed.

## Live task results

The complete ten-case run passed 10/10. Subsequent focused checks verified the source-relative reminder fix and the new identity-context receipt. Rows below are the latest result per distinct task, **not one 11/11 single run or a latency distribution**. Synthetic perception history; real Jev, direct OpenAI API (`gpt-5.6-sol`, reasoning `none`) and actual Docker browser/code. Baseten fallback was disabled to attribute these calls to OpenAI.

| Task | Result | Ingest-to-result |
|---|---|---:|
| Original task: keys moved between sightings | PASS | 6.505s |
| Original task: review a class from raw transcripts | PASS | 5.779s |
| Original task: William conversation with unverified speaker | PASS | 7.772s |
| Persist and retrieve a relationship graph | PASS | 9.496s |
| Create and actually deliver a timed reminder | PASS | 20.097s |
| Run a calculation in code | PASS | 5.327s |
| Read a live web page | PASS | 5.643s |
| Delegate two memory lookups | PASS | 13.281s |
| Abstain when evidence is missing | PASS | 4.639s |
| Stay quiet on filler | PASS | 0.266s |
| Seeing the owner does not establish wearer identity | PASS | 4.237s |

The 20-second reminder arrived in 20.097 seconds from ingestion after anchoring its deadline to the original speech source end. The previous implementation scheduled from a later current-time lookup and delivered around 21.5 seconds. That older run is retained. Browser and code checks actually executed their tools. Person recall preserved unknown speaker identity. The owner-in-view test answered that wearer identity remains unknown.

## Failed attempts and limits

- Initial ten-case run passed 6/10: reminder/graph activation was suppressed, and valid keys/subagent answers were rejected.
- Removed the redundant yes/no activation gate after it contradicted high-confidence routing decisions. Memory selection remains independent.
- Keys needed the earlier source establishing what “the same keyring” referred to. Graph confirmations needed actual operation receipts. Added those to agent guidance/tool results instead of lowering the delivery threshold.
- The first extra wearer case generated the correct limitation but was suppressed. `get_identity_context` now returns the actual configured identity capabilities with a host receipt; the rerun delivered the supported answer.
- Focused Jev evaluation: **11/12** passed. One valid qualified answer about an unidentified speaker remains falsely suppressed. Fabricated location, question-only support and falsely attributing speech were rejected. This failure is retained in `agent/data/ambient-gate-eval-v2.jsonl`. No claim of complete classifier accuracy.
- Existing memory service `http://127.0.0.1:8082` responded to a live semantic search in 31 ms but returned **zero hits**. This verifies connectivity/protocol, not semantic retrieval quality. Nonempty results, candidate uncertainty and version invalidation are covered by adapter fixtures. That bridge and configuration were subsequently removed at the user’s request.
- No automatic wearer detector, account-to-gallery enrollment binding, physical glasses push or new capture-to-agent connection was implemented. The SDK clock exchange and interval matching are tested; actual microphone/video synchronization still requires capture integration and annotated recordings.
- Source uncertainty bounds are conditional engineering bounds, not calibrated confidence percentages. Old latency means are not used as capture timestamps.

## Reports

- [ambient-live.log](../agent/data/perf/2026-09-20T02-50-43-834Z/REPORT.md)
- [ambient-live-v2.log](../agent/data/perf/2026-09-20T02-54-20-392Z/REPORT.md)
- [ambient-live-v3.log](../agent/data/perf/2026-09-20T02-57-17-622Z/REPORT.md)
- [ambient-live-final.log](../agent/data/perf/2026-09-20T03-00-27-177Z/REPORT.md)
- [ambient-live-timing.log](../agent/data/perf/2026-09-20T03-03-06-937Z/REPORT.md)
- [ambient-live-identity.log](../agent/data/perf/2026-09-20T03-10-57-635Z/REPORT.md)
