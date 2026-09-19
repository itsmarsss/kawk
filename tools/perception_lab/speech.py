"""Verified Baseten streaming Whisper protocol, no keys in client responses."""
import json
import os
from pathlib import Path

MODEL_ID = os.getenv("BASETEN_STT_MODEL_ID", "wdlg2oe3")
METADATA = {
    "streaming_vad_config": {"threshold": 0.5, "min_silence_duration_ms": 300, "speech_pad_ms": 30},
    "streaming_params": {"encoding": "pcm_s16le", "sample_rate": 16000,
                         "enable_partial_transcripts": True, "partial_transcript_interval_s": 0.5,
                         "final_transcript_max_duration_s": 30},
    "whisper_params": {"audio_language": "en", "show_word_timestamps": True},
}


def read_key():
    if os.getenv("BASETEN_API_KEY"):
        return os.environ["BASETEN_API_KEY"]
    try:
        data = json.loads((Path.home() / "Library/Application Support/baseten/auth.json").read_text())
        return data["profiles"]["h100-permanent"]["api_key"]
    except (OSError, KeyError, ValueError) as error:
        raise RuntimeError("Configure the h100-permanent Baseten profile or BASETEN_API_KEY on the Mac server") from error


def transcript_event(raw):
    data = json.loads(raw)
    if data.get("type") != "transcription":
        return None
    segments = data.get("segments", [])
    return {"type": "transcript", "segment_id": str(data.get("transcription_num", 0)),
            "text": " ".join(segment.get("text", "").strip() for segment in segments).strip(),
            "is_final": bool(data.get("is_final")),
            "words": [word for segment in segments for word in segment.get("word_timestamps", [])]}


async def cloud_speech_socket(ws, *, max_session_s=600):
    """Relay one connection; disconnect/Stop also cancels a cloud cold start."""
    import asyncio
    import contextlib
    import time

    import websockets
    from fastapi import WebSocketDisconnect

    tasks = []
    upstream = None
    opening = None

    async def error(message, *, retryable=True):
        with contextlib.suppress(WebSocketDisconnect, RuntimeError):
            await ws.send_json({"type": "error", "message": message, "retryable": retryable})

    try:
        try:
            key = read_key()
        except RuntimeError as exc:
            await error(str(exc), retryable=False)
            return
        await ws.send_json({"type": "connecting", "timeout_s": 120})
        started = time.perf_counter()
        url = f"wss://model-{MODEL_ID}.api.baseten.co/environments/production/websocket"

        async def connect():
            return await websockets.connect(url, additional_headers={"Authorization": "Bearer " + key},
                                            open_timeout=120, close_timeout=3, compression=None,
                                            max_size=2_000_000, max_queue=4)

        opening = asyncio.create_task(connect())
        first_message = asyncio.create_task(ws.receive())
        tasks.extend((opening, first_message))
        done, _ = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
        if first_message in done:
            # Audio is subscribed only after ready. Stop/disconnect must not leave
            # an orphaned 120-second cloud attempt behind when the browser retries.
            message = first_message.result()
            if message["type"] != "websocket.disconnect":
                control = json.loads(message.get("text") or "{}")
                if not isinstance(control, dict) or control.get("type") != "stop":
                    await error("Wait for speech to be ready before sending audio", retryable=False)
            return
        upstream = await opening
        await asyncio.wait_for(upstream.send(json.dumps(METADATA)), timeout=5)
        await ws.send_json({"type": "ready", "backend": "baseten", "model": "Whisper Large v3 streaming",
                            "connect_ms": (time.perf_counter() - started) * 1000,
                            "sample_rate": 16000, "chunk_samples": 512,
                            "model_id": MODEL_ID, "max_session_s": max_session_s})
        connected = time.perf_counter()

        async def send_audio():
            message = await first_message
            while True:
                if message["type"] == "websocket.disconnect":
                    return "disconnected"
                if message.get("bytes") is not None:
                    chunk = message["bytes"]
                    if len(chunk) != 1024:
                        raise ValueError("Audio must be exactly 512 samples of 16 kHz mono PCM16 (1024 bytes)")
                    await asyncio.wait_for(upstream.send(chunk), timeout=1.5)
                elif message.get("text") is not None:
                    control = json.loads(message["text"])
                    if isinstance(control, dict) and control.get("type") == "stop":
                        return "stop"
                    raise ValueError("Unknown speech control")
                message = await ws.receive()

        async def receive_text():
            async for raw in upstream:
                event = transcript_event(raw)
                if event is not None:
                    event["hub_received_ms"] = (time.perf_counter() - connected) * 1000
                    await ws.send_json(event)

        sender = asyncio.create_task(send_audio())
        receiver = asyncio.create_task(receive_text())
        tasks.extend((sender, receiver))
        done, _ = await asyncio.wait((sender, receiver), timeout=max_session_s,
                                     return_when=asyncio.FIRST_COMPLETED)
        if not done:
            await error("Refreshing the speech connection")
        elif sender in done:
            result = await sender  # Surface send failures instead of silently swallowing them.
            if result == "stop":
                with contextlib.suppress(asyncio.TimeoutError):
                    await asyncio.wait_for(asyncio.shield(receiver), timeout=2)
        else:
            await receiver
            await error("Speech connection ended; reconnecting")
    except WebSocketDisconnect:
        pass
    except ValueError as exc:
        await error(str(exc), retryable=False)
    except Exception as exc:
        status = getattr(getattr(exc, "response", None), "status_code", None)
        permanent = status in (401, 403, 404)
        message = ("Speech service configuration needs attention" if permanent else
                   f"Speech connection interrupted ({type(exc).__name__}); reconnecting")
        # Never serialize upstream exception text: it may include authorization headers.
        await error(message, retryable=not permanent)
    finally:
        for task in tasks:
            if not task.done():
                task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        if upstream is None and opening is not None and not opening.cancelled() and opening.exception() is None:
            upstream = opening.result()
        if upstream is not None:
            with contextlib.suppress(Exception):
                await upstream.close()
        with contextlib.suppress(Exception):
            await ws.close()
