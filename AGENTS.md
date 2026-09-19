# AGENTS.md — Remember

> **William's current working instructions (2026-09-19):** GitHub's default branch
> is `main`; William works on `chud3`, overriding older main-commit instructions
> below. For his UI work, use Claude Code Fable 5.1 (`claude-fable-5-1`); he
> authorizes `--dangerously-skip-permissions`. Prefer simple testing interfaces.
> If Claude is signed out, prepare the backend and wait for sign-in rather than
> substituting another UI author. A component testing request does not authorize
> executing the entire overnight build plan.

> **Remember** (working title — rename pending; keep the product name in exactly one place:
> `hub/remember_hub/branding.py` → `PRODUCT_NAME = "Remember"`) is an always-on AI wearable
> prototype built at Hack the North 2026. Think *Meta Ray-Ban × Even Realities G2*: a camera +
> mic + mini-display device streams everything to a nearby hub, which watches the world, decides
> — in ~100 ms — when something matters, and puts the right thing on the display with no button
> press and no wake word. It remembers where you left your keys, recognizes who just walked up,
> and answers "where are my keys?" spoken into the air.
>
> This file is both the **build spec for the overnight agent run** and the **persistent project
> guide** for later sessions. Read all of it before writing code. After the build lands, §13's
> "after the run" note says which parts migrate out of this file.

---

## 1. The one-paragraph mental model

A **device** (tonight: a laptop sim; later: phone / Raspberry Pi / ESP32-S3 glasses) streams
JPEG frames + PCM16 audio over **one WebSocket** to the **hub** (Python 3.12 asyncio, runs on a
MacBook, cloud-deployable). The hub fans out to GPU perception on **Baseten H100s** — **SAM 3.1**
(open-vocab object detection/segmentation/tracking), **InsightFace** (face ID), **streaming
Whisper** (live STT) — and folds every percept into a **world model** (objects + attributes +
tracks + last-seen locations, people + identities, rolling transcript). On each tick, the world
model is serialized to a **compact text snapshot** and sent to **Jev** (TypeSafe's System One
model: text in → typed decisions out in ~100–300 ms — booleans, choices, scores; **no text
generation, no image input**). Jev's answers gate **task handlers** (find object, identify
person, enroll face, remember/recall notes), which render **cards or images** back to the
device's mini display. Answers are **retrieval + templates**, never LLM generation — the hot
path is deterministic and fast.

```
┌────────── device (any) ──────────┐        ┌───────────────── hub (MacBook) ─────────────────┐
│ camera ─┐                        │  one   │  DeviceLink ── EventBus ──► WorldModel ──► Jev   │
│ mic ────┼─► WS: JPEG + PCM16 ────┼──────► │      ▲            │            │  snapshot  Gate │
│ display ◄── WS: cards + blits ───┼─ WS ── │      │            ▼            ▼            │    │
└──────────────────────────────────┘        │  Display ◄── TaskHandlers ◄── decisions ◄───┘    │
                                            │  Compositor        │                             │
                                            │                Memory (sqlite + frames + faces)  │
                                            └───────┬───────────┬───────────┬─────────────────┘
                                                    ▼           ▼           ▼            (all via
                                             Baseten H100   Baseten H100  Baseten H100    API,
                                             SAM 3.1 (WS)   Whisper (WS)  InsightFace     each
                                                                          (HTTP)          mocked)
                                                          TypeSafe Jev API (HTTP, ~100ms)
```

## 2. Decisions already made — do not relitigate

| Area | Decision |
|---|---|
| Hub language | Python 3.12, asyncio, `uv` for deps, pydantic v2 for all contracts |
| Firmware language | C/C++ (ESP-IDF) when real hardware exists; **tonight ship the laptop sim** |
| Device ↔ hub transport | One WebSocket per device; binary AV frames + JSON control (spec §5) |
| Object perception | Meta **SAM 3.1** (`facebook/sam3.1`, Meta `facebookresearch/sam3` repo, `Sam3MultiplexVideoPredictor`) on one Baseten H100 behind a WebSocket Truss |
| Face recognition | **InsightFace `buffalo_l`** (SCRFD + ArcFace, 512-d `normed_embedding`) — **same pack for local CPU and Baseten backends** so the gallery transfers; numpy gallery, cosine ≥ ~0.40 |
| Speech-to-text | Baseten model library **"Whisper Large V3 (Streaming)"** one-click deploy (WebSocket, partials + finals + word timestamps + server VAD) on an H100 |
| Hub-side VAD | Silero VAD, **ONNX model via onnxruntime** (no torch dependency); 512-sample/32 ms framing is the contract, not a package version |
| Decision brain | **TypeSafe Jev** (`jev-1.13.0` pinned), question-bank pattern, thresholds + hysteresis; snapshot feeds it **categorical words, never raw numbers** (§7) |
| Wake word | **None.** Device-directedness is a Jev boolean over the transcript + world context (openWakeWord is the emergency fallback only) |
| Answering questions | Retrieval + display templates. No generative LLM in the hot path (optional extension later) |
| Topology | Hub on MacBook near the device; all heavy inference remote on 4× H100 via Baseten |
| H100 allocation | #1 SAM 3.1 · #2 Whisper streaming · #3 face rec · **#4 idle tonight (scale-to-zero)** — morning stretch: 2nd SAM replica or the vocab-proposer slow lane (stub exists, §4) |
| Modularity | **Every** external dependency (SAM, face, STT, Jev, device) sits behind a small interface with `mock`, `local`, and `baseten`/`typesafe` backends selected in `remember.toml` |
| Tonight's bar | Fully runnable end-to-end **with zero API keys** (mock + local backends); Baseten/TypeSafe code paths complete and deploy-ready but verified in the morning |

## 3. Non-negotiable principles

1. **Latency is king.** Every hop has a budget (§12). Never add a queue that can grow: video
   paths are *at-most-one-in-flight*, drop-when-behind, newest-frame-wins.
