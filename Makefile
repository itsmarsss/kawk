.PHONY: test lint fixtures fetch-local-models verify-local serve-ui smoke enroll

test:
	uv run pytest -q

lint:
	uv run ruff check hub scripts deployments
	uv run pyright

fixtures:
	uv run python scripts/make_fixtures.py

fetch-local-models:
	uv run --extra local --extra sim python scripts/fetch_local_models.py

verify-local:
	uv run --extra local --extra sim python scripts/verify_local.py

serve-ui:
	uv run --extra local --extra sim --extra lab python -m tools.perception_lab.server

smoke:
	uv run --extra cloud python scripts/smoke_backends.py

enroll:
	uv run --extra local --extra sim python scripts/enroll.py $(ARGS)
