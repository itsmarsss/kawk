# Remember

Always-on AI wearable prototype — Hack the North 2026. A device (laptop sim today;
phone / Pi / ESP32-S3 glasses later) streams camera + mic to a Python hub, which runs
perception on Baseten H100s (SAM 3.1 · InsightFace · streaming Whisper), folds everything
into a world model, asks TypeSafe's **Jev** what matters right now, and pushes answer
cards to the device's mini display. No button press, no wake word.
Full spec: **AGENTS.md**.

## Quickstart (zero keys, zero hardware)

```bash
uv sync            # core deps only
make test          # full suite (~35 s; includes two e2e scenarios)
make demo          # the acceptance bar: "where are my keys" end-to-end, all mocks
```

`make demo` prints the answer card: `Keys — Last seen near desk — 6 s ago (…)`.

## Live status

| Milestone | State |
|---|---|
| M0 contracts + scaffold (`m0`) | done |
| M2a keys path — `make demo` green (`m2a`) | done |
| M2b enroll → re-identify (`m2b`) | done |
| M1 devicelink + headless sim (`m1`) | done |
| M5a record/replay + latency probe | done (percept-level) |
| M3 local backends (Lane C) | teammate |
| M4 Baseten/TypeSafe adapters + Trusses (Lane D) | teammate |
| Live webcam/mic sim (TCC), phone page, ESP32 | morning checklist |

## The 3-minute demo script

1. `make hub` in one terminal, `make sim` in another (webcam + mic + display window).
2. Put your keys on the desk, in view. Wait a beat. Walk them out of frame.
3. Say, to the air: **"where are my keys?"** → answer card with location + time.
4. Have a teammate walk up. Display prompts **"Who is this?"** → they say their name →
   card confirms. They leave and return → their profile card appears on its own.
5. Say **"remember that Sarah owes me ten dollars"** → later: **"what did I note about
   Sarah?"**

Fallback ladder (one-line `remember.toml` flips): `baseten` → `local` → `mock` →
`scripts/replay.py` of a rehearsal recording.

## Toolbox

```bash
make sim-headless                      # fixture-driven device, no camera needed
uv run python scripts/latency_probe.py # measured legs vs AGENTS.md §12 budgets
uv run python scripts/record.py out/   # record live percepts
uv run python scripts/replay.py out/   # replay them through the real brain
```

## Privacy / consent note

This prototype runs an always-on camera and microphone with face recognition.
Demo policy: face **enrollment is explicit verbal opt-in only** ("Who is this?" →
the person states their name to the device), `make demo` uses fully synthetic data,
and recordings stay on the demo machine. InsightFace pretrained weights are
research-use only — this is a hackathon prototype, not a product.
