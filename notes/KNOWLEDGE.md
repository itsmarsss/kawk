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
