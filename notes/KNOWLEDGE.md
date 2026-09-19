# KNOWLEDGE — discovered facts & decisions not in AGENTS.md (append-only)

- 2026-09-19 · uv 0.12.17 installed to `~/.local/bin` (was missing); system python is 3.14,
  `.python-version` pins 3.12 so uv provisions CPython 3.12 for the venv.
- 2026-09-19 · Added `hub/remember_hub/config.py` (typed loader for remember.toml) and
  `perception/drivers.py` (live-mode pollers) — small additions beyond the §4 layout,
  noted here because the layout says "build exactly this".
- 2026-09-19 · Mock face observations use normalized boxes with frame_wh=(1,1); the
  min_bbox_px=80 filter must be SKIPPED when frame width <= 1 (synthetic frames), else
  every mock face is rejected.
- 2026-09-19 · Timestamps: everything uses `time.time()` (wall epoch). Simpler than the
  monotonic/wall split for the demo; revisit only if clock jumps bite.
- 2026-09-19 · Mock face noise 0.03/dim over 512 dims ⇒ same-person cosine ≈ 0.80,
  cross-person ≈ 0.05 — realistically far above/below the 0.40 threshold. Don't "fix" it.
- 2026-09-19 · DESIGN DECISION: record/replay is PERCEPT-level (percepts.jsonl via
  REMEMBER_RECORD env in main.py). AV-frame recording deferred to morning — percept
  replay is what drives the brain deterministically and is the stage fallback.
- 2026-09-19 · DESIGN DECISION: hub does NOT yet scale blits to the hello display size
  (spec §5 says hub scales) — needs cv2/PIL which are extras; keyframes don't exist until
  M3 frames.py anyway. Noted as TODO in devicelink when Lane C's cv2 path lands.
- 2026-09-19 · Scenario `expect` asserts on display.action (task output), NOT
  display.current — so compositor priority arbitration can't mask a passing handler
  (meet_person: profile prio 10 loses the screen to the enroll confirmation prio 30,
  and that is correct behavior; the expect still passes).
- 2026-09-19 · Jev-mock probe lesson: a bus subscriber added AFTER the runner's own
  can't measure chain latency (whole cascade completes inside one publish) — the
  latency probe measures against the scenario's scripted question time instead.
- 2026-09-19 · Hub overhead question→answer = ~6 ms (mock jev). Real budget spenders
  will be Jev API (~100-300 ms) + STT final (~500 ms) — §12 budget holds with room.
