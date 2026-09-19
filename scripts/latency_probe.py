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

        stt_final_t: list[float] = []
        gate_t: list[float] = []
        runner.bus.subscribe(
            "percepts.stt",
            lambda seg: _stamp(stt_final_t, runner) if seg.is_final else _noop(),
        )
        runner.bus.subscribe("gate.result", lambda _r: _stamp(gate_t, runner))

        report = await runner.run()
        print(f"scenario: {report.name} ({'PASS' if report.passed else 'FAIL'})")
        if stt_final_t and gate_t:
            gates_after = [t for t in gate_t if t >= stt_final_t[0]]
            if gates_after:
                print(
                    f"  question final -> gate decision : {(gates_after[0] - stt_final_t[0]) * 1000:6.1f} ms"
                )
        answers = [
            (t, a) for t, a in runner.actions if a.card and a.card.template.value == "answer"
        ]
        if stt_final_t and answers:
            print(
                f"  question final -> answer card    : {(answers[0][0] - stt_final_t[0]) * 1000:6.1f} ms"
            )
        print(f"  display actions emitted          : {len(runner.actions)}")
        print("  budget (AGENTS.md section 12): end of question -> answer card < 1500 ms")


async def _stamp(sink: list[float], runner: ScenarioRunner) -> None:
    sink.append(runner.clock.now())


async def _noop() -> None:
    pass


if __name__ == "__main__":
    asyncio.run(main())