2. **Mock-first.** `make demo` must pass on a fresh clone with **core deps only** — no keys, no
   GPU, no camera, no heavy ML installs (§11). Every backend interface ships its mock in the
   same PR as the interface. The mock is the reference implementation of the interface.
3. **Typed contracts everywhere.** Percepts, world entities, snapshots, decisions, display
   actions, wire messages — all pydantic models in `hub/remember_hub/contracts/`. No loose dicts
   crossing module boundaries.
4. **The world model is the only truth.** Perception writes to it; Jev reads a serialization of
   it; tasks query it. Nothing else talks to raw percepts.
5. **Don't invent external APIs.** Anything unverifiable tonight (exact TypeSafe SDK symbols,
   Baseten library payload fields, Meta repo class signatures) lives in **one adapter file** per
   service, marked `# TODO(verify): <source URL>`, with the mock proving the interface. Morning
   task = verify adapters, not refactor the system.
6. **Every commit runnable.** `make test` green before each commit. Small commits, imperative
   messages. Git policy: commit to `main`, tag milestones (`m2a`, `m3`, …), never force-push.
7. **Extensible by registration.** New task = an `Intent` + a Jev question + a handler + a card
   template. New device = implement the wire protocol. New percept source = adapter → bus.
   New vocabulary source = implement `vocab_proposer` (§4 stub). No core edits.

## 4. Repository layout (build exactly this)

```
htn2026/
├── AGENTS.md                      # this file (CLAUDE.md symlinks here for Claude Code pickup)
├── INTEGRATION.md                 # cross-lane scratch: contract-change requests, blockers (§13)
├── README.md                      # quickstart + demo script + live status (see §13 note)
├── Makefile                       # demo · sim · test · lint · fixtures · fetch-local-models · enroll
├── pyproject.toml                 # uv-managed; python = "3.12"; extras: [local], [sim] (§11)
├── remember.toml                  # runtime config (backends, vocabulary, thresholds)
├── .env.example                   # every env var, commented
├── hub/
│   ├── remember_hub/
│   │   ├── branding.py            # PRODUCT_NAME — the only place the name appears
│   │   ├── main.py                # entrypoint: load config, wire everything, run
│   │   ├── bus.py                 # tiny asyncio pub/sub (topic → async subscribers)
│   │   ├── scenario.py            # ScenarioRunner: drives mock backends on wall-clock (§10)
│   │   ├── contracts/             # ALL pydantic models + wire codec
│   │   │   ├── percepts.py        # Detection, FaceObservation, TranscriptSegment,
│   │   │   │                      #   AudioState{speech_active: bool, level_db: float}
│   │   │   ├── world.py           # Entity, PersonAttrs, LastSeen, WorldDelta (§8)
│   │   │   ├── decisions.py       # Intent enum, GateResult (§7)
│   │   │   ├── display.py         # Card, RasterBlit, DisplayAction (§9)
│   │   │   └── wire.py            # binary header codec + JSON control messages (§5)
│   │   ├── devicelink/            # WS server, device registry, per-class config push
│   │   ├── perception/
│   │   │   ├── sam/               # base.py (interface) · mock.py · local_yolo.py · baseten_ws.py
│   │   │   ├── face/              # base.py · mock.py · local_insight.py · baseten_http.py
│   │   │   ├── stt/               # base.py · mock.py · local_whisper.py · baseten_ws.py
│   │   │   │                      #   plus vad.py (Silero ONNX gate + 512-sample re-framer, §6.3)
│   │   │   └── vocab_proposer/    # base.py stub only — future slow lane that proposes new
│   │   │                          #   SAM concepts (H100 #4); NOT built tonight
│   │   ├── world/                 # model.py · tracks.py (IoU dedup, coasting) · snapshot.py
│   │   ├── gate/                  # jev_base.py · jev_mock.py · jev_typesafe.py
│   │   │                          #   questions.py (bank registry) · policy.py (ticks, hysteresis)
│   │   ├── tasks/                 # base.py + one file per intent (find_object.py, …)
│   │   ├── display/               # compositor.py (card templates → per-device render, play_clip)
│   │   └── memory/                # store.py (sqlite) · frames.py (ring buffer, M3) · faces.py (gallery)
│   └── tests/                     # pytest; scenario-driven e2e tests live here
├── devices/
│   ├── sim/                       # laptop: OpenCV capture + sounddevice + pygame display window
│   ├── phone/                     # M5b: single HTTPS page (getUserMedia + AudioWorklet + PWA display)
│   ├── rpi/                       # M5b: stub README only tonight (same wire protocol, Picamera2 + ALSA)
│   └── esp32/                     # M5b: ESP-IDF C skeleton (see §13 M5b for the honest bar)
├── deployments/
│   ├── README.md                  # THE MORNING CHECKLIST (§14) — humans start here
│   ├── sam3p1/                    # Truss (websocket) + DEPLOY.md + smoke test
│   ├── face/                      # Truss (http) + DEPLOY.md + smoke test
│   └── stt/                       # DEPLOY.md: one-click library steps + config + smoke test
├── scenarios/                     # scripted demos: keys.yaml, meet_person.yaml + assets/ (fixtures)
└── scripts/                       # record.py · replay.py · enroll.py · latency_probe.py
```

## 5. Device wire protocol (the one protocol every device speaks)

One WebSocket per device to the hub. Two planes. **Disable permessage-deflate** (JPEG/PCM don't
compress; it burns ESP32 CPU).

**Binary messages** — little-endian header, then payload. Header length is **type-conditional**:
8 bytes for 0x01/0x02, 16 bytes for 0x10/0x11 (the geometry prefix). WebSocket preserves message
boundaries, so `wire.py` switches on the first byte:

```
[u8 type][u8 flags][u16 seq][u32 ts_ms]
  0x01 device→hub  JPEG video frame
  0x02 device→hub  audio: 16 kHz mono PCM16-LE (40 ms chunks = 640 samples = 1280 B)
  0x10 hub→device  display JPEG blit   + [u16 x][u16 y][u16 w][u16 h] after the 8-byte header
  0x11 hub→device  display RGB565 blit + same geometry prefix
```

