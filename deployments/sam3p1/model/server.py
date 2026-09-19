"""Small bounded WebSocket protocol, shared by native Truss and the GPU smoke."""

import asyncio
import json
import logging
from collections import deque
from time import perf_counter
from uuid import uuid4

LOG = logging.getLogger(__name__)
MAX_JPEG_BYTES = 8 * 1024 * 1024


class ProtocolError(ValueError):
    """Only our controlled validation messages may reach the client."""


def vocabulary_value(values):
    if not isinstance(values, list) or not 1 <= len(values) <= 20:
        raise ProtocolError("vocabulary must contain 1–20 concepts")
    if any(not isinstance(noun, str) or not noun.strip() or len(noun) > 80 for noun in values):
        raise ProtocolError("concepts must be nonempty strings of at most80 characters")
    if len(set(values)) != len(values):
        raise ProtocolError("concepts must be unique")
    return list(values)


class WindowSocketServer:
    def __init__(self, engine, window_size=1):
        if isinstance(window_size, bool) or window_size not in (1, 2, 3, 4):
            raise ProtocolError("window_size must be1–4")
        self.engine = engine
        self.window_size = window_size
        self.active = False

    async def serve(self, websocket):
        # The native Truss Model never accepts: Baseten already did that.
        if self.active:
            await websocket.send_json({"type": "error", "message": "SAM worker is busy"})
            await websocket.close(code=1013)
            return
        self.active = True
        history = deque(maxlen=self.window_size)
        vocabulary = None
        previous_wh = None
        generation = 0
        session_prefix = uuid4().hex[:12]
        work = None
        try:
            while True:
                message = await websocket.receive()
                if message["type"] == "websocket.disconnect":
                    break
                raw = message.get("text")
                if raw is None or len(raw) > 16384:
                    raise ProtocolError("Expected bounded JSON control or frame metadata")
                try:
                    command = json.loads(raw)
                except ValueError:
                    raise ProtocolError("Invalid JSON control") from None
                if not isinstance(command, dict):
                    raise ProtocolError("Control must be an object")
                kind = command.get("type")
                if kind == "start_session":
                    if vocabulary is not None:
                        raise ProtocolError("Session already started")
                    vocabulary = vocabulary_value(command.get("vocabulary"))
                    await websocket.send_json({"type": "ready", "model_version": "sam3.1",
                                               "streaming_mode": "windowed_reinitialization",
                                               "tracking_persistent": False,
                                               "window_size": self.window_size})
                elif vocabulary is None:
                    raise ProtocolError("start_session must precede frames")
                elif kind == "add_concept":
                    noun = command.get("noun")
                    if noun not in vocabulary:
                        vocabulary = vocabulary_value([*vocabulary, noun])
                    await websocket.send_json({"type": "concept_added", "noun": noun})
                elif kind == "end_session":
                    await websocket.close(code=1000)
                    break
                elif kind == "frame":
                    frame_id, wh = command.get("frame_id"), command.get("wh")
                    if not isinstance(frame_id, str) or not 1 <= len(frame_id) <= 128:
                        raise ProtocolError("frame_id must be a nonempty string of at most128 characters")
                    if (not isinstance(wh, list) or len(wh) != 2
                            or any(type(n) is not int or not 1 <= n <= 4096 for n in wh)
                            or wh[0] * wh[1] > 12_000_000):
                        raise ProtocolError("Invalid SENT frame dimensions")
                    async with asyncio.timeout(15):
                        pixels = await websocket.receive()
                    if pixels["type"] == "websocket.disconnect":
                        break
                    jpeg = pixels.get("bytes")
                    if (not isinstance(jpeg, bytes) or not 4 <= len(jpeg) <= MAX_JPEG_BYTES
                            or not jpeg.startswith(b"\xff\xd8") or not jpeg.endswith(b"\xff\xd9")):
                        raise ProtocolError("Expected one bounded JPEG payload after frame metadata")
                    if previous_wh != wh:
                        history.clear()
                    previous_wh = list(wh)
                    history.append(jpeg)
                    generation += 1
                    start = perf_counter()
                    work = asyncio.create_task(asyncio.to_thread(
                        self.engine.infer, list(history), tuple(wh), list(vocabulary), generation,
                    ))
                    # Cancellation must not release the GPU for another connection
                    # while a Python worker thread is still using this predictor.
                    result = await asyncio.shield(work)
                    for obj in result["objects"]:
                        obj["track_id"] = session_prefix + ":" + obj["track_id"]
                    result["timings_ms"]["server_total"] = (perf_counter() - start) * 1000
                    await websocket.send_json({"type": "frame", "frame_id": frame_id, "wh": wh,
                                               "tracker_generation": generation, **result})
                    work = None
                else:
                    raise ProtocolError("Unknown SAM control type")
        except asyncio.CancelledError:
            if work is not None:
                try:
                    await work
                except Exception:
                    LOG.exception("SAM inference failed during connection cancellation")
            raise
        except Exception as error:
            # Validation text is our own; arbitrary model errors never reach clients.
            message = str(error) if isinstance(error, ProtocolError) else "SAM inference or connection failed"
            if not isinstance(error, ProtocolError):
                LOG.exception("SAM WebSocket failed")
            try:
                await websocket.send_json({"type": "error", "message": message})
                await websocket.close(code=1008)
            except Exception:
                pass
        finally:
            history.clear()
            self.active = False
