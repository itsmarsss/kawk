"""Latency probe (AGENTS.md §10/§12): runs the keys scenario and prints the
measured legs. With mock backends this measures HUB overhead (world+gate+task);
run it again after flipping remember.toml to local/baseten for real numbers."""

from __future__ import annotations

import asyncio
import sys
import tempfile
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "hub"))

from remember_hub.config import load_config  # noqa: E402
from remember_hub.scenario import Scenario, ScenarioRunner  # noqa: E402


async def main() -> None:
    scenario = Scenario.load(REPO / "scenarios" / "keys.yaml")
    config = load_config(REPO / "remember.toml")
    with tempfile.TemporaryDirectory() as tmp:
        runner = ScenarioRunner(scenario, config, tmp)

        gate_t: list[float] = []
        runner.bus.subscribe("gate.result", lambda _r: _stamp(gate_t, runner))

        report = await runner.run()
        print(f"scenario: {report.name} ({'PASS' if report.passed else 'FAIL'})")
        # Measure against the SCRIPTED question time — a probe subscriber would only
        # run after the whole publish cascade and read ~0 ms.
        question_t = max((e.t for e in scenario.stt_events), default=None)
        answers = [
            (t, a) for t, a in runner.actions if a.card and a.card.template.value == "answer"
        ]
        if question_t is not None:
            gates_after = [t for t in gate_t if t >= question_t]
            if gates_after:
                print(
                    f"  question -> gate decision : {(gates_after[0] - question_t) * 1000:6.1f} ms"
                )
            answers_after = [t for t, _ in answers if t >= question_t]
            if answers_after:
                print(
                    f"  question -> answer card   : {(answers_after[0] - question_t) * 1000:6.1f} ms"
                )
        print(f"  display actions emitted   : {len(runner.actions)}")
        print("  budget (AGENTS.md section 12): end of question -> answer card < 1500 ms")


async def _stamp(sink: list[float], runner: ScenarioRunner) -> None:
    sink.append(runner.clock.now())


async def _noop() -> None:
    pass


if __name__ == "__main__":
    asyncio.run(main())
