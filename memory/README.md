# KAWK memory generation

This TypeScript service combines five-second camera photos, InsightFace identities
from the same images, and a rolling transcript into persistent, searchable memories.
It evolves one current-state projection and retains source evidence and history.
The optional durable agent bridge now feeds Jev and the Bun answering/action agent.
Use [the merged demo setup](../docs/MERGED_DEMO.md) to run both together; the standalone
commands below still run scene memory without the agent bridge.

## Run

Requires Node22+, the existing perception lab on port8081, and an OpenAI API key
loaded into `OPENAI_API_KEY` from private local configuration outside the repository.
The first embedding request downloads the small public MiniLM model; subsequent
starts use its cache. The default vision and memory model is `gpt-5.6-terra`, with
reasoning disabled. The main path calls the OpenAI Responses API directly.

```sh
# Repository root, first terminal (if the existing lab is not already running):
make serve-ui
# Second terminal:
cd memory
npm ci
npm run build:client
npm run dev
```

Open http://localhost:8082. Start acquires camera/microphone and begins capture;
opening the page alone does not record. Use the existing face enrollment page at
http://localhost:8081/faces to enroll names in the shared gallery. Unknown faces
have provisional stream/track IDs; recognized people use persistent gallery UUIDs.
The main service binds `0.0.0.0`; remote browser camera access requires trusted HTTPS.

Configuration is in [.env.example](.env.example). Export those variables in your
shell; the server does not silently load arbitrary environment files. The optional
`codex` provider remains available for R&D through the signed-in CLI. ChatGPT/Codex
sign-in does not supply an OpenAI API key.

`MEMORY_MODEL` chooses the base model. Optional `MEMORY_WRITER_MODEL` chooses
the text-only memory updater; unset, both use the same model. The default remains
Terra for both. Optional `MEMORY_VISION_PROVIDER` and `MEMORY_VISION_MODEL` override
only image interpretation. A Baseten Qwen adapter is available but **disabled by
default**; see [configuration and verification](../docs/BASETEN_VISION.md).
Splitting providers is an R&D comparison, not an established speedup. Each operation
logs its actual provider/model; `/api/config` reports the selected vision
`provider`/`model` separately from `writerProvider`/`writerModel`.

The server allows one recovery attempt for transient provider errors or invalid
model output (`MEMORY_MODEL_ATTEMPTS=2`; choose `1` for single-attempt experiments).
Each attempt is logged separately. It reuses the original evidence, preserves all
identity checks, and never commits a result superseded by a newer transcript.
Authentication, refusal, tool use, output limits and image-integrity failures are
not retried. Restart can repeat an interrupted operation; this is not a lifetime
billing cap. See [the recovery plan](../docs/MEMORY_RECOVERY_PLAN.md).

Writer context now selects recent/current-scene entities, ongoing events, exact
face identities, original final-speech partners, and semantic matches across every
visual observation and final transcript. Older retrieved entities retain their
full metadata and identity evidence. Unrelated anonymous people are excluded from
the recency fallback; their stored history remains available through retrieval.
This changes prompt selection, not stored evidence or memory retention. See
[the context plan](../docs/MEMORY_CONTEXT_PLAN.md).

`MEMORY_UPDATE_FORMAT=simple` is the default. One image call returns detailed
natural-language scene notes, individual objects and positions, visible interactions,
readable text and uncertainties. The model reads signs, handwriting and screens itself;
there is no auxiliary OCR or image-to-entity/anchor conversion in this path. The next
AI call receives those complete notes, matching face evidence, eligible finalized
speech, current state and retrieved history. It develops memories and judges whether
an existing object is the same instance or merely a possible match. All original
image notes remain searchable even when the memory writer selects fewer atomic facts.
See [the simple pipeline plan](../docs/MEMORY_SIMPLE_PLAN.md).

The `canonical`, `source` and `binding` formats remain available for R&D. They
retain their earlier structured output and identity-anchor experiments. Native
Apple Vision OCR (`MEMORY_TEXT_READER=native`) is available only with those formats;
`simple` reads text through the image model directly. Historical measurements and
limitations are in [the R&D verification report](../docs/MEMORY_GENERATION_VERIFICATION.md).

## What is saved

- Original JPEG, hash, capture time, sequence and exact matching face evidence.
- Transcript revisions, word/source intervals, finality and unknown speaker identity.
- Versioned packets containing vision descriptions and the last N words (default200),
  saved as soon as vision finishes even when the memory update is still pending.
- Stable entities for people, places, physical objects and events; additive notes,
  attribute history, encounter spans, event spans and current-state history.
- Real384-dimensional MiniLM embeddings in SQLite/`sqlite-vec`, with durable index jobs.

