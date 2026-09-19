# PROGRESS — Lanes A + B (update after every commit; source of truth across compactions)

> Session resume order: AGENTS.md → notes/PREFERENCES.md → this file → notes/KNOWLEDGE.md.

## M0 — scaffold + contract freeze (phase 0)
- [x] worktree `chud1`, uv installed
- [ ] pyproject (core/extras split) + Makefile + remember.toml + .env.example
- [ ] contracts/ (percepts, world, decisions, display, wire) + bus + branding + config
- [ ] perception base.py x3 + vocab_proposer stub + jev_base
- [ ] uv sync (core) + make test green → commit + tag `m0`

## M2a — keys path (acceptance bar)
- [ ] mocks: sam / face / stt (scenario-driven) + scenario clock
- [ ] world: model + tracks (IoU, coasting, LastSeen freeze) + snapshot (buckets)
- [ ] memory: store.py (sqlite) + faces.py (gallery, model-tag check)
- [ ] gate: questions bank + policy (ticks, debounce) + jev_mock
- [ ] tasks: find_object + clear_display + router; display: compositor
- [ ] scenario runner + scenarios/keys.yaml → **`make demo` GREEN** → tag `m2a`

## M2b — remaining handlers
- [ ] enroll_person (state machine + name extraction) + identify_person + notes
- [ ] scenarios/meet_person.yaml green → tag `m2b`

## M1 — devicelink + sim (Lane B)
- [ ] wire codec unit tests (type-conditional header, seq wrap, ts_ms)
- [ ] WS server + device registry + config push; main.py live wiring
- [ ] headless sim from fixture files e2e → tag `m1`

## M5a — polish
- [ ] record/replay, latency_probe, README demo script

## Done log
(append: date · commit · what)
