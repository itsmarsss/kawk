"""User-initiated, consented webcam enrollment into the testing UI's buffalo_l gallery.

No camera is opened on import. This command is never executed by tests or setup.
"""

import argparse
import asyncio
import json
import os
import sys
import time
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]


async def enroll(args):
    try:
        import cv2
    except ImportError as exc:
        raise RuntimeError(
            "Install camera dependencies: uv sync --extra local --extra sim"
        ) from exc
    sys.path.insert(0, str(REPO))
    from tools.perception_lab.faces import FaceEngine, Gallery

    cloud = None
    engine = None
    if args.backend == "baseten":
        from baseten_smoke import api_key
        from remember_hub.perception.face.baseten_http import BasetenFaceBackend

        cloud = BasetenFaceBackend(args.model_id, api_key(args.native_profile))
    else:
        engine = await asyncio.to_thread(FaceEngine, args.model_root, args.provider)
    gallery = Gallery(args.gallery)
    camera = cv2.VideoCapture(args.camera)
    embeddings = []
    try:
        if not camera.isOpened():
            raise RuntimeError(
                "Camera unavailable. Choose its index and grant camera access to your terminal"
            )
        start = time.monotonic()
        while time.monotonic() - start < args.max_seconds and len(embeddings) < args.samples:
            ok, image = await asyncio.to_thread(camera.read)
            if not ok:
                raise RuntimeError("Camera returned no frame; check macOS camera permission/index")
            h, w = image.shape[:2]
            factor = min(1.0, 640 / max(w, h))
            if factor < 1:
                image = cv2.resize(image, (round(w * factor), round(h * factor)))
            h, w = image.shape[:2]
            ok, encoded = cv2.imencode(".jpg", image, [cv2.IMWRITE_JPEG_QUALITY, 85])
            if not ok:
                raise RuntimeError("Could not encode camera frame")
            jpeg = encoded.tobytes()
            if cloud is not None:
                faces = await cloud.embed_faces(jpeg, (w, h))
                count = cloud.last_detected_count
                vector = faces[0].embedding_512 if len(faces) == 1 else None
            else:
                result = await asyncio.to_thread(engine.infer, jpeg)
                count = result["detected_count"]
                faces = result["faces"]
                vector = faces[0]["embedding"] if len(faces) == 1 else None
            if count == 1 and vector is not None:
                embeddings.append(vector)
                print(
                    f"Accepted {len(embeddings)}/{args.samples} consented face samples", flush=True
                )
            else:
                embeddings.clear()
                print("Keep exactly one sufficiently large face visible; samples reset", flush=True)
            await asyncio.sleep(0.2)
        if len(embeddings) != args.samples:
            raise RuntimeError("Enrollment timed out without enough valid single-face samples")
        # Gallery validates cross-frame identity consistency and renormalizes centroid.
        person = gallery.enroll(args.name, embeddings)
        print(json.dumps({"enrolled": person, "model": "buffalo_l", "gallery": str(args.gallery)}))
    finally:
        camera.release()
        if cloud is not None:
            await cloud.aclose()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--name", required=True)
    parser.add_argument("--camera", type=int, required=True)
    parser.add_argument(
        "--consent", action="store_true", help="Person explicitly agreed to enrollment"
    )
    parser.add_argument("--backend", choices=("local", "baseten"), default="local")
    parser.add_argument(
        "--model-root",
        type=Path,
        default=Path(os.getenv("REMEMBER_FACE_MODEL_ROOT", str(REPO / "data"))),
    )
    parser.add_argument(
        "--gallery",
        type=Path,
        default=Path(
            os.getenv("REMEMBER_GALLERY_PATH", str(REPO / "tools/perception_lab/data/gallery.npz"))
        ),
    )
    parser.add_argument("--provider", default="CPUExecutionProvider")
    parser.add_argument("--model-id", default=os.getenv("BASETEN_FACE_MODEL_ID", "qvm6y6eq"))
    parser.add_argument("--native-profile", action="store_true")
    parser.add_argument("--samples", type=int, choices=range(5, 11), default=7)
    parser.add_argument("--max-seconds", type=float, default=30)
    args = parser.parse_args()
    if not args.consent:
        parser.error("Explicit --consent is required; do not enroll anyone without their agreement")
    asyncio.run(enroll(args))


if __name__ == "__main__":
    main()