Source data lives in `memory/data/` by default, excluded from git. `MEMORY_DATA_DIR`
can point to another private directory. State, entities, notes and pending work
survive restart. Embedding failures retain observations and retry indexing.

The last-N-word window is context, not a fresh utterance each tick. Partial words
are visible in packets but withheld from the memory-writing model until final.
Late finals attach to their original time; corrections supersede dependent notes,
state/event summaries and entity descriptions without deleting their audit history.
Affected summaries are cleared while repair is pending; their source-time cursor
does not rewind. Unchanged retries reuse prepared evidence, while changed finals
create immutable packet revisions. Visible people
are possible conversation partners, never automatically identified speakers.

In simple mode, the memory AI judges physical-object continuity from the descriptions
and temporal context, and retains its reason. A same-instance assessment can update
the existing object; a possible or missing assessment keeps a searchable candidate
without changing the known object's description, last-seen time or supported location.
This is an AI judgment, not verified tracking. The older formats retain their
experimental anchor checks. Face identities, source times, transcript finality and
corrections still use the same storage checks in every format.

## Inspect and retrieve

The browser exposes current state, packets, entity history, source photos and semantic
search. Retrieval returns supporting observations rather than generating an answer.
Useful queries include “Where was the keyring?”, “What did the calculus lecture
cover?” and “What conversation happened while William was present?”

API details: [CLIENT_API.md](CLIENT_API.md). Main retrieval endpoints:

- `POST /api/search` with `query`, optional `entityId`, `from`, `to`, `limit`.
- `GET /api/entities/:id` for complete entity history and associated spans.
- `GET /api/packets/:id` and `/history` for evidence and corrections.
- `GET /api/transcripts/:sessionId` for latest transcripts; optional `from`, `to`
  and `includeRevisions=true` expose source-time intervals and correction history.
- `GET /api/history` for source-time state transitions.
- `POST /api/captures/:id/retry` for an explicitly failed processing attempt.

Times are Unix milliseconds. Semantic results carry packet IDs, source times,
entity IDs, evidence keys and uncertainty. Vector proximity finds relevant notes;
it does not establish that two objects or two people are identical.

## Timing and limits

Five seconds is the **capture interval**, not a guaranteed memory-completion time.
Vision has four bounded workers; state commits are ordered. Up to four consecutive
ready packets share one update request without combining their evidence or timestamps.
The whole batch commits atomically, with explicit backward references for entities
created in earlier rows. Corrections to saved memories run individually; any changed final speech
invalidates an in-flight batch before it can commit. No extra wait is added by
default. Optional `MEMORY_BATCH_WAIT_MS` (0–5000) can wait only for the next ordered
capture already being interpreted, bounded from the first packet's readiness.
It never waits for future uploads; corrections and recovered work run immediately.
This is a scheduling experiment, not a measured throughput improvement.
`MEMORY_VISION_CONCURRENCY` (1–8) and `MEMORY_UPDATE_BATCH_SIZE` (1–4)
bound these settings. A120-packet durable
pending limit prevents indefinite backlog; overflow is rejected visibly and recorded
in `capture-gaps.jsonl`. Capture, queue/model processing and indexing delays appear
on the dashboard. `model-latency.jsonl` records sanitized provider timing/token counts.

The fresh direct-API test on three supplied 1224 × 1632 photos produced 450–984
words per image in **10.00–18.46 seconds**. One subsequent memory call took **10.41
seconds for the three-photo batch**. All 55 observations were indexed and survived
restart with identical search results. This small concurrent probe does not establish
sustained five-second throughput. Face and speech inputs were unavailable in it.
Descriptions still missed some details and uncertain OCR readings were imperfect.
See [the simple-path verification](../docs/MEMORY_SIMPLE_VERIFICATION.md).

Five-second sampling can miss brief actions. Single images support visible state,
not a claim that something was picked up or put down. Source JPEGs remain available
to inspect imperfect captions. Unknown faces do not acquire personal names from
appearance. Similar objects remain separate unless evidence supports an existing ID.

The vector search currently scores matching rows exactly after entity/time filters;
it is a local prototype, not an approximate index benchmark for millions of memories.

## Verification

```sh
npm run check
npm test
npm run check:client
npm run test:client
npm run build
```

Offline tests cover source-time windows, partial/final correction, mismatched face
frames, duplicate captures, queue failure/retry, older results, stable person IDs,
keys relocation, room transitions, event continuity, semantic index persistence,
entity/time filters, and withholding tentative speech from durable state.
External model calls and browser media require separate live verification.

The [implementation plan](../docs/MEMORY_GENERATION_PLAN.md) defines the acceptance
bar. Files are separated by responsibility: contracts, transcript selection,
interpreter adapters, packet pipeline, storage/embeddings, HTTP transport and client.
