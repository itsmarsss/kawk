# Memory generation verification — 2026-09-19

> September 20: the main application now uses direct OpenAI image notes followed
> by a simple AI memory update. See [current simple-path verification](MEMORY_SIMPLE_VERIFICATION.md).
> The formats, live-server selections and measurements below describe earlier R&D
> runs; they remain evidence for those configurations, not the current default.

The TypeScript memory service is implemented and the bounded integration tests
pass. **The current Terra route does not sustain one completed memory update
every five seconds.** Capture timing works; model processing falls behind. This
is a remaining performance requirement, not a successful five-second result.

Run `make memory-dev`, then open http://localhost:8082. The existing Python
perception lab must be available on port 8081. The new page is passive until
Start; Stop flushes speech and submits a final matching snapshot. No answering
agent or Jev intervention is included.

## What passed

| Requirement | Evidence and limits |
|---|---|
| Five-second capture | Browser capture gaps 5,003 / 5,001 ms; six-photo real-model replay gaps 4,998–5,002 ms. Browser media were synthetic, with actual browser media APIs. |
| Exact photo/face binding | Scheduled image and derivative share a canvas capture; stale replies, incorrect geometry and old socket epochs are rejected. A delayed pre-Stop reply cannot identify the final snapshot. |
| Speech source time/finality | Revision, reconnect, dropped-chunk timing, final-only claims and Stop-tail coverage tests. Real Baseten Whisper produced a final transcript from a recorded fixture. Speaker identity remains unknown. |
| Persistent state/history | Room exit/return, moved keys, separate same-label objects, stable gallery UUID/rename and ongoing/ended event tests. Historical corrections cannot rewind current location. |
| Historical repairs | Retried old photos recover historical encounters. Corrected person references are version-scoped. Event endings remain ended, with contradictory later evidence exposed as conflicts. |
| Correction projections | Every committed consumer of corrected final speech is queued, including state-only and deduplicated event updates. Invalid summaries disappear immediately; versioned entity descriptions rebuild without losing gallery names/IDs or visual timestamps. |
| Durable prepared evidence | Joined packets persist before the memory call. Failure/reopen/retry preserves the exact prepared version. Changed finals retain the old draft and create another version; a first successful commit at version 2 still creates encounters. |
| Atomic batching | Up to four ordered packets share one call but retain separate evidence and timestamps. Backward entity references and whole-batch rollback are tested. Changed final speech requeues the entire in-flight batch. |
| Real model integration | Recorded audio → Whisper → transcript ledger; source photo → local InsightFace → Terra observation/update → SQLite → real MiniLM semantic search. One real HTTP run saved 23 observations. |
| Raw conversation coverage | Current Store retained and indexed the full actual Whisper final even with an empty model delta. A labeled synthetic correction removed stale active vectors. Corrected text ranked first after database restart. |
| Person/class/object scenario | One real Terra batch over four explicitly synthetic evidence packets passed 18 checks: Bob re-encounter, room exit/return, keys relocation, class continuity/ending, unknown speakers and withheld partials. Real MiniLM indexed 48 notes; person/class/keys queries with entity/time filters retrieved expected evidence first, unchanged after restart. |
| Browser operation | Start/Stop, same-frame faces, partial/final speech, evidence/history expansion, search, 390px layout and media cleanup pass using synthetic devices/mocked services. No browser/asset errors. |
| Explicit state clearing | A completed state snapshot can clear an ended activity or uncertain location. Null no longer silently revives the previous value; source-time history and older-correction protection remain. |
| Source-reference option | A mechanical decoder restores exact source text/IDs and then runs canonical validation. Unknown/forward references, nonfinal speech, identity mix-ups, null whole states and ambiguous attribute owners are rejected. Canonical remains the code default; the running R&D server explicitly selects source format. |
| Event-ending retrieval | A final-backed event summary is indexed even alongside unrelated pending speech, cites only final keys, and disappears after correction. Partial-only unsourced summaries remain excluded. |
| Same-image text evidence | Optional native Apple Vision reader binds exact image bytes/hash, frame ID and time, retains engine revision/boxes/candidates/scores, and fails explicitly without dropping the photo. Host metadata is excluded from the model output schema. Raw model/native readings and source-format `o#` claims remain uncertain. Candidate attributes remain in history without replacing supported values. |
| Bounded batching wait | Optional 0–5000 ms wait counts from first readiness, only for an adjacent capture already being interpreted. Tests cover deadlines, ordering, corrections, restart and default-zero behavior. No throughput improvement has been measured. |
| Physical-object identity | Existing-object updates require current visual evidence and earlier intrinsic anchors. Generic appearance, configuration alone, missing markers, conflicting details and competing identities remain candidate sightings. Candidate links are searchable without updating canonical metadata/location/last-seen. Corrections and backward batch references cannot bypass the gate. |
| Citation repair | A wrong source index resolves only to one uniquely matching exact quote in the same frame. The resolved index is persisted without altering provider output. The untouched failed three-photo response then passed an offline Store/search/restart regression; this was not new inference. |
| Candidate UI | Real application server and isolated SQLite fixture verified candidate labels in history and filtered/unfiltered search. Desktop and 390px layout remained dark; zero browser errors, device calls or provider calls. |
| Same-image person identity | Nine Store regressions cover absent/wrong gallery faces, anonymous stream/track namespaces, backward caption reuse, mixed speech/image guesses and corrections. Unsupported visual person references remain searchable candidates without canonical metadata/location/last-seen changes. Final speech keeps original source times without implying a physical sighting. |
| Separate writer configuration | Codex and Responses adapter tests verify image/text routing, default inheritance, explicit overrides and actual-model telemetry. The default remains Terra for both operations. |
| Parallel visual structure | Optional binding mode retains an immutable image-only entity/fact draft. Exact face slots bind mechanically; sparse writer overrides connect old entities and add final speech/state/events. Invalid sources, face/body association, forward aliases and anchor ownership reject. Expanded storage bounds preserve all valid provider facts and references. |
| Descriptor coverage | Offline replay of the three original real-photo responses adds the two missing seated-person histories without new model calls or changed source output. Both uncertain full-source descriptors retrieve by entity/time with real MiniLM after restart; 52 notes retained. |
| Committed-image correction | Seven regressions cover a transcript correction after version 1 already committed: the same anonymous person/place IDs, labels, descriptions and visual history survive; objects retain their existing gate. Changed image/draft/identity rejects transactionally. Supplemental aliases and legacy packets do not gain implicit identity reuse. |
| Retrieved-context correction | A corrected final transcript invalidates an in-flight update that consumed it through retrieved context, even outside the packet's direct word window. Entire batches requeue; ordinary new finals and partials do not continually cancel work. |
| Build/regression | 251 backend tests and production TypeScript/build pass after nested descriptions, state source copying, target-relative anchors, descriptor-confidence preservation and candidate-anchor resolution. The unchanged client has 44 previously passing tests and a passing strict TypeScript check. A process-timeout fixture allows two seconds for startup under the parallel suite; timeout and private-image cleanup assertions remain. Claude Fable implemented the earlier model label; eight passive desktop/mobile browser cases verified missing/equal/different writer settings without media or model calls. Previously validated unchanged Python suite: 432 pass, two dependency deprecation warnings. |

