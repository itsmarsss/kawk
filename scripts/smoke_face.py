"""One explicit HTTP request to the existing buffalo_l endpoint; no deployment changes."""

import argparse
import asyncio
import json
import os
from pathlib import Path

from baseten_smoke import api_key
from remember_hub.perception.face.baseten_http import BasetenFaceBackend


async def run(args):
    backend = BasetenFaceBackend(args.model_id, api_key(args.native_profile))
    try:
        faces = await backend.embed_faces(args.jpeg.read_bytes(), (args.width, args.height))
        print(
            json.dumps(
                {
                    "faces": len(faces),
                    "model": "buffalo_l",
                    "boxes": [x.box for x in faces],
                    "timings_ms": backend.last_timings_ms,
                }
            )
        )
    finally:
        await backend.aclose()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--jpeg", type=Path, required=True)
    parser.add_argument("--width", type=int, required=True)
    parser.add_argument("--height", type=int, required=True)
    parser.add_argument("--model-id", default=os.getenv("BASETEN_FACE_MODEL_ID", "qvm6y6eq"))
    parser.add_argument("--native-profile", action="store_true")
    asyncio.run(run(parser.parse_args()))
