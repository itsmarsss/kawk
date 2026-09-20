# Memory testing client contract

New TypeScript service on port 8082 (existing lab stays on 8081).
Dark primitive UI; this page is the live memory-generation test, not an answering agent.

## HTTP

- `GET /api/config`: `{captureIntervalMs:5000, transcriptWords:200, perceptionUrl, provider, model, writerModel}`. `model` interprets images; `writerModel` updates memory and defaults to the image model.
- `POST /api/sessions` `{}` → `{id,startedAt}`. Each Start creates a new session.
- `POST /api/transcripts` → `Transcript` from `src/contracts.ts`; returns `{accepted:boolean}`.
  Identical revisions are idempotent.
- `POST /api/captures` → `CaptureInput` from contracts, returns HTTP202 `{id,status}`.
  Capture ID and face frame ID must match; timestamps identical, face640 derivative
  has same aspect ratio as camera photo. JPEG base64 without URL prefix. Submit even
  when speech/faces unavailable with explicit status, never reuse old identities.
- `GET /api/dashboard` → `{state,entities,observations,events,encounters,captures,stats,
  pipeline:{running,queue,observing,reducing,indexing,lastError,latencies}}`.
- `GET /api/packets/:id` → latest joined evidence packet or 404 while vision is pending.
  Prepared evidence exists before its memory update commits; check capture status separately.
  `GET /api/packets/:id/history` returns immutable versions, including replaced drafts.
- `GET /api/entities/:id` → `{entity,observations,encounters,events}`.
- `GET /api/object-sightings?packetId=...` → object sighting decisions; packet filter optional.
  Each row retains its local ref, source packet/time, supported or candidate status,
  canonical entity ID or candidate IDs, reason, cited anchors and source evidence.
- `POST /api/search` `{query,entityId?,from?,to?,limit?}` → `{results:[SearchHit]}`.
- `GET /api/frames/:captureId` → original JPEG.
- `GET /api/gallery`, `WS /ws/faces?backend=local`, `WS /ws/speech?backend=baseten`
  and `/static/*` are proxied to existing Python lab on8081 with corrected Origin.
  Existing enrollment test accessible through a link to http://localhost:8081/faces.

## Capture and face synchronization

Use one media capture. Keep InsightFace around5fps, one JPEG outstanding at a time.
Every5000ms, take a full photo (max1280 or1920longside); draw its640px face derivative
from that very canvas/image. Retain full JPEG plus source timestamp/ID while the
face request is in flight, then package THAT response with THAT full photo.
Use reply `stable_id/stable_name` as personId/name, unknown remainsnull. Never use
raw match.id as confirmed identity. Face box coordinate space=640px derivative.
Show boxes/name overlay continuously. Face reconnect after error or600s timeout.
Timer anchoring must not await network/model; keep failed capture counters visible.
To prevent gaps if a face request is busy at a5s tick, retain scheduled fullphoto
and submitits derivative at next available slot; do not substitute a later frame.
At face timeout submit scheduledphoto with face statusunavailable and emptyfaces.

## Speech alignment

Reuse `/static/remember/live/capture.js` createCapture or existing AudioWorklet;
one512sample16kHzPCM chunk=32ms. Waitfor speech `ready` beforeforwardingaudio.
Assign fresh streamId on eachconnection. Recordsource timestamp of FIRST PCM
actuallysent (not websocketopen or first microphonechunkwhileconnecting).
Map cloud `word.start_time/end_time` (seconds) to that sentaudio timeline. If audio
is skipped/backpressure occurs, keep piecewise chunkoffset→capturetime mapping or
reconnect/dropfresh; don't shift all later words. Cloud segment keys = streamId+
segment_id; increase revision only when text/finality/wordtimingschange. Partial
isFinalfalse; speakerIdalwaysnull. receivedAt=Date.now(); source time approximate.
No wordtimes: infer interval from previousfinal/currentaudio position, label
approximate, never assert identifiedspeaker. POST eachrevisionindependently;
capturedpacket assembly and last-Nselection are server-owned.
Stop flushes~500msaudio silence, waitsbrieflyforfinal, thenreleasesallmedia/timers.

## Display

State is a complete interpretation at the packet's source time. Null location or
activity means unknown/no longer supported, not “reuse the previous value.”
Supported unchanged values are explicit. Corrections clear invalid summaries while
repair is pending and do not rewind the current source-time cursor.

Observations and search hits distinguish `entityIds` from `candidateEntityIds`.
Entity history and entity-filtered search can include both. When the requested
entity appears only in the candidate list, display “Possible match — identity
unconfirmed”; do not present it as a new confirmed location. Ordinary confidence
and source provenance still apply. Supported object reuse is an inference from
matching intrinsic details, not independent physical verification. Object entities
expose up to 12 distinct `identityAnchors`; complete source evidence stays in storage.

Start/Stop;cameraandmicselect;videopreviewwithfaceboxes;componentstatus;liveheard
transcript withpartial/final;currentlocation/activity/state;entitylist/history;
packetlistwithsourcephotoandstatus;semanticsearchwithsourcecites;queueandcapture→memory
latency. Fixed-size statusregions toavoidlayoutjump. Empty/error states honest.
No UI controls for Jev/reminders/agentactions. All memorygeneration starts only
afterStart; pageopeningmustnotrequestcameraorlaunchcloudinference.
