"""Scenario e2e — the acceptance bar (AGENTS.md §10). Wall-clock, ~14 s each."""

from pathlib import Path

from remember_hub.scenario import run_scenario

REPO = Path(__file__).resolve().parents[2]


async def test_keys_scenario():
    report = await run_scenario(REPO / "scenarios" / "keys.yaml")
    assert report.passed, "\n".join(report.lines)


async def test_meet_person_scenario():
    report = await run_scenario(REPO / "scenarios" / "meet_person.yaml")
    assert report.passed, "\n".join(report.lines)