The initial real face smoke used a back-view photo and detected zero faces. A later
isolated positive test exercised actual enrollment, stabilized recognition in two
fresh streams, an empty-frame negative, the production proxy/binding/pipeline,
and persisted gallery UUID/encounters. It used the same derived public photograph
for enrollment and matching, so **casual-conversation/viewpoint accuracy is still
not established**. Vision, memory writing and vectors were deterministic fixtures.
The live gallery was untouched. The original runner timed out after an incorrect
history-row assertion and cleanup bug; a separate audit passed 13 checks on the
saved frames and database, including reopening a copy. The failed artifact remains
unchanged, and no extra inference was used. These tests are not a live Mac
conversation with all real services running together.

## Measurements

Host: Apple M5 Pro, 48 GiB memory, Node 22.21.1. OpenAI calls used signed-in
Codex CLI 0.155.1, `gpt-5.6-terra`, reasoning disabled. These times include local
process startup, network, remote generation and output validation; they are not
isolated GPU inference times. Input photos were approximately 2 MP, including
1224×1632 portrait images. Face derivatives were 480×640 in the HTTP smoke.

| Measurement | Result | Sample/context |
|---|---:|---|
| Terra observation | 13.52 s | First isolated source photo |
| Terra memory update | 11.77 s | Same photo, separate call |
| Full HTTP capture → memory | 30.22 s | One photo plus recorded speech |
| Local face inference | 44.3 ms | Real model, zero faces |
| Local positive-face fixture | 168.9 ms first; 40.3 ms warm median | 11 actual calls, warm n=10, CoreML; same photograph reused, not independent-view accuracy |
| Fresh-stream stable face identity | 262.4 / 255.9 ms | First JPEG send to stable reply, including two samples and pacing; two streams, same enrolled fixture |
| Whisper connection | 2.42 s | Warm deployment; cold model load was about 382 s |
| Index 20 observations | 45.7 ms | Latest current-store replay; real local embeddings and SQLite |
| Six-photo Terra observation range | 13.29–18.11 s | Four bounded workers |
| Batch of three updates | 26.02 s | 1,174 output tokens |
| Batch of two updates | 21.82 s | 857 output tokens |
| Compact-prompt batch of four | 26.69 s | 1,177 output tokens; isolated experiment, not adopted |
| Six-photo capture → memory | 35.52–63.56 s | Backlog grew; all six eventually committed |
| Synthetic scenario, canonical batch of four | 33.31 s | 1,632 output tokens; all 18 scenario checks passed, but throughput insufficient |
| Source-reference synthetic batch of four | 11.00 s | 394 output tokens; full states, known keys/person/class details retained |
| Twelve-photo source-format capture → memory | 16.70–42.05 s | Median 30.46 s; all 12 committed, 220 notes indexed |
| Twelve-photo serial memory service | 6.86 s per packet | Seven calls; still slower than five-second input |
| OCR-assisted Terra observation | 9.93 / 10.99 s | Two targeted real photos; native reader 233 / 236 ms; no memory-update calls |
| Object-aware canonical scenario, four packets | 45.47 s | 2,281 output tokens; 18 checks, three real semantic searches and restart passed |
| Same scenario, source-reference format | 22.50 s | 1,003 output tokens; same acceptance checks/searches/restart passed; 5.63 s/packet including commit |
| Same scenario, compact object evidence | 19.59 s including commit | 754 output tokens; same 18 checks/searches/restart passed; 4.90 s/packet in this one batch |
| Twelve-packet writer replay, compact format | 10.09 s of ordered reducer work per packet | Five real memory calls; all 12 saved and 260 notes indexed; zero new vision calls |
| Luna writer, exact three-photo input/context | 23.40 s | 1,127 output tokens; Terra previously 32.70 s / 1,637 tokens. Still 7.80 s per packet. |
| Luna writer, exact four-packet keys/Bob/class scenario | 21.40 s | 893 output tokens; Terra previously 19.58 s / 754 tokens. Still above the 20 s arrival budget. |
| Terra structured image observations | 25.29 / 26.95 s | Two real photos; 1,149 / 1,210 output tokens; complete descriptions plus image-only structure and native OCR |
| Terra full binding lists | 13.34 s for two packets | 466 output tokens; all storage/search/restart checks passed, but two people initially lacked linked notes |
| Terra sparse binding | 10.65 s for the same two packets | 263 output tokens; all 52 notes retained, including uncertain person descriptors. 5.33 s per packet remains borderline; one sample cannot establish continuous capacity. |

