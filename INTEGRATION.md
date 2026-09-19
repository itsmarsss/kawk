# INTEGRATION.md — cross-lane scratch (AGENTS.md §13.1)

Frozen after `m0`: `hub/remember_hub/contracts/`, every `perception/*/base.py`, and
`gate/jev_base.py`. Request changes under the first heading; only the integrator (Lane A)
applies them and announces here.

## Contract-change requests

(none)

## Done

- `m0` — scaffold + contracts + base interfaces + Makefile/pyproject (Lane A/B side)

## Blocked

(none)

## Notes for Lane C/D

- Makefile targets `fixtures`, `fetch-local-models`, `enroll` reference
  `scripts/make_fixtures.py`, `scripts/fetch_local_models.py`, `scripts/enroll.py` —
  those files are yours to create; targets are pre-declared so the Makefile never changes.
- Backend factories live in `perception/<svc>/__init__.py` — add your `local`/`baseten`
  branch inside the existing `create_*_backend()` lazy-import structure; do not edit
  `base.py` or `mock.py`.
