.PHONY: test test-ui lint fixtures fetch-local-models verify-local serve-ui serve-product-ui smoke enroll compare

test:
	uv run pytest -q

test-ui:
	node tools/perception_lab/static/tests/faces_guard_test.mjs
	node tools/perception_lab/static/remember/tests/run.mjs

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
	uv run --extra local --extra sim --extra lab --extra cloud python -m tools.perception_lab.server

serve-product-ui:
	uv run --extra lab --extra cloud python -m tools.perception_lab.server

compare:
	uv run --extra local --extra sim --extra cloud python scripts/compare_backends.py $(ARGS)

smoke:
	uv run --extra cloud python scripts/smoke_backends.py $(ARGS)

enroll:
	uv run --extra local --extra sim --extra cloud python scripts/enroll.py $(ARGS)
