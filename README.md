# Remember — hub brain + device edge (Lanes A/B)

This branch (`chud1`) carries **Lane A (Brain)** and **Lane B (Edge)** of the
[AGENTS.md](AGENTS.md) build: the complete hub pipeline — device link → world model →
Jev gate → task handlers → display — running end-to-end against scenario-driven mocks,
with zero API keys and zero hardware. Perception backends (Lane C local, Lane D
Baseten/TypeSafe) plug into the frozen interfaces here; see `INTEGRATION.md`.

```
device ──WS──► DeviceLink ──► WorldModel ──snapshot──► Jev gate ──► TaskHandlers
 (sim)         (edge, B)      tracks/last-seen         question      find/enroll/
                              identity votes           bank + ticks  identify/notes
                                                                        │
 display ◄──── cards/blits ◄── Compositor ◄──── DisplayAction ◄─────────┘
```

## Run it (fresh clone, core deps only)

```bash
uv sync
make test        # 20 tests: unit + 4 integration e2e (~45 s)
make demo        # acceptance bar: "where are my keys" → answer card, all mocks
make hub         # real hub on ws://0.0.0.0:8765 (mock backends)
make sim-headless  # fixture device streaming into it (no camera/mic needed)
```

`make demo` output: `Keys — Last seen near desk — 6 s ago (…)`. The second scenario
(`uv run python -m remember_hub.scenario scenarios/meet_person.yaml`) walks the full
enroll flow: unknown face → "Who is this?" → *"this is Sarah"* → gallery enroll →
re-identified → profile card.

## What's implemented and how it's verified

| Piece | Where | Verified by |
|---|---|---|
| Wire codec (type-conditional header, u16 seq wrap, ts_ms) | `contracts/wire.py` | `test_wire.py` |
| World model: IoU-deduped tracks, 1 s coasting, 2 s track-end → last-seen index | `world/` | keys e2e |
| Attribute derivation (zone / proximity / dwell / held-by / co-visible) | `world/snapshot.py` | unit + e2e |
| Jev gate: question bank, reactive ticks + 1 s heartbeat, debounce, addressed-gating | `gate/` | both e2e |
| Tasks: find_object, identify, enroll (2-phase + name extraction), notes, clear | `tasks/` | meet_person e2e |
| Face gallery: 512-d numpy, cosine ≥ 0.40, model-tag hard-fail, persistence | `memory/faces.py` | `test_units.py` |
| DeviceLink WS server: hello/config, newest-wins frame slot, card+blit tx | `devicelink/` | `test_devicelink.py` |
| Full hub boot + headless sim streaming through it | `main.py` (`build_hub`) | `test_hub_boot.py` |
| Record → replay (the stage fallback) | `scripts/record.py` / `replay.py` | `test_replay.py` (subprocess) |
| Latency probe | `scripts/latency_probe.py` | run it: ~6 ms hub overhead |

**Honest gaps (by design, not oversight):** live `make sim` (webcam/mic/pygame window)
is written but needs a human to grant macOS camera+mic permission to the terminal —
morning checklist. Keyframe images on answer cards need `memory/frames.py` (Lane C's
M3). `mock` STT/SAM emit nothing outside scenarios, so `make hub` is a wire test bench
until local/Baseten backends land.

## For Lane C/D (teammate)

`git pull origin chud1`. Implement against `perception/*/base.py` + `gate/jev_base.py`;
the factories in each `__init__.py` already name your modules and classes. Wiring
notes, STT/VAD expectations, and the frames.py hook point are in `INTEGRATION.md`.
Config flips per service in `remember.toml` (`mock | local | baseten`); env keys in
`.env.example`.

## Privacy / consent

Always-on camera + mic with face recognition: enrollment is **explicit verbal opt-in**
("Who is this?" → the person states their name), `make demo` data is fully synthetic,
recordings stay on the demo machine. InsightFace weights are research-use only — this
is a hackathon prototype.

## Dashboard

`make hub` also serves **http://127.0.0.1:8090** — live camera feed (MJPEG), per-device
fps/frame stats, the current display card, and recent display actions — plus testing
controls: flip the view (↔/↕, per-browser), snapshot (`/frame.jpg`), and **live device
config push** (resolution / fps / quality → `/control` → hub pushes a §5 config message
→ the Pi restarts its camera pipeline in ~2 s, no service restarts). Pin one device with
`/stream?device=<id>`. Source-side flips for a physically rotated rig:
`rpi_device.py --hflip/--vflip`. Config under `[dashboard]` in remember.toml.

Measured on the rig: 720p24 holds (~14 Mbit/s); 1080p24 produces real 1080p frames but
the hotspot caps throughput → ~12 fps and TCP misery. The hardware encoder is not the
limit — the venue WiFi is. Stay at 720p24 unless on good WiFi.