The six-photo replay saved 133 searchable observations with no pending index
jobs and preserved six source-time state versions. It verifies recovery and
short-run integration, **not sustained five-second throughput**. A batch of
three must average below 15 seconds to keep up with five-second input; this run
did not. The 120-capture queue is bounded, rejects overflow visibly, and records
gaps. It cannot compensate for an indefinitely slower model.

The compact prompt retained some structural links but weakened distinguishing
descriptions and propagated an uncertain room label. It was not promoted. Its
output also exposed an ambiguous multi-entity location assignment; the host now
retains such relationship text while refusing to assign that attribute to every
linked entity. Structured attributes need one unambiguous target.

The source-format replay used a different sequence, so it is not a controlled
speedup comparison with the six-photo canonical run. Its raw benchmark report
retains a timing-count assertion failure: the runner inspected only the last 30
dashboard timing events. All 12 captures had committed. A separate analysis
reconstructs all 12 exact memory timings from saved snapshots without new model
calls. The reporting bug is fixed in the runner.

Manual review of all 12 source images found real quality gaps: misread room signs,
a fabricated closure notice, and reuse of a door entity across visually different
doors. Source copying retains these upstream mistakes. Although uncertainty is
saved, some uncertain OCR became an observed claim in that recorded run. New
raw readings and explicit `o#` claims now have an enforced uncertain confidence,
and uncertain attributes do not replace supported entity attributes. The original
benchmark database is retained unchanged. This is not a complete exact-place
identity gate: freeform state, entity names and visual paraphrases can still carry
misread text; the canonical `visual` boolean does not identify a particular reading.
The optional source format has not been enabled by default. Sustained throughput
and precise provenance for all derived claims remain open. Physical-object reuse
now has a conservative mechanical gate, but whether an intrinsic detail actually
matches is still a model inference.

