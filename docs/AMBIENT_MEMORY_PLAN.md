# Ambient memory, identity and time

**2026-09-20 update:** The user superseded the original semantic-retrieval requirement:
use psi-style history grep. The bridge was removed; see [history search](HISTORY_SEARCH.md).

2026-09-19. Work is confined to the `chud3-ai-agent` harness. The reference is the
long KAWK objective in Codex thread `01a0b757-aa5e-73a0-b1d2-43e564bf4683`
(“Build 4D video scene demo”): keys, class reviews, person-linked conversations,
stable entities, additive history and semantic retrieval. The separate, uncommitted
`htn2026-chud3/memory` prototype already implements camera/face packets, entities
and MiniLM retrieval; it remains a separate integration, not an imported dependency.

## Assumptions

One configured account owns the local store. That is not verified wearer identity.
The forward camera can recognize a person in view; it cannot prove who is wearing
the device. Seeing the owner could mean another wearer, a mirror, or an image.
Likewise, seeing William does not establish that William spoke. Keep account,
wearer, visible identity and verified speaker separate. No wearer detector or
voice-to-face verifier is claimed. Lending needs an explicit authenticated session
switch before private account access; that device UX is outside this harness pass.

## Implementation

1. Persist every transcript revision before classification. Materialize private,
   hourly UTC JSONL files from the durable ledger with hourly flushes, atomic
   replacement and restart recovery. Source deletion also redacts the export.
   Raw transcripts default to no automatic expiry; observation retention remains
   configurable. Search by words, time, visible person and separately verified speaker.
2. Add a temporal entity/relation graph backed by cited, versioned memory records.
   Stable gallery IDs anchor people; names and semantic similarity do not establish
   identity. Relations retain source/valid times, uncertainty and history. Corrections
   invalidate derived claims; deletion purges their content.
3. Add explicit durable reminders (time or encountering a known person), list/cancel,
   restart-safe notification delivery, current time and timezone-aware conversion.
   Due explicit reminders do not require a second model to rediscover their intent.
   Existing speculative followups continue to re-enter Jev.
4. Add clock exchange/mapping to the client SDK, monotonic capture and stream epochs,
   source uncertainty and temporal overlap retrieval. Prefer captured audio sample
   times/word offsets and frame exposure times. Arrival-minus-latency is an explicitly
   estimated fallback; no latency mean or unmeasured p95 becomes a confidence claim.
5. Exercise original tasks plus reminders, browser/code, identity ambiguity, delayed
   speech, correction/deletion, hourly rollover and restart. Report live model failures
   as failures; synthetic perception does not establish camera/device accuracy.

Pi migration is independent of these capabilities and is not part of this change.
