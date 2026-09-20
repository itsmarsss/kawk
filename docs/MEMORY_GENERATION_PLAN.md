# KAWK continuous memory generation

Status: implementation plan, 2026-09-19. This implements William's current goal;
it supersedes the older Python fixed-handler architecture for this new service.
The existing perception lab stays available. Work remains on `chud3`.

## Scope

Build a TypeScript service that continuously joins camera, face identities and
speech into evidence packets, interprets them with OpenAI, and develops persistent
state and memories. It must support later retrieval of keys' last location, class
notes by time span, and encounters/conversation context for an enrolled person.
Retrieval returns evidence; an answering agent and Jev-triggered captures/actions
are explicitly deferred.

## Stack and boundaries

- Node 22+, TypeScript, Express and WebSocket. One service, no broker or orchestration framework.
- SQLite with WAL, `better-sqlite3`, and `sqlite-vec`: transactional records and
  a local vector index in the same database. Source JPEGs live alongside it.
- Local MiniLM sentence embeddings through Transformers.js; embeddings are real
  semantic vectors, not hashes or keyword stand-ins. Pin the model/dimension in DB.
- OpenAI vision and structured memory updates behind small interfaces. Default
  R&D provider: the already authorized signed-in Codex CLI, Terra, no reasoning,
  isolated read-only calls with no tools. This is an R&D transport, not a claim
  about API throughput. A normal OpenAI Responses adapter can use a configured key/model.
- Reuse existing Python InsightFace/gallery and Baseten Whisper as perception
  services. The new packet, state, persistence, retrieval and scheduling code is TS.
- A primitive dark browser testing page, authored using Claude Code Fable 5.1,
  uses the Mac camera/mic, shows face boxes/names, current state, packets, memory
  history, semantic search, errors and measured latency. No speculative actions.

## Evidence contract and cadence

1. Start creates a session and captures a JPEG every 5,000 ms on an anchored timer,
   independently of inference completion. Stop releases camera/mic and flushes speech.
2. Face perception continues around 5 fps because the existing stabilizer expires
   tracks after one second. A scheduled image and its face-sized derivative must
   come from the same canvas draw. The selected face reply retains the frame ID,
   capture time, exact dimensions and stable gallery IDs. Never use a nearby reply.
3. Speech is a revision ledger keyed by session + connection + segment. Map cloud
   word offsets to the first PCM actually sent, preserving approximate source time,
   receipt time, finality and unknown speaker. Reconnect starts a fresh namespace.
4. Each packet freezes its image, matching face evidence, and last N words
   (default 200, configurable) whose source times precede capture. All three slots
   carry status; missing audio/faces is explicit, never silently replaced by stale data.
5. Vision produces a thorough factual description, useful details, legible text and
   uncertainty. Persist the joined packet immediately with that description, faces
   and transcript, before requesting its memory update. An unchanged retry reuses
   the immutable prepared version; changed final speech creates another version.
6. A memory-update call receives the packet, current state, active entities and
   semantically retrieved past candidates. It proposes typed changes referencing
   evidence and existing IDs. TypeScript validates and commits them.

Capture cadence is distinct from completion latency. Vision requests may overlap
(bounded concurrency 4 by default); state updates commit in capture order. Up to
four consecutive ready packets can share one memory-update request, retaining
their separate timestamps, transcript eligibility and state history. Explicit
backward references preserve an entity introduced earlier in that batch. The
whole batch commits atomically; changed final speech invalidates the whole batch.
Corrections to already committed packets use the individual update path. A refreshed
draft can still share a batch for its first successful commit. No delay is added
to wait for a batch. Durable pending
packets survive restart. Queue and disk limits are explicit; saturation is visible
and a rejected capture is recorded as a gap, not called successfully remembered.
Expose capture-to-packet, model, queue, commit and vector-index latency.

## Identity, state and history

- One evolving current-state record, with versioned transitions and source times.
  Moving from a room to a corridor updates this record and preserves the room history.
  Missing/blurred images alone do not establish departure. Model state is a complete
  snapshot: it repeats supported unchanged values, and null explicitly clears an
  unsupported location/activity. Storage never silently carries an ended activity.
- Entities have durable IDs and kinds: person, object, place, event. Gallery UUID
  determines enrolled-person identity; mutable names never create a second person.