The new object-aware canonical scenario retained 52 observations, and its source
format counterpart retained 44, with raw inputs preserved in both. Both passed
all 18 structural/use-case checks, the keys/Bob/class semantic queries, and exact
database/search persistence after restart. They used explicitly synthetic captions,
gallery IDs and speech with real Terra/SQLite/MiniLM; they do not measure live face
accuracy. One paired workload is not a latency distribution. The source format
still exceeded the 20-second capacity budget for four five-second captures.

Compacting only the provider's object-evidence references then reduced that same
scenario to 754 output tokens and 19.59 seconds including commit. The host expands
source/anchor aliases to the unchanged readable canonical contracts, preserving
owner, timestamp, conflict and exact-quote checks. The result retained 45 notes
and passed all the same checks. Its 0.41-second margin is too small to infer
sustained performance from one call. Compact intrinsic quotes must match the
selected source; unlike canonical citations, the decoder does not repair a wrong
source alias by searching elsewhere.

The subsequent paced writer replay **failed the throughput target** despite saving
all 12 packets without errors or retries. It reused the original 12 photo captions
and recorded vision-readiness times; faces and audio remained explicitly unavailable.
Five real memory calls processed batches of 1/1/3/4/3 in 11.65/14.98/32.70/29.95/31.32
seconds. Ordered reducer work totaled 121.06 seconds (10.09 seconds per packet).
Capture-to-memory lag grew from 20.91 to 75.30 seconds, peaked at 85.30 seconds,
and had median 61.34 seconds. The largest pending queue was 10. All 260 observations
were indexed; 33 entities were created. These counts are not an accuracy score.
No caption quality was improved or independently re-evaluated in this replay.
The original source/database hashes and tested production code remained unchanged.
This establishes successful bounded processing and a real capacity deficit, not
sustained five-second end-to-end operation.

The two-call Luna comparison did not establish a suitable replacement. Both exact
effective inputs passed their existing automated storage, search and restart checks,
but neither met its arrival budget. Luna was faster on the three-photo input and
slower on the four-packet scenario. Manual review also found omitted intrinsic
object evidence and motion language inferred from stills. The host preserved
uncertainty and prevented unsupported old-object updates; that is not a complete
semantic-quality pass. Original inputs/databases and production sources remained
unchanged during the comparison. The running model choice remains Terra/Terra.

Two real-photo door calls exposed strict-validation failures: a source-less fact
(32.75 s) and then a wrong visual source index (25.58 s). Their rejected outputs
and databases remain unchanged. The prompt now distinguishes visual source from
confidence, and the unique exact-quote resolver fixes the observed index error.
A separate offline replay of the second response committed all three packets,
kept the doors separate, and passed real vector search/restart with original file
hashes unchanged. No new model call was made for that repair regression.

Native OCR is a fallible aid, not an independent confirmation of Terra: the
candidates are supplied to Terra before it describes the image. A real local room
sign test read “Room 4A - The” and “Grasslands” in about 475 ms including adapter
startup/temp I/O/cleanup. The earlier 12-image OCR-only loop took 25–216 ms per
image inside one native process; those are different timing boundaries. A separate
small sign had a wrong character despite a confidence score of 1.0. No score is
treated as verification.

Exactly two subsequent OCR-assisted Terra calls on the bad sign/notice images
corrected “Room 4A – The Grasslands” and removed the fabricated closure notice by
abstaining. They did not successfully read the blurry notice. An incomplete room
code was copied with uncertainty, and unrelated hand-laterality/bag errors remain.
These are targeted quality improvements, not a general accuracy, downstream memory
quality or throughput result. All raw prompts/results are saved; the original
replay database hash was unchanged. The local test server was restarted with
`MEMORY_TEXT_READER=native`. After the final tests it was restarted again with
`MEMORY_UPDATE_FORMAT=source` for the faster experimental path; batching wait remains
zero. The source-code defaults remain canonical format and OCR off. The Chrome
testing page was reloaded with no errors, no active session and an empty queue.

