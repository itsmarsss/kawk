# Speech, introductions and people on the memory page

The page at `http://localhost:8082/` now has an explicit local/cloud speech selector,
connection-aware transcript status, an introduction status below the camera, and
a People section with Delete and Reset controls. UI implementation uses Claude
Code `claude-fable-5-1` per the workspace instructions.

## Speech

The browser sends 16 kHz mono PCM16 in 512-sample chunks over the memory server's
same-origin WebSocket proxy. The selected perception service sends revisable
partials and finals. The page displays both; the durable transcript ledger retains
their source intervals, revision and finality. No identity is assigned to a speaker.

`MEMORY_SPEECH_BACKEND=local|baseten` chooses the initial selector value, while
`MEMORY_SPEECH_NOTICE` can explain an operational issue. Selection applies on Start.
There is no silent fallback. The current local launcher explicitly selects local
Whisper Small int8 because Baseten Whisper (`wdlg2oe3`, deployment `wldeyy7`) was
INACTIVE with zero replicas; activation returned HTTP 400, "You must add a payment
method to deploy models." The reserve Baseten credit profile was not used.

Local Whisper's utterance-relative word times are converted to stream-relative
audio offsets in the relay. This matters after the first utterance: otherwise a
second introduction would be attributed to the beginning of the microphone stream.

## Naming

After the memory service accepts a final transcript, the browser forwards it once
to the face connection that was current when that final arrived. Reconnects, Stop,
partials and duplicate finals cannot replay the naming action.

The perception server retains a bounded recent face history. It requires the same
single usable track during the source speech interval, with at least three face
observations, and rejects stale source times or ambiguous faces. Jev answers two
questions in one call: whether this introduces/corrects the visible person's name,
and which exact spoken word span is that name. The host enumerates bounded spans;
there is no required command phrase or prefix-based naming decision. Decision
thresholds are 0.7 for attribution and 0.5 for the selected name.

After Jev responds, the server checks that the track, identity, embedding and
unambiguous visibility still match. Unknown people are enrolled using five fresh
consistent face embeddings; known people are renamed on their existing gallery
UUID. Normal recognition votes then update box labels. A partial transcript never
enrolls or renames anyone. This establishes a likely name/face association, not
verified speaker diarization. No claim of general naming accuracy follows from
the small live acceptance suite.

## Reset scope

`GET /api/people` lists enrolled gallery identities and provisional person entities.
`DELETE /api/people/:id` removes a selected recognition entry and hides the memory
person and linked observations from active retrieval. `DELETE /api/people` resets
all currently known people. Both require explicit UI confirmation and invalidate
pending naming/enrollment. The active face connection recycles to clear old labels.

Memory deletion is a durable tombstone, not source-media erasure. Original source
photos, transcripts and packet evidence remain. Reset also records a capture-time
cutoff so delayed interpretation of already-captured photos cannot repopulate the
people list. New photos may create new provisional people; introducing yourself
again creates a fresh gallery identity. Previously generated unlinked scene text
is source evidence and is not selectively redacted by this reset control.

## Verification

- 279 memory-backend tests passed after adding reset/API coverage; the later
  current-state tombstone adjustment passed 44 focused store/server tests.
- 64 Python introduction, face enrollment, identity, speech relay and local
  backend tests passed, including replacement at the same box geometry.
- Final UI implementation: 60 client tests passed and client typechecking/build passed.
- Real local Whisper proxy test: partial at 1.92 seconds and correct final at
  2.82 seconds from the start of streamed fixture audio (includes leading silence;
  not speech-offset latency). No production memory writes.
- Six real Jev decisions passed: three introductions accepted, three unrelated,
  quoted or non-name statements rejected; observed decision times 0.37–0.87 seconds.
- Isolated end-to-end test used real local InsightFace, local Whisper and Jev.
  Synthetic speech introduced Maya Chen, corrected the name to Robert on the same
  UUID, then deletion cleared recognition in subsequent frames. The temporary
  gallery/server were removed; no actual user enrollments were modified.
- Browser QA verified local speech reaches `ready`, sends microphone audio (1,144
  chunks during the check), and preserves the five-second photo cadence without
  errors. The microphone was quiet during this browser check; actual text/naming
  is covered by the real-model fixture runs above, not claimed as live user speech.
  Both individual Delete and Reset confirmation/cancellation were checked without
  deleting production people. All 256 existing provisional people were accessible.

Evidence: `/Users/polyuser/Documents/Codex/2026-09-18/my/outputs/memory-speech-people-20260920/`.
The image-memory writer's previously reported schema failures are a separate issue;
this change does not claim to fix those failures.
