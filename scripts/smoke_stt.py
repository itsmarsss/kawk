"""Send an explicit16kHz mono PCM16 WAV in real time; never opens a microphone."""

import argparse
import asyncio
import json
import os
import wave
from pathlib import Path

from baseten_smoke import api_key
from remember_hub.perception.stt.baseten_ws import BasetenWhisperBackend


async def run(args):
    with wave.open(str(args.wav), "rb") as wav:
        if (wav.getnchannels(), wav.getsampwidth(), wav.getframerate()) != (1, 2, 16000):
            raise ValueError("Provide16kHz mono PCM16 WAV")
        pcm = wav.readframes(wav.getnframes())

    async def audio():
        for _ in range(args.repeats):
            for offset in range(0, len(pcm), 1024):
                yield pcm[offset : offset + 1024]
                await asyncio.sleep(0.032)
            for _ in range(32):
                yield bytes(1024)
                await asyncio.sleep(0.032)

    raw_messages = []

    async def capture_connect(*pos, **kwargs):
        import websockets

        upstream = await websockets.connect(*pos, **kwargs)

        class Capture:
            async def send(self, value):
                await upstream.send(value)

            async def close(self):
                await upstream.close()

            def __aiter__(self):
                return self

            async def __anext__(self):
                value = await upstream.recv()
                if len(raw_messages) < 64:
                    raw_messages.append(json.loads(value))
                return value

        return Capture()

    backend = BasetenWhisperBackend(
        args.model_id,
        api_key(args.native_profile),
        connector=capture_connect if args.raw_output else None,
    )
    results = []
    async with asyncio.timeout(args.timeout):
        async for segment in backend.stream(audio()):
            record = segment.model_dump()
            results.append(record)
            print(json.dumps(record), flush=True)
    summary = {
        "segments": results,
        "timings_ms": backend.last_timings_ms,
        "timestamp_mode": backend.timestamp_mode,
        "connection_generation": backend.connection_generation,
        "dropped_audio_frames": backend.dropped_audio_frames,
    }
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(summary, indent=2) + "\n")
    if args.raw_output:
        args.raw_output.parent.mkdir(parents=True, exist_ok=True)
        args.raw_output.write_text(json.dumps(raw_messages, indent=2) + "\n")
    if not any(x["is_final"] for x in results):
        raise RuntimeError("Smoke failed: no final transcript received")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--wav", type=Path, required=True)
    parser.add_argument("--model-id", default=os.getenv("BASETEN_STT_MODEL_ID", "wdlg2oe3"))
    parser.add_argument("--native-profile", action="store_true")
    parser.add_argument("--repeats", type=int, default=1)
    parser.add_argument("--timeout", type=float, default=60)
    parser.add_argument("--output", type=Path)
    parser.add_argument(
        "--raw-output", type=Path, help="Optional transcript-only protocol evidence"
    )
    asyncio.run(run(parser.parse_args()))