- The model references existing object/event IDs supplied in context. New entities
  require distinctive descriptions; similar labels or vector proximity alone cannot
  merge two physical objects. Ambiguous identity remains explicit.
- Object attributes/locations accumulate evidence-backed versions. Current last-seen
  fields are projections; older late evidence cannot rewind newer fields. Prior
  notes are retained rather than replaced with each summary.
- Events have start/end times and linked observations/transcripts. An ongoing class
  reuses its event ID and adds notes; a later class is a separate occurrence.
- Person presence produces encounters. Transcript during an encounter is conversation
  context, not verified speech by that person. Only explicit verified speaker evidence
  can support that attribution; the existing Whisper stream has none.
- Overlapping last-N-word windows are context, not repeated new speech. Persistent
  claims may depend only on final transcripts. Packets retain partial words, but the
  memory-update model receives only their pending status until finalization.
- Late finals/corrections attach to the original capture interval and trigger an
  explicit packet revision. Superseded dependent claims are excluded from active
  retrieval; history retains original versions. Historical corrections cannot rewind
  present physical state or bind speech to the newly visible person.
- Every committed packet's consumed final revisions conservatively support its
  state, event and entity-metadata projections, even when it inserted no new note.
  A correction invalidates those projections immediately and queues their consumers
  for repair. The current source-time cursor stays in place with an explicit pending
  interpretation. Entity descriptions rebuild from valid versioned metadata, while
  gallery identity and visual sightings remain intact. Repeating an unchanged
  description does not give its original claim new provenance.

## Storage and retrieval

Tables: sessions, captures/packet versions, transcript revisions, entities,
observations with evidence/dependencies, state history/current state, event and
encounter intervals, and an embedding outbox. Unique IDs make retries idempotent.
Commit observations and index jobs together; embedding failures do not lose memories.
Index atomic notes and scene/event observations, retaining entity/time/source links.
Search supports semantic query plus entity and time filters, returns source images,
transcript excerpts, uncertainty and supersession state. Entity and event detail
endpoints expose full history for the future independent retrieval agent.

## Implementation order and ownership

1. Freeze runtime-validated TS contracts, storage interface and HTTP/client contract.
2. Implement database/projections/vector outbox and test history/identity invariants.
3. Implement OpenAI observation/update adapters and bounded packet scheduler.
4. Wire real face/Whisper transport, capture timing and revision handling.
5. Have Claude build the testing page against the agreed endpoints.
6. Run offline integration/restart/noise tests, real embeddings, then bounded real
   OpenAI image calls and browser capture. Measure results; repair observed failures.

## Acceptance evidence

| Requirement | Evidence required |
|---|---|
| Continuous five-second capture | Fake-clock cadence test plus real browser packet timestamps |
| Same-image face IDs | Frame binding/geometry rejection tests and real face reply |
| Last N words and revisions | Window boundary, overlap, delayed-final and reconnect tests |
| OpenAI visual interpretation | A real source JPEG and saved validated model output/latency |
| Evolving state | Room → corridor → room history, with one current state and no erased notes |
| Stable people/objects/events | Re-encounter/rename, keys relocation, ongoing class tests |
| Persistent semantic memory | Restart, real embedding search, entity/time filtered retrieval |
| Recoverable processing | Crash/restart, duplicate capture, out-of-order/failed model and index tests |
| Noise handling | Unknown/occluded face, ambiguous object, partial correction, unknown-speaker tests |
| Usable live flow | Camera/mic start/stop, current state, face boxes, transcript and memory inspection |
| Scope | No Jev intervention or autonomous answering agent added |

## Limits to make visible

Five-second photos can miss a brief action. Captions remain model interpretations
linked to original images. Face identity is enrolled-gallery matching, not general
identity recognition. Speech timing is approximate and speakers are unverified.
No promise of five-second *completion* until measured with the complete prompts.
Keep capture and latency failures visible rather than silently fabricating coverage.

## Implementation references

- [OpenAI Codex SDK](https://learn.chatgpt.com/docs/codex-sdk)
- [sqlite-vec JavaScript integration](https://alexgarcia.xyz/sqlite-vec/js.html)
- [Transformers.js feature extraction](https://huggingface.co/docs/transformers.js/api/pipelines#module_pipelines.FeatureExtractionPipeline)