- `ts_ms`: device→hub = device `millis()` (NOT epoch); hub→device = hub's projection of device
  time from the `hello` mapping (devices may ignore it).
- `seq` is u16 and **wraps (~27 min at 40 msg/s)** — all gap/ordering comparisons use modular
  arithmetic.
- All three details above get dedicated M1 codec unit tests.

**Text messages** — JSON control:

```jsonc
{"type":"hello","device_id":"…","class":"laptop|phone|pi|esp32",
 "display":{"w":240,"h":240},"caps":{"video":true,"audio":true}}
{"type":"config","video":{"w":1280,"h":720,"fps":15,"quality":70},"audio":{"chunk_ms":40}}  // hub→device
{"type":"card","template":"profile|answer|alert|enroll_prompt|idle",
 "title":"…","body":"…","image_ref":null,"ttl_ms":8000}   // image_ref = seq of the paired 0x10 blit
{"type":"ping"} / {"type":"pong"}
```

Rules learned from research — encode them, don't rediscover them:
- Hub maps device time once at `hello`: store `(device_ts_ms, hub_monotonic)`; all percepts are
  stamped in hub time.
- Per-class defaults pushed via `config`: **laptop sim → 1280×720 @ 10–15 fps, q≈0.7** (SAM's
  native resolution is 1008 px — 720p input is the sweet spot); phone/Pi → VGA 640×480 @ 15 fps;
  ESP32 → QVGA 320×240 @ 10–15 fps, JPEG q≈12 (esp_camera scale), ~8–15 KB/frame. Audio always
  16 kHz mono PCM16, 40 ms chunks.
- Send audio before video each tick; video queue depth 1 on the device (drop-when-behind) — a
  60 KB JPEG must never head-of-line-block audio.
- Display is **two-tier**: semantic `card` JSON rendered device-side (pygame on sim, DOM on
  phone, LVGL later on ESP32) is the default; raster blits (0x10) are for photos, e.g. the
  "keys last seen" keyframe. Hub scales blits to the `hello` display size. **Video on the
  display = a hub-paced sequence of 0x10 blits**: `compositor.play_clip(frames, fps≤10, region)`
  honoring at-most-one-in-flight — no new protocol needed.
- Reconnect with backoff is the client's job; hub treats a reconnect as the same device.

**Sim device** (`devices/sim/`): `cv2.VideoCapture(idx, cv2.CAP_AVFOUNDATION)` +
`sounddevice.RawInputStream(samplerate=16000, dtype='int16')` + a pygame window as the fake
240×240 display. Threading is the trap, so it's specced: **pygame runs on the main thread**; the
asyncio client loop runs in a background thread; the sounddevice callback fires on a PortAudio
thread and `VideoCapture.read()` blocks ~30 ms — **all cross-thread handoffs into asyncio go
through `loop.call_soon_threadsafe` / `asyncio.run_coroutine_threadsafe`**, and camera capture
runs in its own thread feeding a depth-1 newest-wins slot, never inside a coroutine. macOS:
camera/mic TCC permission belongs to the *terminal app* — fail with a loud actionable error if
capture returns nothing; Continuity Camera can hijack index 0 — camera index in `remember.toml`.
The sim must also run **headless from fixture files** (JPEG sequence + wav) — that mode is what
CI and the overnight agent use.

**Phone** (`devices/phone/`, M5b): one static HTTPS page (mkcert cert; document the
accept-cert-once-over-https-then-wss dance), `getUserMedia` → canvas → `toBlob('image/jpeg',0.7)`
at 10–15 fps, AudioWorklet resamples to 16 kHz PCM16 (Safari ignores
`AudioContext({sampleRate})` — resample in the worklet), `navigator.wakeLock`, mic starts on tap.

**ESP32-S3** (`devices/esp32/`, M5b): ESP-IDF C skeleton. esp_camera with `fb_count=2`,
`fb_location=CAMERA_FB_IN_PSRAM`, `grab_mode=CAMERA_GRAB_LATEST`; `i2s_pdm` mic (S3 camera uses
GDMA so both run concurrently); `esp_websocket_client_send` of `fb->buf`. WiFi budget
~20 Mbit/s TCP → QVGA only. Display via `esp_lcd` ST7789 + JPEGDEC (SIMD, ~20 ms/QVGA decode)
later; cards-only is fine first.

## 6. Perception services (interfaces + three backends each)

Each service = `base.py` interface (pydantic in/out, `async`), consumed only via the bus/world
model. Backend chosen in `remember.toml`.

### 6.1 Objects — SAM 3.1 (`perception/sam/`)

Interface: `start_session(vocabulary: list[str])`, `push_frame(frame_id, jpeg, wh) →
list[Detection]` (async stream), `add_concept(noun)`, `end_session()`.
`Detection = {track_id, label, box_xyxy (abs, in SENT resolution — record wh per frame), score}`.
Masks are not needed by the hub — boxes + labels + stable track IDs only.

- **`baseten_ws.py`**: one WS to the Truss (`wss://model-{id}.api.baseten.co/environments/production/websocket`,
  `Authorization: Api-Key $BASETEN_API_KEY`). Baseten pins a WS connection to one replica for its
  lifetime → server-side tracker state is safe. Init message carries the vocabulary; then JPEG
  binary frames, **at-most-one-in-flight with a ~1 s response timeout — on timeout, drop the
  frame and reconnect** (a lost reply must never deadlock the send loop). Responses
  `{frame_id, objects:[…]}`. Recycle the session every ~5 min (known long-session memory
  growth). **During any recycle or reconnect: freeze track-end/LastSeen persistence and extend
  coasting until the first post-reconnect frame is IoU-re-associated** — otherwise every recycle
  writes spurious "last seen" rows for objects still in view and floods the event log.
  On reconnect: re-send vocabulary, accept new track IDs, re-associate by IoU.
- **`local_yolo.py`**: **Ultralytics YOLO-World** (`YOLO("yolov8s-worldv2.pt");
  model.set_classes(vocabulary)`) on the MacBook — open-vocab, so it CAN see keys/wallet
  (plain COCO YOLO cannot — its 80 classes lack keys, wallet, glasses, door). Weights via
  `make fetch-local-models`. Plain COCO YOLO is the fallback if world-weights fail.
