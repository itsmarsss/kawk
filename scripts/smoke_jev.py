"""One real TypeSafe request, only with explicit --live and an environment key."""

import argparse
import asyncio
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "hub"))

from remember_hub.contracts.decisions import GateQuestion  # noqa: E402
from remember_hub.gate.jev_typesafe import JevError, TypeSafeJevBackend  # noqa: E402


async def smoke(api_key: str, model: str, timeout: float) -> dict:
    bank = [
        GateQuestion(key="addressed", kind="noul",
                     instructions="The latest speech directly asks the assistant for help."),
        GateQuestion(key="intent", kind="choice", instructions="What is the requested action?",
                     choices=["FIND_OBJECT", "NONE"]),
        GateQuestion(key="urgency", kind="score", instructions="How urgent is the request?",
                     choices=["routine", "urgent", "emergency"]),
    ]
    async with TypeSafeJevBackend(api_key, model, timeout_seconds=timeout) as backend:
        answers = await backend.decide(
            'TRANSCRIPT: [user] "Assistant, where are my keys?"\n'
            'OBJECTS: keys near desk. SPEECH addressed-to-device.', bank,
        )
        return {
            "live_request": True, "model": backend.last_model,
            "answers": [answer.model_dump() for answer in answers],
            "timings_ms": backend.last_timings_ms,
            "verification": "HTTP/schema smoke only; not accuracy or latency acceptance.",
        }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--live", action="store_true", help="Send one synthetic request to TypeSafe")
    parser.add_argument("--model", default="jev-1.13.0")
    parser.add_argument("--timeout", type=float, default=5.0)
    args = parser.parse_args()
    if not args.live:
        parser.error("No request sent. Pass --live to run the credentialed smoke test.")
    key = os.environ.get("TYPESAFE_API_KEY", "")
    if not key.strip():
        parser.error("No request sent. Set TYPESAFE_API_KEY in the environment.")
    try:
        result = asyncio.run(smoke(key, args.model, args.timeout))
    except (JevError, ValueError) as error:
        print(f"Jev smoke failed: {error}", file=sys.stderr)
        return 1
    print(json.dumps(result, indent=2, allow_nan=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
