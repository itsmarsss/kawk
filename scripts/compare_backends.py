"""Replay one input through local/cloud backends, serially, with separate timings."""
from __future__ import annotations

import argparse
import asyncio
import hashlib
import inspect
import json
import os
import platform
import time
import wave
from pathlib import Path

import numpy as np
from remember_hub.backends import create_face, create_sam, create_stt
from remember_hub.config import load_settings


def stats(values):
    finite = [float(value) for value in values if value is not None]
    if not finite:
        return None
    return {"n": len(finite), "median": float(np.median(finite)),
            "p95": float(np.percentile(finite, 95)), "min": min(finite), "max": max(finite)}


async def finish(backend):
    for name in ("aclose", "close", "end_session"):
        if method := getattr(backend, name, None):
            result = method()
            if inspect.isawaitable(result):
                await result
            return


async def measure_frames(args, settings):
    import cv2

    jpeg = args.input.read_bytes()
    frame = cv2.imdecode(np.frombuffer(jpeg, dtype=np.uint8), cv2.IMREAD_COLOR)
    if frame is None:
        raise ValueError("Input must be a JPEG")
    wh = (int(frame.shape[1]), int(frame.shape[0]))
    if args.component == "face" and max(wh) > 640:
        raise ValueError("Use one shared JPEG with longest side <=640 for both face backends")
    backend = create_face(settings) if args.component == "face" else create_sam(settings)
    started = time.perf_counter()
    try:
        if args.component == "objects":
            await backend.start_session(settings.sam.vocabulary)
        elif loader := getattr(backend, "load", None):
            await loader()
        setup_ms = (time.perf_counter() - started) * 1000
        runs = []
        for index in range(args.runs + 1):
            started = time.perf_counter()
            if args.component == "face":
                rows = await backend.embed_faces(jpeg, wh)
            else:
                rows = await backend.push_frame(str(index), jpeg, wh)
            runs.append({"request_ms": (time.perf_counter() - started) * 1000, "count": len(rows),
                         "accepted": getattr(backend, "last_frame_accepted", True),
                         "drop_reason": getattr(backend, "last_drop_reason", None),
                         "labels": [row.label for row in rows] if args.component == "objects" else None,
                         "timings_ms": dict(getattr(backend, "last_timings_ms", {}))})
        return {"input_wh": wh, "input_bytes": len(jpeg), "setup_ms": setup_ms,
                "model_load_ms": getattr(backend, "load_ms", None), "first_call": runs[0],
                "warm_request_ms": stats([row["request_ms"] for row in runs[1:] if row["accepted"]]), "warm_runs": runs[1:],
                "completed": all(row["accepted"] for row in runs[1:]),
                "streaming_mode": getattr(backend, "streaming_mode", None),
                "tracking_persistent": getattr(backend, "tracking_persistent", None)}
    finally:
        await finish(backend)


async def measure_speech(args, settings):
    with wave.open(str(args.input)) as wav:
        if (wav.getnchannels(), wav.getsampwidth(), wav.getframerate()) != (1, 2, 16000):
            raise ValueError("Use a 16kHz mono PCM16 WAV for both speech backends")
        pcm = wav.readframes(wav.getnframes())
    samples = np.frombuffer(pcm, dtype="<i2").astype(np.int32)
    active = np.flatnonzero(np.abs(samples) > 250)
    if not active.size:
        raise ValueError("Input contains no speech above the measurement threshold")
    onset_s, offset_s = float(active[0] / 16000), float(active[-1] / 16000)
    padded = pcm + bytes(32000)  # Explicit one-second tail permits VAD finalization.
    backend = create_stt(settings)
    started = time.perf_counter()
    try:
        if loader := getattr(backend, "load", None):
            await loader()
        setup_ms = (time.perf_counter() - started) * 1000
        runs = []
        for _ in range(args.runs + 1):
            origin = None
            first_partial = None
            final_times = []
            final_texts = []

            async def chunks():
                nonlocal origin
                origin = time.perf_counter()
                for cursor in range(0, len(padded), 1024):
                    await asyncio.sleep(max(0, origin + cursor / 32000 - time.perf_counter()))
                    yield padded[cursor:cursor + 1024].ljust(1024, b"\0")

            async with asyncio.timeout(len(padded) / 32000 + 60):
                async for row in backend.stream(chunks()):
                    if origin is None or not row.text.strip():
                        continue
                    now = time.perf_counter()
                    if row.is_final:
                        final_texts.append(row.text)
                        final_times.append((now - origin - offset_s) * 1000)
                    elif first_partial is None:
                        first_partial = (now - origin - onset_s) * 1000
            runs.append({"first_partial_after_onset_ms": first_partial,
                         "last_final_after_offset_ms": final_times[-1] if final_times else None,
                         "final_text": " ".join(final_texts),
                         "backend_timings_ms": dict(getattr(backend, "last_timings_ms", {}))})
        return {"sample_rate": 16000, "chunk_samples": 512, "input_duration_s": len(pcm) / 32000,
                "onset_s": onset_s, "offset_s": offset_s, "setup_ms": setup_ms,
                "first_trial": runs[0], "warm_runs": runs[1:],
                "completed": all(row["final_text"].strip() for row in runs[1:]),
                "warm_partial_ms": stats([r["first_partial_after_onset_ms"] for r in runs[1:]]),
                "warm_final_ms": stats([r["last_final_after_offset_ms"] for r in runs[1:]])}
    finally:
        await finish(backend)


async def run(args):
    # Use only the previously authorized permanent profile; never the reserve account.
    if "baseten" in args.backends and not os.getenv("BASETEN_API_KEY"):
        path = Path.home() / "Library/Application Support/baseten/auth.json"
        try:
            os.environ["BASETEN_API_KEY"] = json.loads(path.read_text())["profiles"]["h100-permanent"]["api_key"]
        except (OSError, KeyError, ValueError) as exc:
            raise RuntimeError("Set BASETEN_API_KEY or configure the h100-permanent profile") from exc
    report = {"component": args.component, "host": platform.platform(), "python": platform.python_version(),
              "input_name": args.input.name, "input_sha256": hashlib.sha256(args.input.read_bytes()).hexdigest(),
              "method": "Serial replay of identical input. First call/trial excluded from warm stats; not a controlled cloud cold start. Speech onset/offset uses absolute PCM amplitude >250, not human annotation.",
              "results": {}}
    for name in args.backends:
        settings = load_settings(args.config)
        getattr(settings, {"objects": "sam", "speech": "stt"}.get(args.component, args.component)).backend = name
        print(f"Measuring {args.component} with {name}", flush=True)
        try:
            report["results"][name] = await (measure_speech(args, settings) if args.component == "speech"
                                             else measure_frames(args, settings))
        except Exception as exc:
            # Never serialize cloud errors containing headers or signed URLs.
            report["results"][name] = {"error_type": type(exc).__name__, "completed": False}
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(report, indent=2) + "\n")
    print(f"Saved {args.output}")
    return int(any("error_type" in value or value.get("completed") is False for value in report["results"].values()))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("component", choices=["face", "objects", "speech"])
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--config", type=Path, default=Path("remember.toml"))
    parser.add_argument("--backends", nargs="+", choices=["local", "baseten"], default=["local", "baseten"])
    parser.add_argument("--runs", type=int, default=5)
    arguments = parser.parse_args()
    if not 1 <= arguments.runs <= 30:
        parser.error("--runs must be between 1 and 30")
    raise SystemExit(asyncio.run(run(arguments)))