- **`mock.py`**: emits detections from the active scenario (§10).

**Vocabulary** lives in `remember.toml` (start: person, keys, phone, water bottle, laptop,
backpack, cup, glasses, wallet, headphones, door, chair, **desk, table** — keep **≤ 20**, 1–3
words each; per-frame cost grows ~linearly with concept count; Multiplex packs ≤ 16 tracked
objects per forward pass). `add_concept()` exists so the future vocab-proposer slow lane (§4
stub, H100 #4) can extend it mid-session.

**Truss** (`deployments/sam3p1/`): `runtime.transport.kind: websocket`; **do not call
`websocket.accept()`** (Baseten accepts); pip-install `facebookresearch/sam3` from GitHub
(Python 3.12, torch 2.10/cu128; skip flash-attn-3 first — source build is slow);
`model_cache` → `facebook/sam3.1` with `hf_access_token` from Baseten secrets (**the repo is
GATED — a human must accept the SAM License on HF before the build**; this is line one of the
morning checklist); `Sam3MultiplexVideoPredictor` with bf16; **trigger torch.compile warm-up in
`load()`**, never on the first demo frame (default settings ≈ 5–6 fps; warmed 3.1 ≈ 32 fps on
H100); `min_replica: 1` during demo (and scale to zero while sleeping — H100s bill per-minute).
Expected: 720p JPEG q≈70 in, 5–8 fps sustained, ~60–120 ms inference + ~30–100 ms RTT.

Hub-side hygiene regardless of backend: IoU dedup (streaming mode disables Meta's hotstart
heuristics → duplicate tracks happen), score threshold, track coasting per §8's timing rules.

### 6.2 Faces — InsightFace (`perception/face/`)

Interface: `embed_faces(jpeg, wh) → list[FaceObservation{box, det_score, embedding_512}]`, plus a
pure-hub `memory/faces.py` gallery: `match(embedding) → (person_id, sim) | None`,
`enroll(person_id, name, embeddings)`.

- Pipeline: only runs when the world model has a live `person` track; hub downscales the current
  frame to ≤640 px and sends at ≤ 5 fps.
- Matching: `normed_embedding` **only** (dot = cosine); gallery = float32 N×512 numpy matrix +
  names, persisted `.npz`; threshold from config (default **0.40**, tune 0.35–0.45 on teammates
  in the morning). Reject faces with bbox < 80 px or low det_score — tiny egocentric crops
  poison centroids. **Every gallery entry is tagged with the embedding model name
  (`buffalo_l`); `match()` hard-fails loudly on a model mismatch** — silent cross-model matching
  degrades to noise below threshold.
- Both `local_insight.py` and the Truss use **`buffalo_l`** so enrollments transfer across the
  backend switch (CPU cost at ≤5 fps is fine on an M-series MacBook). `buffalo_s` is only an
  emergency fallback — switching packs requires re-enrolling (checklist item).
- Identity is decided by **track-level majority vote over 3 consecutive face observations**;
  when the vote stabilizes, the world model emits an `identity_changed` delta (→ reactive Jev
  tick, §7). Hysteresis: once displayed, a name only changes after a full new 3-vote.
- Enrollment flow (task, §9): unknown stable face → Jev confirms → display "Who is this? Say
  just their name" → STT final → mean 5–10 filtered embeddings, re-L2-normalize → one centroid.
- **`baseten_http.py`**: plain HTTP predict (stateless, autoscaling-safe). **`mock.py`**:
  scenario-driven (§10) — derives a **deterministic 512-d unit vector from the scenario's
  `person_tag`** (seeded RNG + small per-observation noise, re-normalized) so the real gallery
  enroll/match code runs unmodified in mock demos.
- **Truss** (`deployments/face/`): `insightface` + `onnxruntime-gpu`, **pin `numpy<2`** (known
  breakage), bundle the `buffalo_l` pack in the image (CDN download is flaky + slows cold
  start), pass `providers=['CUDAExecutionProvider']` explicitly and **log
  `session.get_providers()`** at load (onnxruntime silently falls back to CPU). GPU compute is
  <10 ms — the H100 is deliberate overkill; RTT dominates.
- License note for the pitch: InsightFace weights are research-only; fine for a demo, say so if
  judges ask about commercialization.

### 6.3 Speech — streaming Whisper (`perception/stt/`)

Interface: `async stream(pcm16_chunks) → TranscriptSegment{seg_id, text, is_final, words:[{w, t0, t1}], t_start_hub}`.
**Partials revise earlier text** — consumers key by `seg_id` and replace, never append.

- **`vad.py`** (Silero ONNX via onnxruntime, 512-sample/32 ms frames, sub-ms CPU) does two jobs:
  (1) **re-buffers the device's 640-sample/40 ms chunks into exact 512-sample frames** for both
  Silero and the STT stream; (2) gates what is forwarded — **as a gate with pre-roll and
  hangover, not a hard cut**: keep a ~300 ms rolling pre-roll flushed on speech onset (Silero
  onset lag would otherwise clip "where are…"), and keep forwarding ≥ 500 ms of real audio after
  speech offset **so the server-side VAD sees the silence it needs (min-silence 300 ms) to emit
  `is_final`** — then stop (never stream long silence; Whisper hallucinates on it). Publishes
  `AudioState{speech_active, level_db}` into the world model.
- **`baseten_ws.py`**: Baseten model library **"Whisper Large V3 (Streaming)"** one-click deploy.
  WS endpoint; JSON handshake, then 16 kHz mono PCM16-LE in 512-sample binary frames; responses
  carry `is_final` + `word_timestamps`; server VAD does finalization. First partial ≈ 1 s after
  speech onset; final < ~0.5 s after end of speech. Word timestamps are utterance-relative →
  align to hub time via the chunk-send timestamps. `min_replica: 1` before the demo;
  auto-reconnect (connections guaranteed only ≥ 1 h).
- **`local_whisper.py`**: `faster-whisper` small/int8 on the MacBook with
  `word_timestamps=True`, ~1 s windows — the keyless real backend. **`mock.py`**:
  scenario-scripted segments (§10).
- Rolling transcript (last ~60 s, with word times) lives in the world model; full transcript in
  sqlite.

## 7. The Jev gate (`gate/`)

Jev = TypeSafe System One model. Text state in → **typed decisions out** in one parallel pass,
~100–300 ms. Three primitives: **Noul** (calibrated yes/no probability), **Choice** (1 of ≤ 255
options + full distribution), **Score** (2–10 ordered levels, fractional). Limits that shape our
design: **text only** (it cannot see — perception must be serialized), 64K tokens state+questions
(we stay ≪ 2K for latency), reads instructions **literally**, cannot count or do arithmetic.
Asking 10 questions costs ≈ the same time as 1 → **always send the full bank in one call**.

```python
# gate/jev_typesafe.py — the ONE file allowed to import the vendor SDK.
# pip install typesafe-sdk · env TYPESAFE_API_KEY · POST https://api.typesafe.ai/v1/systemone
# TODO(verify): exact SDK symbols against https://docs.typesafe.ai before first live call.
client = TypeSafeClient(model="jev-1.13.0")          # pin — thresholds don't transfer across versions
resp = client.system_one(state=snapshot_text, questions={...})
resp.answers["addressed"].noul                        # 0.0–1.0
resp.answers["intent"].choice / .probabilities
```

**Snapshot** (`world/snapshot.py`) — deterministic, compact (< ~1.5K tokens), sections in fixed
order. **Every numeric that a question must judge is pre-bucketed hub-side into categorical
words** (Jev can't compare numbers): dwell → `brief|short|long` (<3 s / 3–15 s / >15 s);
match sim → `weak|ok|strong`; display age → `fresh|aging|stale`; proximity → `near|mid|far`
(box-area fraction). Raw timestamps may appear (task templates echo them) but no Jev question
ever depends on interpreting one. Example — **every field here is derivable from §8's attribute
rules; do not invent richer ones**:

```
TIME 21:47:03  SPEECH yes  DISPLAY answer(stale)
OBJECTS: person#p3 name=Sarah strong center-upper near dwell=long ·
  keys#k1 left-lower far dwell=short near[desk,laptop] · phone#m2 center near held-by=p3
PEOPLE: p3=Sarah (strong, stable). user_in_conversation=yes
LAST_SEEN: keys@21:46 near[desk] · wallet@18:02 near[table,cup]
EVENTS_30S: keys#k1 appeared · person#p3 identified as Sarah
TRANSCRIPT_15S: [user] "yeah I keep losing stuff" [user] "where did I put my wallet"
```

**Question bank** (`gate/questions.py`) — a registry, each entry
`{key, kind, instructions, intent, choices(world) | None, fire_threshold, debounce_ticks}`.
Ambient Nouls route through their `intent` field — that is the entire gate→task wiring.
`GateResult = {intent, source_question, target_label: str|None, person_track: str|None,
confidence}` (contracts/decisions.py). Starting bank:

| key | kind | → intent | instruction (gist) | policy |
|---|---|---|---|---|
| `addressed` | Noul | — (gates `intent`) | "The most recent user speech is directed at the assistant, not at another person" | fire ≥ 0.65 |
| `intent` | Choice | itself | NONE · FIND_OBJECT · IDENTIFY_PERSON · ENROLL_PERSON · REMEMBER_NOTE · RECALL_NOTE · CLEAR_DISPLAY | argmax, min prob 0.5, gated by `addressed` |
| `find_target` | Choice | FIND_OBJECT | dynamic: known object labels from world + LAST_SEEN + "none of these" | **omitted from the bank when < 2 real options** |
| `show_profile` | Noul | IDENTIFY_PERSON | "A person is prominent and the wearer would benefit from seeing their profile now" | fires on the identity-stabilized tick (the 3-vote is the debounce) |
| `enroll_worthy` | Noul | ENROLL_PERSON | "An unidentified person has been stably in view for a long dwell" | fire ≥ 0.7, debounce 3 |
| `clear_display` | Noul | CLEAR_DISPLAY | "The displayed content is stale or no longer relevant" | fire ≥ 0.75 |

The `user_in_conversation` / person-in-view context in the snapshot is load-bearing: it is what
keeps `addressed` from false-firing when the user talks *about* the device to a person (the DDSD
literature's 20–40 % false-alarm reduction comes from exactly these features).

**Tick policy** (`gate/policy.py`): reactive tick on (a) STT **final** segment, (b) meaningful
`WorldDelta{kind: appeared|disappeared|identity_changed|last_seen_written, entity_id}` —
**identity-vote stabilization is a delta and must tick immediately** — plus (c) 1 s heartbeat.
Full bank every tick (parallel = free). Hysteresis/debounce lives here, not in handlers. Rate
stays far under TypeSafe's 1200 req/min.

**`jev_mock.py`**: keyword/regex rules implementing the same interface ("where…keys" →
addressed 0.9, intent FIND_OBJECT, target keys). It must be good enough to drive every demo
scenario deterministically.

## 8. World model & memory

`world/model.py` owns: entity table, person identity states (voting, §6.2), rolling transcript,
display state, `AudioState`. Publishes `WorldDelta` events to the bus.

`Entity = {track_id, label, attributes: dict[str,str], box, score, first_seen, last_seen,
keyframe_ref: str|None}` · `PersonAttrs = {person_id: uuid, name: str|None, sim: float,
stable_votes: int}`.

**Attribute derivation** — attributes are computed hub-side **from box geometry only** (nothing
else exists tonight; richer attributes are a future percept source per §3.7):
- screen zone: `left|center|right` × `upper|lower` from box center;
- proximity proxy: `near|mid|far` from box-area fraction (>10 % / 2–10 % / <2 %);
- dwell: `now − first_seen`, bucketed per §7;
- `held-by=<person_track>`: box containment/IoU against person tracks;
- `near[...]`: co-visible vocabulary labels in the same frame.

**Last-seen index** — the heart of the "where are my keys" demo. Timing defaults (values in
`remember.toml`): tracks **coast 1 s** through detection gaps; a non-person track **ends after
2 s of absence**, which persists `LastSeen{label, ts, keyframe_ref, context_labels}` and emits a
`last_seen_written` delta. `keyframe_ref` points into the **frame ring buffer**
(`memory/frames.py`, built in M3: last ~30 min of JPEGs on disk + pinned keyframes; a keyframe
is pinned at track-end with the object's box drawn). `context_labels` = co-visible labels at
track end ("near desk, laptop") — used in the answer card via template, not generation.
**LastSeen persistence and track-ending are frozen during SAM session recycles/reconnects**
(§6.1).

`memory/store.py` (sqlite, WAL): `events` (append-only, everything — also the replay log),
`last_seen`, `notes` (REMEMBER_NOTE text + ts + keyframe), `transcript`. `memory/faces.py` as in
§6.2.

## 9. Tasks & display

`tasks/base.py`: `class TaskHandler(Protocol): intent: Intent;
async def run(ctx) → DisplayAction | None` where `ctx = {world, memory, gate_result, device_id}`.
Registered in a dict keyed by Intent; the gate routes `GateResult.intent` → handler. Handlers
only *read* world/memory and *return* display actions — no side channels.
`DisplayAction = {card: Card|None, blit: RasterBlit|None, ttl_ms, priority}` — card + optional
paired image in one action (`card.image_ref` = the blit's seq). **All handlers must tolerate
`keyframe_ref=None`** — mock mode has no frames; render the text card alone.

- `find_object.py`: resolve target label (Jev `find_target`, else fuzzy-match transcript against
  known labels) → live entities first ("Keys: in view, to your left"), else `last_seen` →
  answer card (+ keyframe blit when available): "Keys — near desk, 6 min ago (21:46)". Miss →
  "haven't seen keys".
- `identify_person.py` (also serves ambient `show_profile`): profile card — name, last-met
  time + context from events, note snippets mentioning them.
- `enroll_person.py`: two-phase state machine keyed by track_id with timeout (prompt card →
  await STT final → enroll → confirmation card). **Name extraction rule** (no generative model
  exists to do it): prompt says "Say just their name"; name = the STT final after stripping a
  fixed prefix list via regex ("this is", "their name is", "that's", "her/his/their name's"),
  title-cased; if > 3 words remain, re-prompt once, then abort.
- `remember_note.py` / `recall_note.py`: store/retrieve note + keyframe.
- `clear_display.py`.

`display/compositor.py`: card templates → per-device rendering (semantic JSON to capable
devices; pre-rendered raster for dumb ones — same `DisplayAction` either way), `play_clip()`
(§5), TTLs, priority (answer > enroll > profile > idle), idle clock card.

## 10. Scenarios, the demo runner, and the acceptance bar

**Demo runner** (`hub/remember_hub/scenario.py`): `make demo` connects **no device**. The
ScenarioRunner drives a wall-clock ticker that calls the mock backends through their normal
interfaces with synthetic inputs (1×1 JPEG, zeroed PCM) so the real contracts are exercised;
mocks answer from scenario time. Scenarios are capped at ~20 s; `by:` is a deadline with +0.5 s
tolerance; `expect` asserts on the hub's **DisplayAction bus topic** (never on a device render),
matching case-insensitive substrings over card title+body. This is also the main pytest e2e —
and it means **M2 has zero dependency on M1's DeviceLink**.

`scenarios/*.yaml` — the timeline DSL (these event kinds are the whole DSL; `words: true` =
synthesize evenly spaced word timestamps across the final):

```yaml
name: keys
timeline:
  - {t: 0.5,  sam:  {appear: {label: desk, track: d1, box: [0.10, 0.55, 0.95, 0.98]}}}
  - {t: 1.0,  sam:  {appear: {label: keys, track: k1, box: [0.60, 0.70, 0.75, 0.85]}}}
  - {t: 6.0,  sam:  {disappear: {track: k1}}}
  - {t: 12.0, stt:  {final: "where are my keys", words: true}}
  - {t: 3.0,  face: {observe: {track: p1, person_tag: sarah, det_score: 0.9,   # meet_person.yaml
                               box: [0.4, 0.1, 0.6, 0.5]}}}                    # uses these
expect:
  - {by: 13.5, display: {template: answer, contains: "desk", not_contains: "haven't"}}
  - {gallery: {contains: "Sarah"}}          # meet_person.yaml: enrollment mutated the gallery
```

The keys expectation is deliberately **non-vacuous**: `contains: "desk"` + `not_contains:
"haven't"` distinguishes a real last-seen answer from the miss card. (With LastSeen persisting
2 s after disappearance, the row exists from t≈8 s — well before the question at t=12.)

- `make demo` = keys.yaml headless, all backends `mock`, core deps only. **This must pass on a
  fresh clone with zero keys — it is the acceptance bar for the overnight run.**
- `scripts/record.py` / `replay.py`: record a live session's AV + percepts; replay through the
  real pipeline offline. Gold for demos, debugging, and the last-resort stage fallback (§14).
- `scripts/latency_probe.py`: prints the §12 table measured live (contracts carry
  `t_captured`, `t_percept`, `t_decision`, `t_displayed`).
- `scripts/enroll.py`: CLI face enrollment from webcam (pre-seed teammates in the morning).
- `make fixtures` (M3): synthesizes offline test media — macOS built-in TTS
  (`say -o where_keys.wav --data-format=LEI16@16000 "where are my keys"`) for STT/VAD tests,
  Ultralytics' bundled `bus.jpg` for YOLO-World smoke, numpy-generated JPEG sequences for the
  headless sim.

## 11. Config, environment & dependency partitioning

`remember.toml` (checked in, no secrets): per-service `backend = "mock" | "local" | "baseten"`
(`jev`: `"mock" | "typesafe"`), SAM vocabulary, face threshold, gate thresholds/debounce,
track/LastSeen timings, device class video/audio defaults, sim camera index.

Env (`.env.example`): `BASETEN_API_KEY`, `BASETEN_SAM_MODEL_ID`, `BASETEN_STT_MODEL_ID`,
`BASETEN_FACE_MODEL_ID`, `TYPESAFE_API_KEY` (+ `HF_ACCESS_TOKEN` used only at Truss build time).
Missing key + non-mock backend = loud actionable startup error, not a crash mid-demo.

**Dependency partitioning (load-bearing — the acceptance bar depends on it):**
- **Core deps** (all `make demo` / `make test` may use): `pydantic`, `websockets`, `pyyaml`,
  `numpy` only.
- **`[sim]` extra**: `opencv-python`, `sounddevice`, `pygame`.
- **`[local]` extra**: `ultralytics`, `insightface`, `onnxruntime`, `faster-whisper`, with
  **`numpy>=1.26,<2` pinned here** (insightface breaks on numpy 2; ultralytics constrains numpy
  on Darwin). Silero VAD = its ONNX model file (fetched by `make fetch-local-models`) run
  through `onnxruntime` — **not** the torch/torchaudio package path.
- Backend modules **lazy-import** their heavy deps inside factory functions with an actionable
  error ("run: uv sync --extra local"). Non-mock STT needs `[local]` (VAD); non-mock face needs
  `[sim]`'s opencv for downscaling — any non-mock run should just install both extras.
- Tests never hit the network or download models; `make fetch-local-models` is the only
  downloader and is never called by tests.

## 12. Latency budgets (measure, don't vibe)

| Leg | Budget |
|---|---|
| Device → hub (frame/audio, LAN WS) | 10–40 ms |
| Hub → SAM 3.1 → detections (720p, warm) | 90–220 ms |
| Speech onset → first STT partial | ~1 s |
| End of speech → STT final (incl. VAD hangover) | < 800 ms |
| Snapshot + Jev bank | 100–350 ms |
| Task + render → device paint | < 150 ms |
| **End of question → answer card** | **< 1.5 s** |
| **Person appears → profile card** (SAM track + 3-vote @ ≤5 fps + reactive tick) | **< 2.5 s** |

## 13. Overnight milestones (in order; each ends green)

> **After the overnight run**: milestone status, quickstart, and the demo script live in
> `README.md`; the morning checklist lives in `deployments/README.md`. This file then keeps only
> the persistent sections (§2 decisions, §3 principles, §5–§9 contracts, §14–§15) — update §2's
> table when a decision genuinely changes, and prune §13 to a pointer.

- **M0** Scaffold: layout §4, uv + pyproject (core/extras split per §11), Makefile, ruff +
  pyright(basic) + pytest wired, contracts drafted, bus. `uv sync` (core only) + `make test`
  green.
- **M1** DeviceLink + sim device: wire codec with unit tests covering §5's three edge cases
  (type-conditional header length, seq wraparound, ts_ms semantics); WS server; **headless sim
  streaming from fixture files** end-to-end. Live webcam/mic code written, but TCC-dependent
  verification moves to the morning checklist.
- **M2a** The keys path, minimal: world model + tracks + attribute derivation + snapshot +
  question bank + jev_mock + `find_object` + `clear_display` + compositor + sqlite `last_seen` +
  ScenarioRunner. **`make demo` (keys.yaml) green — the acceptance bar.**
- **M2b** Remaining handlers (identify/enroll/notes), faces gallery (with model-tag check),
  `meet_person.yaml` (enroll → re-identify via deterministic mock embeddings) green.
- **M3** Local backends: `local_yolo` (YOLO-World), `local_insight` (buffalo_l CPU),
  `local_whisper` + Silero-ONNX VAD; `memory/frames.py` ring buffer; `make fixtures`.
  Verification is **fixture-driven** (agent-runnable overnight): the `say`-generated wav must
  transcribe to contain "keys"; YOLO-World on `bus.jpg` must detect ≥1 person; insightface must
  load and return zero faces on a noise image without crashing.
- **M4** Cloud backends, code-complete behind config: `baseten_ws` (SAM), `baseten_http` (face),
  `baseten_ws` (STT), `jev_typesafe`. Trusses + `DEPLOY.md`s + `scripts/smoke_*.py` per service.
  Cannot be live-verified overnight — isolate per §3.5; the morning checklist (§14) is the
  verification plan.
- **M5a** Demo-critical polish: enrollment e2e in the sim, record/replay, latency_probe, README
  with the 3-minute demo script.
- **M5b** *Optional — skip without guilt, never at M5a's expense*: phone page; ESP32 skeleton
  (**run `idf.py build` only if ESP-IDF is already on PATH — do NOT install the toolchain
  overnight**; otherwise mark build-unverified in the checklist); `devices/rpi/` stub README
  only.

If time runs short: cut from the tail (M5b → M5a → M4 …), never by breaking `make demo`.

### 13.1 Parallel execution plan (3–4 agents)

Multiple agent sessions run this spec concurrently. Each session is launched with its lane
letter ("You are Lane A — read AGENTS.md §13.1") and must stay inside its lane's files.

**Phase 0 — ONE agent, serial (~first hour): the contract freeze.** Exactly M0, plus every
`base.py` interface in `perception/*` and `gate/`, plus **all** Makefile targets and pyproject
extras pre-declared from this spec (nobody touches those two files afterward — that is what
makes the lanes conflict-free). Commit to `main`, tag `m0`. After the tag, `contracts/` and
every `base.py` are **frozen**: a lane needing a change writes the request in `INTEGRATION.md`;
only the integrator applies it and announces it there.

**Lanes — disjoint file ownership; no two lanes ever write the same directory:**

| Lane | Owns | Delivers | Starts |
|---|---|---|---|
| **A — Brain** *(critical path; the phase-0 agent continues here and doubles as integrator)* | `world/` `gate/` (mock + bank + policy) `tasks/` `memory/` `scenario.py` + the three `mock.py` perception backends + `scenarios/` | M2a → **`make demo` green** → M2b → M5a enrollment e2e | after `m0` |
| **B — Edge** | `devicelink/` `display/` `devices/sim/` + wire-codec tests + `scripts/record.py` `replay.py` `latency_probe.py` | M1 (headless fixture sim) → M5a record/replay + probe | after `m0` |
| **C — Local perception** | `perception/*/local_*.py` `stt/vad.py` + `make fixtures` + `fetch-local-models` | M3, fixture-verified | after `m0` |
| **D — Cloud** | `deployments/` + `perception/*/baseten_*.py` + `gate/jev_typesafe.py` + `scripts/smoke_*.py` + `enroll.py` | M4 code-complete + morning checklist | **immediately** — `deployments/` Trusses need no hub contracts; adapters once `m0` lands |

Running 3 agents instead of 4: merge C + D into one Backends lane (locals first — they gate
`ckpt-2`; cloud adapters after). The mock/local/cloud split across A/C/D works because all
three implement the same frozen `base.py` — they never see each other's code.

**Mechanics:** each lane works in its own git worktree on branch `lane-a|b|c|d`; Lane A merges
to `main` at the checkpoints below (disjoint ownership makes merges append-only; `uv.lock`
regenerates on `main` only). Cross-lane communication happens **only** through frozen contracts
and `INTEGRATION.md` (three headings: `## Contract-change requests`, `## Done`, `## Blocked`).
If blocked on another lane > 15 min: stub against the frozen interface, note it in
`INTEGRATION.md`, move on. Never edit another lane's files, even to "quickly fix" something.

**Checkpoints (integrator merges all ready lanes + tags):**
1. `ckpt-1` — M2a + M1 on `main`: `make demo` green **and** the headless fixture sim streams
   into the hub end-to-end.
2. `ckpt-2` — M3 on `main`: flipping `remember.toml` to `local` passes the fixture suite.
3. `ckpt-3` — M4 + M5a on `main`: smoke scripts ready, README demo script written. M5b work
   only after this tag, never before.

## 14. Morning plan & demo fallbacks (`deployments/README.md` mirrors this)

**Checklist order**: (1) accept the SAM License on HF (gated repo) + create Baseten/TypeSafe
keys into `.env`; (2) human A: `truss push` sam3p1 + face, one-click deploy STT from the model
library, set `min_replica: 1` on all three, run `scripts/smoke_*.py`, paste model IDs into
`.env`; (3) human B: grant TCC camera/mic to the terminal app, run live `make sim`, enroll
teammates via `scripts/enroll.py`, tune face threshold on venue lighting; (4) agent: fix
whatever the smoke tests surface (adapters are isolated per §3.5 — fixes stay inside one file
per service); (5) verify `jev_typesafe` symbols against TypeSafe docs, run one live bank call;
(6) `scripts/record.py` a full rehearsal — that recording is the stage fallback.

**Fallback ladder** (rehearse the flip once): `baseten` → `local` → `mock` → `replay.py` of the
rehearsal recording. Backend flips are one-line `remember.toml` edits; venue WiFi dying must
cost you one config line + restart, not the demo. Bring a phone hotspot for the hub→Baseten leg.

## 15. Verification & guardrails for agent sessions

- `make test` before every commit; keep pyright/ruff clean. Never commit secrets or model
  weights. Git policy per §3.6.
- Report honestly: things unverifiable without keys/hardware are listed as such in the final
  report — with their smoke-test command — not described as working.
- **Privacy**: always-on camera + face rec — enrollment is explicit verbal opt-in, `make demo`
  data is synthetic, and the README carries a consent note for hackathon demoing.

## 16. Key sources (verified Sept 2026)

- Jev / TypeSafe: [system_one API guide](https://dev.to/valyuai/how-to-use-jev-a-practical-guide-to-typesafes-system-one-model-g5e) · [gating patterns](https://www.langchain.com/blog/building-a-harness-with-jev)
- SAM 3.1: [Meta repo + Multiplex release notes](https://github.com/facebookresearch/sam3) · [Meta blog (32 fps H100)](https://ai.meta.com/blog/segment-anything-model-3/) · [gated checkpoint](https://huggingface.co/facebook/sam3.1) · [HF Transformers Sam3Video (sam3-only fallback)](https://huggingface.co/docs/transformers/en/model_doc/sam3_video) · [throughput caveat #425](https://github.com/facebookresearch/sam3/issues/425)
- Baseten: [WebSocket transport](https://docs.baseten.co/development/model/websockets) · [Whisper streaming library model](https://www.baseten.co/library/whisper-streaming-large-v3-truss/) · [WS tutorial (PCM framing)](https://www.baseten.co/blog/zero-to-real-time-transcription-the-complete-whisper-v3-websockets-tutorial/) · [autoscaling/keep-warm](https://docs.baseten.co/deployment/autoscaling/overview) · [model_cache](https://docs.baseten.co/development/model/model-cache) · [Chains](https://docs.baseten.co/development/chain/overview)
- Faces: [InsightFace model zoo](https://github.com/deepinsight/insightface/blob/master/model_zoo/README.md) · [threshold guidance](https://www.insightface.ai/guides/choose-face-recognition-model-and-evaluate) · [SCRFD](https://github.com/deepinsight/insightface/tree/master/detection/scrfd)
- STT extras: [Silero VAD](https://github.com/snakers4/silero-vad) · [Kyutai STT (upgrade path)](https://kyutai.org/stt/) · [DDSD / no-wake-word gating](https://machinelearning.apple.com/research/llm-device-directed-speech-detection) · [openWakeWord (fallback)](https://github.com/dscripka/openWakeWord)
- Device: [ESP32 camera FAQ (fps/bandwidth)](https://docs.espressif.com/projects/esp-faq/en/latest/application-solution/camera-application.html) · [S3 SIMD JPEG decode](https://www.atomic14.com/2023/09/30/a-faster-esp32-jpeg-decoder) · [XIAO Sense cam+mic concurrency](https://github.com/espressif/arduino-esp32/issues/6830) · [getUserMedia secure-context](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia)