After the person-identity and model-routing changes, the service was rebuilt and
restarted again with the same source-format/native-OCR settings and Terra for both
image interpretation and memory writing. The Chrome Polymarket profile shows the
new testing page, Start enabled, Stop disabled, no errors and an empty queue.
No camera or microphone was started during this final page check.

## Binding acceptance before nested descriptions

This iteration made concrete progress; the goal remains incomplete. The optional
binding route is **not promoted** to the live server. The first full run committed
1/12 photos. Generation-only schemas now enforce single-owner attributes and
place/object field compatibility, while an exact unique-quote resolver fixes
wrong anchor source indexes without changing the quoted text. The second full
run retained all 12 prepared visual packets and committed 6/12, with 179 indexed
notes. Nineteen actual calls reconcile with nineteen raw artifacts; no retries.

The successful subset reached memory in 26.00–54.35 seconds (median 46.56).
Writer work cost 7.016 seconds per attempted packet, including rejected batches.
Failures censor the latency slope and queue drainage; neither is evidence of
sustained five-second capacity. All original JPEGs and prepared packets survive,
but failed updates are not yet searchable memories.

Two writer calls cited a current anchor where the image draft had none. Another
bound an object to a prior person; it also contained duplicate reuse targets.
Strict validation rejected those associations. Manual review additionally found
wrong entity-to-description source indexes in a committed frame, and a shirt logo
proposed as a phone's identity anchor in a failed frame. Exact quotation proves
text provenance, not physical ownership. These are remaining quality defects.

The synthetic four-packet person/keys/class scenario now passes all 24 checks,
three real MiniLM queries and restart, but takes 20.47 seconds and does not test
image understanding or real face/speech accuracy. It cannot override the real
photo failures. Next work must address same-kind targets, valid current anchors,
duplicate identity reuse and semantic source ownership, then remeasure complete
coverage and capacity. Do not weaken the acceptance criteria or discard failures.

The rebuilt live server still uses Terra/Terra, source format, native OCR, four
vision workers and zero batch wait on port 8082. Its idle queue and empty database
were verified before restart; no camera/microphone was activated. The experimental
binding mode remains available only as an explicit R&D configuration.

## Latest nested-description and state-copy audit

Image output now nests each entity's description, location and anchors together;
the host assigns its source indexes. Location attributes may paraphrase their
own description, while identity anchors still need exact quotes from their own
entity. The four-photo probe's raw responses fixed the targeted phone/shirt and
bin/table source-owner errors. An initial overly strict literal-location check
rejected all four; the failed run is preserved. Revalidation of those same raw
responses made no new vision call and is reported separately.

Two fresh state-copy writer calls then committed all four revalidated packets in
7.22 and 9.33 seconds (4.14 seconds per packet). All 215 notes indexed. The original
harness incorrectly treated ten candidate sightings without canonical references
as lost entities. A separate offline audit retained that failure and proved all
63 declarations have canonical or candidate history, with real entity/time
retrieval and exact restart. Known image errors include hand laterality, some
clothing/details and grouped items; source copying does not fix them.

The identical four-packet synthetic keys/Bob/class case passed all 24 checks,
three MiniLM queries and restart in one 13.10-second writer call. All four state
summaries copied their own scenes; speech/event facts and ending still persisted.
This did not exercise a generated speech-summary override or actual perception.

The fresh full paced v3 run still failed integration: 12/12 image interpretations,
8/12 committed packets, 372 indexed notes, and four prepared packets without
searchable notes. Exactly 21 calls ran, with no retries. Median image service was
27.88 seconds; successful capture-to-memory median was 33.85 seconds (21.31–40.80).
Writer service totaled 54.71 seconds, or 4.56 seconds per attempted packet, but
failed packets censor capacity measurements. The peak pending queue was eight.
All bytes, packet versions, restart, saved-subset search and index-drain checks
passed. Neither queue drainage nor this incomplete run proves sustained capacity.

One writer cited another object's anchor; another cited a non-earlier anchor.
The next bounded change removes this redundant model-selected owner/time reference
by making the anchor index relative to the already selected target. Existing
identity/uncertainty gates stay strict. No live promotion has occurred: the server
still explicitly uses source format and Terra/Terra. The full goal is unfinished.

## Target-relative anchor acceptance (v4)

