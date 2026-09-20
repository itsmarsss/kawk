"""Run explicit KAWK replay benchmarks; cloud inference is never the default."""
from __future__ import annotations

import argparse
import asyncio
import json
from pathlib import Path


def write_report(path: Path, report: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(report, indent=2, allow_nan=False) + "\n")
    print(f"Report: {path}")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    policy = commands.add_parser("policy", help="Actual app policies with controlled inputs; no inference")
    policy.add_argument("--output", type=Path, required=True)
    policy.add_argument("--allow-known-gaps", action="store_true",
                        help="Permit documented gaps in exit status; they remain failed in the report")
    trace = commands.add_parser("trace", help="Score annotated model/system JSONL spans")
    trace.add_argument("--input", type=Path, required=True)
    trace.add_argument("--output", type=Path, required=True)
    component = commands.add_parser("component", help="Real serial model replay; Baseten is opt-in")
    component.add_argument("component", choices=["face", "objects", "speech"])
    component.add_argument("--input", type=Path, required=True)
    component.add_argument("--output", type=Path, required=True)
    component.add_argument("--config", type=Path, default=Path("remember.toml"))
    component.add_argument("--backends", nargs="+", choices=["local", "baseten"], default=["local"])
    component.add_argument("--runs", type=int, default=5)
    args = parser.parse_args()
    if args.command == "policy":
        from .policy import policy_exit_code, run_policy_suite
        report = asyncio.run(run_policy_suite())
        write_report(args.output, report)
        print(json.dumps(report["summary"], sort_keys=True))
        return policy_exit_code(report, allow_known_gaps=args.allow_known_gaps)
    if args.command == "trace":
        from .trace import evaluate_trace
        report = evaluate_trace(args.input)
        write_report(args.output, report)
        print(json.dumps(report["outcomes"], sort_keys=True))
        return int(not report["trace_count"] or any(
            name != "correct" and count for name, count in report["outcomes"].items()))
    if not 1 <= args.runs <= 30:
        parser.error("--runs must be between 1 and 30")
    from scripts.compare_backends import run

    from .metadata import component_metadata
    metadata = component_metadata(args)
    result = asyncio.run(run(args))
    report = json.loads(args.output.read_text())
    report["benchmark"] = metadata
    write_report(args.output, report)
    return result


if __name__ == "__main__":
    raise SystemExit(main())
