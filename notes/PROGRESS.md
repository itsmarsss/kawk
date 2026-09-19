# PROGRESS — Lanes A + B (update after every commit; source of truth across compactions)

> Session resume order: AGENTS.md → notes/PREFERENCES.md → this file → notes/KNOWLEDGE.md.

## M0 — scaffold + contract freeze (phase 0) — DONE, tag `m0`
- [x] worktree `chud1`, uv installed; pyproject core/extras split; Makefile; remember.toml
- [x] contracts/ (percepts, world, decisions, display, wire) + bus + branding + config
- [x] perception base.py x3 + vocab_proposer stub + jev_base + factories (lazy imports)
- [x] wire codec unit tests (type-conditional header, seq wrap, ts_ms)

## M2a — keys path — DONE, tag `m2a` (`make demo` GREEN)
- [x] mocks sam/face/stt (scenario-driven, deterministic embeddings)
- [x] world: tracks (IoU dedup, coasting, freeze hook) + model + snapshot (categorical buckets)
- [x] memory: sqlite store + faces gallery (model-tag hard-fail, enrolled_at)
- [x] gate: bank + policy (reactive ticks + heartbeat + debounce) + jev_mock
- [x] tasks: find_object, clear_display + router; display compositor (priority/TTL)

## M2b — DONE, tag `m2b` (same commit as m2a)
- [x] enroll_person state machine (name extraction, re-prompt once), identify_person, notes
- [x] meet_person.yaml green: enroll_prompt @6.0s → gallery Sarah → profile @7.9s

## M1 — devicelink + sim (Lane B) — DONE, tag `m1`
- [x] DeviceLinkServer: hello/config, newest-wins frame slot, av.audio topic, card+blit tx,
      permessage-deflate disabled, reconnect-replaces-session
- [x] perception/drivers.py (SamDriver/FaceDriver/SttDriver) + main.py live wiring
- [x] devices/sim: headless fixture mode (core deps only, embedded fallback JPEG) +
      live mode (cv2/sounddevice/pygame, spec threading) — live is TCC-gated, morning item
- [x] e2e test: headless sim → hub → card round-trip

## M5a — DONE (percept-level)
- [x] scripts/latency_probe.py (5.9 ms hub overhead on keys, budget 1500 ms)
- [x] scripts/record.py (REMEMBER_RECORD env tap in main.py) + scripts/replay.py
- [x] README with demo script + status + consent note

## Remaining for our lanes (all deferred to morning checklist by design)
- Live `make sim` verification (needs TCC camera/mic grant — human)
- Keyframe blits (needs memory/frames.py — that is M3/Lane C territory)
- ESP32/phone/rpi = M5b, only after teammate's lanes merge (never at M5a's expense)

## Done log
- 2026-09-19 · 0f0399b · m0 scaffold + contracts (tag m0)
- 2026-09-19 · f11accd · brain loop, both scenarios green (tags m2a, m2b)
- 2026-09-19 · (next) · devicelink + sim + drivers + main (tag m1); scripts + README