The full twelve-photo replay now commits 12/12, indexes all 593 observations and
passes exact source coverage, byte hashes, packet versions, database reopening and
semantic-search equality. Twenty actual calls ran (12 image, eight writer), with
no failures or retries. All writer inputs and decoded outputs were retained.
Backend regression count after the target-relative change is 242 passing tests;
TypeScript and the production build pass.

Image interpretation median was 28.39 seconds. Capture-to-memory latency across
all 12 captures was 20.05–54.05 seconds (median 44.57). Writer service totaled
62.41 seconds, or 5.20 seconds per photo. Pending work peaked at nine; the last
memory committed 40.08 seconds after the last capture. This short burst does not
establish sustained five-second capacity, despite complete successful storage.

Independent review found no false canonical physical-object merge: all 23 reuse
attempts remained uncertain candidates. That is conservative identity handling,
not confirmed same-object tracking. Some useful portable items remain omitted or
imprecisely described. Place matching conflates walls/floors with their containing
space. One uncertain entity descriptor is also copied into raw memory as observed;
this concrete confidence-provenance bug is being corrected separately. Faces and
speech were unavailable, so this run does not test recognition or live conversation.

The descriptor-copy confidence bug is now fixed at the shared visual-source
boundary. Four focused persistence/vector-retrieval regressions cover uncertain
raw and linked copies, identical-text deduplication, uncertain location attributes
and unchanged legacy defaults. All 246 backend tests and the production build pass.
Old benchmark records remain untouched. Image/binding prompts now distinguish
containing places from structural surfaces; that remains model guidance, not a
deterministic semantic identity gate.

Original results and the independent latency/semantic reviews remain under
`outputs/memory-binding-cadence-v4-20260919/` in the R&D workspace. No live promotion
has occurred. A bounded batching-wait experiment is planned; it must preserve all
source evidence and report complete coverage separately from capacity.

## Longer batching-wait probe (v5)

This run cycled the same twelve JPEGs twice at five-second source intervals,
with eight vision workers and a five-second maximum readiness wait for batches.
It failed integration and capacity: 24 image requests plus seven writer requests,
no retries, 12/24 captures committed. All source images were retained exactly;
19 joined packets were prepared. Five image requests timed out at 90 seconds,
three packets failed duplicate visual-identity validation, and four more passed
model decoding but failed Store commit with `unknown_anchor`. Model success must
not be counted as a successful database transaction.

The failed anchor lookup is a compatibility bug: an earlier candidate sighting
has valid image evidence but intentionally lacks canonical identity anchors.
A later batch row can cite that earlier draft anchor; Store currently looks only
in canonical anchors. The bounded correction resolves exact candidate-sighting
provenance separately and preserves uncertainty. Conflicting duplicate identities
remain rejected rather than guessed.

Image service averaged 40.67 seconds across all 24 attempts, including timeouts.
The serial writer consumed 108.80 seconds for the 19 packets that reached it,
or 5.73 seconds per attempted packet. Successful-only capture-to-memory median
was 94.93 seconds (12 results); the other twelve are failures, not zero-latency
samples. Pending work peaked at 17. No sustained-capacity or batching-speedup
claim is supported. Provider-timeout partial output was not retained by the
existing adapter, so the point at which those five requests stalled is unknown.

All 608 retained observations indexed, and exact byte/hash, source-time, database
restart and search checks passed for retained data. Explicitly uncertain descriptor
copies now remain uncertain. Place prompts stopped wall/floor-to-corridor merges
in this sample and some corridor reuse worked, but duplicate place records and
new caption errors remain. Faces/audio were unavailable; repeating twelve stills
does not establish natural movement or conversation accuracy. The live page remains
on its existing source-format Terra configuration. No new Baseten compute was used.

The candidate-anchor bug is now fixed: exact committed candidate citations are
validated against their original source, owner, index and earlier time. They remain
uncertain and cannot add canonical anchors or update a canonical object's location.
All 251 backend tests and the build pass. An independent review found no blocker.
An offline replay of the unchanged four-packet writer05 output passed 16 checks,
real MiniLM retrieval and exact restart. A separate five-check audit verified that
this historical replay did not rewind the later current state in its isolated clone.
It used the terminal V5 database, not the original pre-writer database, and made
zero model calls. The failed first R&D harness attempt is retained separately.

After verification, the idle live service was rebuilt and restarted on port 8082
with its existing source format, native OCR, Terra for both stages, four vision
workers and zero batching wait. Health/config and an empty queue/database were
checked; no camera or microphone was started. Binding/V5 settings remain unpromoted.
Timeouts, conflicting model identity proposals and full continuous capacity remain
unresolved. The offline storage fix does not change the original V5 outcome.

