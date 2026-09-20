"""Bounded local/cloud experiment sessions for the browser lab."""
from __future__ import annotations

import asyncio
import contextlib
import json
import time

from .backends import jpeg_dimensions, local_speech_backend, object_backend, selection

object_local_lock = asyncio.Lock()
speech_local_lock = asyncio.Lock()
_local_objects = None
_local_speech = None


async def error(ws, message):
    with contextlib.suppress(Exception):
        await ws.send_json({"type": "error", "message": message})


async def local_speech_socket(ws):
    global _local_speech
    if speech_local_lock.locked():
        await error(ws, "Another local speech test is running. Stop it first.")
        await ws.close()
        return
    tasks = []
    async with speech_local_lock:
        try:
            await ws.send_json({"type": "connecting"})
            started = time.perf_counter()
            if _local_speech is None:
                _local_speech = local_speech_backend()
            backend = _local_speech
            await backend.load()
            await ws.send_json({"type": "ready", "backend": "local", "model_id": "faster-whisper-small-int8",
                                "model": "Whisper Small · int8 CPU", "sample_rate": 16000,
                                "chunk_samples": 512, "connect_ms": (time.perf_counter() - started) * 1000,
                                "load_ms": backend.load_ms, "max_session_s": 600})
            queue = asyncio.Queue(maxsize=32)

            async def receive_audio():
                while True:
                    event = await ws.receive()
                    if event["type"] == "websocket.disconnect":
                        return "disconnected"
                    chunk = event.get("bytes")
                    if chunk is not None:
                        if len(chunk) != 1024:
                            raise ValueError("Send exactly 512 samples of 16 kHz PCM16 audio")
                        try:
                            queue.put_nowait(chunk)
                        except asyncio.QueueFull as exc:
                            raise RuntimeError("Local speech is falling behind. Stop other tests and restart.") from exc
                    elif event.get("text"):
                        control = json.loads(event["text"])
                        if isinstance(control, dict) and control.get("type") == "stop":
                            await queue.put(None)
                            return "stop"
                        raise ValueError("Unknown speech control")

            async def chunks():
                while True:
                    chunk = await queue.get()
                    if chunk is None:
                        return
                    yield chunk

            connected = time.perf_counter()

            async def transcribe():
                async with contextlib.aclosing(backend.stream(chunks())) as stream:
                    async for segment in stream:
                        # Backend words are utterance-relative. The browser maps
                        # stream-relative audio offsets, including VAD silence gaps.
                        offset = backend.last_timings_ms.get("utterance_start_s", 0)
                        await ws.send_json({"type": "transcript", "segment_id": segment.seg_id,
                                            "text": segment.text, "is_final": segment.is_final,
                                            "words": [{"word": word.w, "start_time": offset+word.t0, "end_time": offset+word.t1,
                                                       "prob": word.probability} for word in segment.words],
                                            "hub_received_ms": (time.perf_counter() - connected) * 1000,
                                            "timings_ms": dict(backend.last_timings_ms)})

            sender = asyncio.create_task(receive_audio())
            receiver = asyncio.create_task(transcribe())
            tasks = [sender, receiver]
            done, _ = await asyncio.wait(tasks, timeout=600, return_when=asyncio.FIRST_COMPLETED)
            if not done:
                await error(ws, "Ten-minute test finished. Start again to continue.")
            elif sender in done and await sender == "stop":
                await asyncio.wait_for(asyncio.shield(receiver), timeout=8)
            elif receiver in done:
                await receiver
        except (ValueError, RuntimeError, FileNotFoundError) as exc:
            await error(ws, str(exc))
        except Exception as exc:
            await error(ws, f"Local speech ended ({type(exc).__name__}). Check model installation or restart.")
        finally:
            for task in tasks:
                task.cancel()
            if tasks:
                await asyncio.gather(*tasks, return_exceptions=True)
            with contextlib.suppress(Exception):
                await ws.close()


async def objects_socket(ws):
    global _local_objects
    backend = None
    acquired = False
    try:
        name = selection(ws.query_params.get("backend"), "local")
        vocabulary = list(dict.fromkeys(word.strip() for word in ws.query_params.get(
            "vocabulary", "person,keys,phone").split(",") if word.strip()))
        if not 1 <= len(vocabulary) <= 20 or any(len(word) > 60 for word in vocabulary):
            raise ValueError("Enter 1–20 short object labels, separated by commas")
        if name == "local":
            if object_local_lock.locked():
                raise RuntimeError("Another local object test is running. Stop it first.")
            await object_local_lock.acquire()
            acquired = True
        await ws.send_json({"type": "loading"})
        started = time.perf_counter()
        if name == "local":
            if _local_objects is None:
                _local_objects = object_backend(name)
            backend = _local_objects
        else:
            backend = object_backend(name)
        await backend.start_session(vocabulary)
        await ws.send_json({"type": "ready", "backend": name,
                            "model": "YOLO-World" if name == "local" else (
                                "SAM 3.1 (windowed, IDs reset)" if getattr(backend, "streaming_mode", "") == "windowed_reinitialization" else "SAM 3.1 Multiplex"),
                            "tracking_persistent": getattr(backend, "tracking_persistent", True),
                            "response_timeout_ms": 12000 if getattr(backend, "streaming_mode", "") == "windowed_reinitialization" else 5000,
                            "load_ms": (time.perf_counter() - started) * 1000})
        frame_id = 0
        async with asyncio.timeout(600):
            while True:
                message = await asyncio.wait_for(ws.receive(), timeout=60)
                if message["type"] == "websocket.disconnect":
                    return
                jpeg = message.get("bytes")
                if not jpeg or len(jpeg) > 500_000:
                    raise ValueError("Send one JPEG of at most 500 KB")
                wh = await asyncio.to_thread(jpeg_dimensions, jpeg, 1280)
                frame_id += 1
                started = time.perf_counter()
                detections = await backend.push_frame(str(frame_id), jpeg, wh)
                if getattr(backend, "last_frame_accepted", True) is False:
                    await ws.send_json({"type": "busy"})
                    continue
                timings = dict(getattr(backend, "last_timings_ms", {}))
                if "inference" not in timings and "inference_total" in timings:
                    timings["inference"] = timings["inference_total"]
                timings["request"] = (time.perf_counter() - started) * 1000
                await ws.send_json({"type": "frame", "frame_id": frame_id, "input_wh": wh,
                                    "objects": [row.model_dump() for row in detections],
                                    "timings_ms": timings,
                                    "session_generation": getattr(backend, "generation", None)})
    except (RuntimeError, ValueError, FileNotFoundError) as exc:
        await error(ws, str(exc))
    except TimeoutError:
        await error(ws, "Object test timed out. Start again to reconnect.")
    except Exception as exc:
        await error(ws, f"Object test failed ({type(exc).__name__}). Check backend configuration and server logs.")
    finally:
        if backend is not None:
            with contextlib.suppress(Exception):
                await backend.end_session()
        if acquired:
            object_local_lock.release()
        with contextlib.suppress(Exception):
            await ws.close()
