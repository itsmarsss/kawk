# INTEGRATION.md — cross-lane scratch (AGENTS.md §13.1)

Frozen after `m0`: `hub/remember_hub/contracts/`, every `perception/*/base.py`, and
`gate/jev_base.py`. Request changes under the first heading; only the integrator (Lane A)
applies them and announces here.

## Contract-change requests

(none)

## Done

- `m0` — scaffold + contracts + base interfaces + Makefile/pyproject (Lane A/B side)
- `m2a`+`m2b` — brain loop green: `make demo` (keys) + meet_person, 17-test suite
- `m1` — devicelink + headless sim e2e + live drivers + `make hub` entrypoint
- M5a — record/replay (percept-level), latency_probe, README
- `pwa-notify` branch — **display pivot: LCD -> phone/watch push notifications.**
  New `notify/` tier consumes `display.current` (compositor untouched): NotifyService
  (policy: min-priority, cooldown dedupe) -> WebPushSink (`[pwa]` extra) + SSE in-app
  feed; PwaServer on :8091 serves `devices/pwa/` (installable PWA) + subscribe/test
  APIs. Touched shared files (heads-up for merge): config.py (+PwaCfg), main.py
  (wiring), remember.toml (+[pwa]), pyproject (+pwa extra), Makefile (+vapid,
  pwa-icons), test_hub_boot.py (one line: pwa.enabled=False in tests). Setup:
  devices/pwa/README.md; phone-in-hand iOS verification is a morning-checklist item.
  **Overlap notice:** chud3's TS agent has its own PWA + push (docs/PWA_CONTRACT.md,
  agent/src/push.ts — sqlite delivery queue, port 8091). This tier serves the PYTHON
  hub and now binds :8092 so both stacks boot on one Mac. Team decision needed
  before demo: which stack's PWA goes on the phone (their SW payload is
  {id,title,body,url}; ours is {title,body,tag,data} — trivial to converge later).

## Interfaces Lane C/D plug into (all live on `chud1`)

- Your backends: implement `perception/*/base.py`; register in the existing
  `create_*_backend()` factory branches (lazy imports already stubbed with your
  module/class names: `local_yolo.LocalYoloSam`, `baseten_ws.BasetenSam`,
  `local_insight.LocalInsightFace`, `baseten_http.BasetenFace`,
  `local_whisper.LocalWhisper`, `stt/baseten_ws.BasetenStt`, `jev_typesafe.JevTypeSafe`).
- STT: `SttDriver` (perception/drivers.py) feeds raw 40 ms device chunks into
  `stream()`. Lane C's vad.py should wrap/gate that feed (pre-roll + hangover +
  512-sample re-framing per AGENTS.md §6.3) — cleanest: do the re-framing inside
  your backends' `stream()` so the driver stays untouched.
- Face: `FaceDriver` sends the full frame today; add hub-side ≤640px downscale
  when your cv2 path lands (TODO marked in drivers.py).
- `memory/frames.py` (ring buffer) is unbuilt; `keyframe_ref` is always None and
  every handler tolerates that — wire it in world/model.py `_end_track()`.
- **Lane D, SAM recycle rule (§6.1)**: `world.tracks.freeze()` / `.thaw()` exist and are
  audit-tested (frozen = no track-ends + extended coasting). Your `baseten_ws.py` MUST
  call freeze before a session recycle/reconnect and thaw after the first re-associated
  frame — the hub side is ready, the calls are yours.
- STT driver already auto-reconnects around `stream()` and publishes an RMS-based
  `percepts.audio` stopgap — your vad.py replaces the stopgap, keep the topic contract
  (`AudioState`).

## Blocked

(none)

## Notes for Lane C/D

- Makefile targets `fixtures`, `fetch-local-models`, `enroll` reference
  `scripts/make_fixtures.py`, `scripts/fetch_local_models.py`, `scripts/enroll.py` —
  those files are yours to create; targets are pre-declared so the Makefile never changes.
- Backend factories live in `perception/<svc>/__init__.py` — add your `local`/`baseten`
  branch inside the existing `create_*_backend()` lazy-import structure; do not edit
  `base.py` or `mock.py`.
