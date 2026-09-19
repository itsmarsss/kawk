"""Sequential JPEG replay through the real SAM WS endpoint, never a camera capture."""

import argparse
import asyncio
import json
import os
import time
from pathlib import Path

from baseten_smoke import api_key
from remember_hub.perception.sam.baseten_ws import BasetenSamBackend


async def run(args):
    backend = BasetenSamBackend(
        args.model_id,
        api_key(args.native_profile),
        allow_windowed=args.allow_windowed,
        response_timeout_s=args.timeout,
    )
    try:
        await backend.start_session(args.concepts)
        print(
            json.dumps(
                {
                    "streaming_mode": backend.streaming_mode,
                    "tracking_persistent": backend.tracking_persistent,
                }
            )
        )
        for index, path in enumerate(args.jpeg):
            started = time.perf_counter()
            result = await backend.push_frame(
                str(index), path.read_bytes(), (args.width, args.height)
            )
            print(
                json.dumps(
                    {
                        "frame": index,
                        "generation": backend.generation,
                        "objects": [x.model_dump() for x in result],
                        "request_seconds": time.perf_counter() - started,
                        "timings_ms": backend.last_timings_ms,
                    }
                ),
                flush=True,
            )
    finally:
        await backend.end_session()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--jpeg", type=Path, nargs="+", required=True)
    parser.add_argument("--width", type=int, required=True)
    parser.add_argument("--height", type=int, required=True)
    parser.add_argument("--concepts", nargs="+", default=["person", "phone", "cup"])
    parser.add_argument("--model-id", default=os.getenv("BASETEN_SAM_MODEL_ID", ""))
    parser.add_argument("--native-profile", action="store_true")
    parser.add_argument("--allow-windowed", action="store_true")
    parser.add_argument("--timeout", type=float, default=10)
    asyncio.run(run(parser.parse_args()))
