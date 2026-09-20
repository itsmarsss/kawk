UV ?= uv

.PHONY: demo test lint typecheck hub sim sim-headless fixtures fetch-local-models enroll vapid pwa-icons

demo:
	$(UV) run python -m remember_hub.scenario scenarios/keys.yaml

test:
	$(UV) run pytest -q

lint:
	$(UV) run ruff check hub devices scripts
	$(UV) run ruff format --check hub devices scripts

typecheck:
	$(UV) run pyright

hub:
	$(UV) run python -m remember_hub.main

sim:
	$(UV) run --extra sim python devices/sim/sim_device.py

sim-headless:
	$(UV) run python devices/sim/sim_device.py --headless --fixtures scenarios/assets/simfix

# Lane C owns the bodies of these two scripts (AGENTS.md section 13.1)
fixtures:
	$(UV) run python scripts/make_fixtures.py

fetch-local-models:
	$(UV) run python scripts/fetch_local_models.py

# Lane D owns enroll.py
enroll:
	$(UV) run --extra sim --extra local python scripts/enroll.py

# PWA notification tier (devices/pwa/README.md)
vapid:
	$(UV) run --extra pwa python scripts/gen_vapid.py

pwa-icons:
	$(UV) run python scripts/gen_pwa_icons.py
