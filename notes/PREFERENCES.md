# Working preferences (read on every session resume, after AGENTS.md)

- Branch: `chud1` (worktree `.claude/worktrees/chud1`). Never force-push; never push to main.
- Commits: semantic, one line, imperative ("feat: …", "fix: …", "docs: …", "test: …",
  "chore: …"). **No self-credit — no Co-Authored-By, no "Generated with" trailers.**
- `make test` green before every commit. Tag milestones: `m0`, `m2a`, `m2b`, `m1`, `m5a`.
- We (this machine) own **Lanes A + B** (AGENTS.md §13.1). Teammate owns Lanes C + D on a
  separate machine. NEVER create: `perception/*/local_*.py`, `perception/*/baseten_*.py`,
  `gate/jev_typesafe.py`, `deployments/`, `scripts/smoke_*.py`, `scripts/enroll.py`,
  `scripts/fetch_local_models.py`, `scripts/make_fixtures.py`.
- Contracts (`contracts/`, `*/base.py`, `gate/jev_base.py`) frozen after `m0` — changes go
  through INTEGRATION.md; we are the integrator.
- `uv` lives at `~/.local/bin/uv` (export PATH in fresh shells).
- **STORAGE RULE (user directive): if disk runs out, NEVER delete anything outside this
  repo/worktree. In-repo caches (.venv, .pytest_cache, .ruff_cache, data/) are fair game.
  If that isn't enough — STOP and consult the user. No exceptions.**