Full original results and independent reviews are under
`outputs/memory-binding-cadence-v5-20260919/` in the R&D workspace. The full goal
remains incomplete; neither this failed run nor a future offline decoder repair
can be represented as new successful inference.

## Relevant context and bounded recovery (2026-09-19)

The writer now combines recent/current-scene continuity, ongoing events, exact
same-image identities, original final-speech partners, and semantic retrieval over
all observations and final segments. Relevant older canonical and candidate entities
are hydrated with their full metadata/anchors. Anonymous people are removed only
from unsolicited recency fallback. Stored notes/evidence remain unchanged.

Two twelve-packet writer-only runs replayed V4 descriptions and image readiness
times while making real Terra writer calls and using real MiniLM indexing. Both
saved all 12 packets/593 observations and passed all nine integration checks.
No-wait: nine calls, 5.501 writer seconds per photo, memory median 41.002 seconds.
Five-second wait: seven calls, 4.970 writer seconds per photo, memory median
46.771 seconds. Same-state prompt comparisons were 17.9% and 11.2% smaller than the
old selector. Extra benchmark comparisons cost 526/491 ms. These are component
replays with different batch boundaries, no fresh image/OCR calls, unavailable
faces/audio, and no controlled proof of latency improvement or sustained capacity.

The interpreter now supports one or two attempts per operation. The live server
selects two; standalone experiments default to one. A retry retains original image
bytes, native OCR, packet/context and source times, adds only host error-code feedback,
and must pass unchanged validation. Every attempt is measured separately. Transient
provider failures and invalid outputs may retry; auth/permanent HTTP errors, refusal,
tools, oversized output and integrity failures may not. Second failures remain
explicit. Interrupted operations can repeat across restart, so this is not a durable
lifetime billing cap.

All **262 backend tests** and the build passed. New tests include a final transcript
correction arriving during the second attempt: the stale valid result is discarded
before storage and the corrected source is interpreted again.

A bounded live regression replayed the original V5 writer03 duplicate-identity
response unchanged, verified its rejection, then made exactly one fresh Terra
writer call. That request took 11.738 seconds, returned a valid three-packet batch,
and added/indexed 154 observations in an isolated terminal-V5 database clone.
All 13 persistence/source/retrieval/restart checks passed; later current state
was not rewound and original files remained unchanged. Three object matches stayed
candidates; 25 new sightings were created after conflicting reuse proposals were
omitted. This prevents memory loss but does not establish correct canonical reuse.
The original V5 remains failed. The image timeout problem and full continuous
capacity are still unresolved; the overall goal remains incomplete.

After these checks, the idle 8082 service was restarted with the verified context
and recovery changes. Its existing source format, native OCR, Terra for both stages,
four image workers, four-packet maximum and zero batching wait were retained;
the new two-attempt setting was explicit. Health/config and empty queue/database
were rechecked. No camera/microphone was activated; binding remains experimental.

## Fresh complete pipeline and close-view regression (V6)

The next complete real visual run committed **24/24 captures** and indexed all
**1,270 observations**. All nine integration/source/cadence/restart/search checks
passed. It made 24 fresh Terra image calls and nine fresh writer calls; two attempts
were permitted, but no failure or retry occurred. Twelve 1224×1632 photos were cycled
twice at five-second intervals, with real native OCR and MiniLM, eight image workers,
four-packet writer batches, a five-second batching wait, and binding format. Faces
and speech were unavailable. The actual process exited zero; production source
hashes stayed unchanged. Live data and deployments were untouched by the benchmark.

Image total median was **32.024 seconds**, including median startup 86.9 ms and
median model interval 29.395 seconds (component medians are not additive). Writer
service averaged **5.820 seconds per photo**. Capture-to-memory median was
**61.762 seconds**, range 34.229–76.610, across all 24 successful arrivals. Pending
work peaked at 15 and drained 63.558 seconds after the final input. First/second
cycle medians were 56.186/62.443 seconds. This is complete bounded integration,
not sustained five-second capacity; the serial writer remains slower than arrivals.
No actual timeout recovery was exercised because all requests succeeded first try.

Manual review found 169 new, 87 candidate and five mechanically supported object
sightings. Bag/laptop/bin links were plausible in this sample; a door match based
on a shared yellow-and-white notice was too generic to consider verified identity.
Grouped objects, omitted handheld details and imprecise material/hand-side claims
remain. Two cropped table photos incorrectly became a small workroom and changed
location; repeated images produced additional room entities.

The image and writer prompts now distinguish a close view from evidence of a new
enclosed space. A bounded probe made two fresh image calls and one writer call on
the exact close table photos using V6's original preceding corridor context. Both
images omitted invented place entities, and both updates retained `indoor corridor`
with explicit uncertainty about unseen layout. Image calls took 26.479/30.636 seconds;
writer 9.225 seconds; process exited zero. No probe data entered the live database.
Some small items remained omitted, so only the targeted location fix is verified.
Original V6 output remains unchanged. All 262 backend tests and the build passed.

The idle live server was rebuilt/restarted with the prompt correction, retaining
source format, native OCR, Terra for both stages, four image workers, zero batching
wait and two attempts. Health/config and zero sessions/captures/queue were verified
afterward. Experimental binding settings and benchmark data remain isolated.

The full goal remains incomplete: sustained processing capacity, representative
natural camera/microphone validation, and reliable physical-object continuity
are still not established. Jev and a separate answering agent remain deferred.

## Reproducible artifacts

R&D outputs are deliberately outside the source repository and contain the
user-provided photos and isolated experiment databases:

- `/Users/polyuser/Documents/Codex/2026-09-18/my/outputs/memory-generation-live-20260919/http-smoke.json`
- `/Users/polyuser/Documents/Codex/2026-09-18/my/outputs/memory-generation-live-20260919/current-store-replay.json`
- `/Users/polyuser/Documents/Codex/2026-09-18/my/outputs/memory-cadence-20260919/results.json`
- `/Users/polyuser/Documents/Codex/2026-09-18/my/outputs/memory-client/verification.md`
- `/Users/polyuser/Documents/Codex/2026-09-18/my/outputs/memory-compact-reducer-20260919/README.md`
- `/Users/polyuser/Documents/Codex/2026-09-18/my/outputs/memory-structural-audit-20260919/README.md`
- `/Users/polyuser/Documents/Codex/2026-09-18/my/outputs/memory-scenario-replay-20260919/README.md`
- `/Users/polyuser/Documents/Codex/2026-09-18/my/outputs/memory-source-cadence-20260919/README.md`
- `/Users/polyuser/Documents/Codex/2026-09-18/my/outputs/memory-ocr-integration-20260919/REPORT.md`
- `/Users/polyuser/Documents/Codex/2026-09-18/my/outputs/memory-object-identity-20260919/REPORT.md`
- `/Users/polyuser/Documents/Codex/2026-09-18/my/outputs/memory-object-compact-throughput-20260919/README.md`
- `/Users/polyuser/Documents/Codex/2026-09-18/my/outputs/memory-writer-cadence-replay-20260919/README.md`
- `/Users/polyuser/Documents/Codex/2026-09-18/my/outputs/memory-writer-luna-comparison-20260919/README.md`
- `/Users/polyuser/Documents/Codex/2026-09-18/my/outputs/memory-positive-face-integration-20260919/README.md`
- `/Users/polyuser/Documents/Codex/2026-09-18/my/outputs/memory-door-citation-replay-20260919/README.md`
- `/Users/polyuser/Documents/Codex/2026-09-18/my/outputs/memory-client/candidate-ui-verification.md`
- `/Users/polyuser/Documents/Codex/2026-09-18/my/outputs/memory-client/writer-model-verification.md`
- `/Users/polyuser/Documents/Codex/2026-09-18/my/outputs/memory-context-writer-replay-20260919/README.md`
- `/Users/polyuser/Documents/Codex/2026-09-18/my/outputs/memory-context-batched-replay-20260919/README.md`
- `/Users/polyuser/Documents/Codex/2026-09-18/my/outputs/memory-recovery-replay-20260919/README.md`
- `/Users/polyuser/Documents/Codex/2026-09-18/my/outputs/memory-binding-cadence-v6-20260919/README.md`
- `/Users/polyuser/Documents/Codex/2026-09-18/my/outputs/memory-location-crop-probe-20260919/README.md`

The corresponding bounded replay scripts live under the R&D `work/memory-generation/`
directory. The client was authored and repaired with Claude Code Fable 5.1 as
requested. No credentials or experiment media are committed in this repository.
