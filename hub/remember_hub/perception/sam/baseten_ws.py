"""One-inflight client for our explicit SAM3.1 WebSocket contract.

The included server is WINDOWED R&D, not persistent incremental tracking.
It requires an explicit allow_windowed opt-in. No SAM3.0 substitution is accepted.
"""

import asyncio
import contextlib
import json
import time
import uuid
from collections import deque
from typing import Any

from remember_hub.contracts.percepts import Detection, Dimensions
from remember_hub.perception.baseten_common import checked_box, endpoint, timings


class BasetenSamBackend:
    def __init__(
        self,
        model_id: str,
        api_key: str,
        *,
        allow_windowed: bool = False,
        response_timeout_s: float = 1,
        open_timeout_s: float = 120,
        recycle_after_s: float = 300,
        connector: Any = None,
    ):
        self.url = endpoint(model_id, api_key, websocket=True)
        self._key, self._connector = api_key, connector
        self.allow_windowed = allow_windowed
        self.response_timeout_s, self.open_timeout_s = response_timeout_s, open_timeout_s
        self.recycle_after_s = recycle_after_s
        self._ws: Any = None
        self._lock = asyncio.Lock()
        self._vocabulary: list[str] = []
        self._instance = uuid.uuid4().hex
        self._started_at = 0.0
        self._closed = True
        self.generation = 0
        self.connection_generation = 0
        self.recovering = False
        self.last_frame_accepted = False
        self.last_drop_reason: str | None = None
        self.tracking_persistent = False
        self.streaming_mode = "unconnected"
        self.last_timings_ms: dict[str, float] = {}
        self.lifecycle_events: deque[dict[str, Any]] = deque(maxlen=32)

    def _lifecycle(self, state: str, reason: str) -> None:
        if state == "recovering":
            self.recovering = True
        elif state in {"recovered", "closed"}:
            self.recovering = False
        self.lifecycle_events.append(
            {
                "state": state,
                "reason": reason,
                "generation": self.generation,
                "t_hub": time.monotonic(),
            }
        )

    @staticmethod
    def _noun(noun: str) -> str:
        noun = noun.strip()
        if not noun or len(noun.split()) > 3 or len(noun) > 80:
            raise ValueError("Use nonempty concepts of one to three words")
        return noun

    async def start_session(self, vocabulary: list[str]) -> None:
        vocab = list(dict.fromkeys(self._noun(x) for x in vocabulary))
        if not 1 <= len(vocab) <= 20:
            raise ValueError("SAM vocabulary must contain 1–20 concepts")
        async with self._lock:
            await self._disconnect()
            self._closed = False
            self._vocabulary = vocab
            await self._connect("start")

    async def _connect(self, reason: str) -> None:
        import websockets

        self.generation += 1
        self.connection_generation += 1
        self._lifecycle("recovering", reason)
        connector = self._connector or websockets.connect
        started = time.perf_counter()
        try:
            self._ws = await connector(
                self.url,
                additional_headers={"Authorization": "Bearer " + self._key},
                open_timeout=self.open_timeout_s,
                close_timeout=2,
                compression=None,
                max_size=2_000_000,
                max_queue=1,
            )
            await asyncio.wait_for(
                self._ws.send(
                    json.dumps({"type": "start_session", "vocabulary": self._vocabulary})
                ),
                self.response_timeout_s,
            )
            ready = json.loads(await asyncio.wait_for(self._ws.recv(), self.open_timeout_s))
            if ready.get("type") != "ready" or ready.get("model_version") != "sam3.1":
                raise ValueError("Endpoint is not a ready SAM3.1 service")
            self.streaming_mode = ready["streaming_mode"]
            self.tracking_persistent = ready.get("tracking_persistent") is True
            if self.streaming_mode == "windowed_reinitialization":
                if not self.allow_windowed or self.tracking_persistent:
                    raise ValueError("SAM3.1 windowed R&D requires explicit allow_windowed=True")
            elif self.streaming_mode != "incremental" or not self.tracking_persistent:
                raise ValueError("Unrecognized SAM3.1 streaming capability")
            self._started_at = time.monotonic()
            self.last_timings_ms = {"connect": (time.perf_counter() - started) * 1000}
            # Remain recovering until the first accepted result can be re-associated.
        except BaseException:
            await self._disconnect()
            raise

    async def push_frame(self, frame_id: str, jpeg: bytes, wh: Dimensions) -> list[Detection]:
        self.last_frame_accepted = False
        self.last_drop_reason = None
        if self._closed:
            raise RuntimeError("Call start_session before sending SAM frames")
        if not jpeg or len(jpeg) > 5_000_000 or min(wh) <= 0:
            raise ValueError("Send a JPEG <=5 MB and positive SENT dimensions")
        if self._lock.locked():
            self.last_drop_reason = "busy"
            return []
        async with self._lock:
            captured = time.monotonic()
            self.last_timings_ms = {}
            try:
                if self._ws is None or captured - self._started_at >= self.recycle_after_s:
                    await self._disconnect()
                    await self._connect("reconnect_or_recycle")
                started = time.perf_counter()
                socket = self._ws
                if socket is None:
                    raise ConnectionError("SAM disconnected before send")
                async with asyncio.timeout(self.response_timeout_s):
                    await socket.send(
                        json.dumps({"type": "frame", "frame_id": frame_id, "wh": list(wh)})
                    )
                    await socket.send(jpeg)
                    data = json.loads(await socket.recv())
                if data.get("type") != "frame" or str(data.get("frame_id")) != frame_id:
                    raise ValueError("SAM reply does not match the in-flight frame")
                if tuple(data.get("wh", ())) != tuple(wh):
                    raise ValueError("SAM reply dimensions differ from the SENT frame")
                window = data.get("tracker_generation", 0)
                if not self.tracking_persistent:
                    if not isinstance(window, int) or window <= 0:
                        raise ValueError("Windowed SAM must identify each tracker reset")
                    self.generation += 1
                    self._lifecycle("recovering", "window_reset")
                prefix = f"{self._instance}:{self.generation}:{window}"
                now = time.monotonic()
                results = []
                for item in data["objects"]:
                    if item["label"] not in self._vocabulary:
                        raise ValueError("SAM returned a concept outside the session vocabulary")
                    results.append(
                        Detection(
                            track_id=f"{prefix}:{item['track_id']}",
                            label=item["label"],
                            box_xyxy=checked_box(item["box_xyxy"], wh),
                            score=item["score"],
                            frame_id=frame_id,
                            wh=wh,
                            t_captured=captured,
                            t_percept=now,
                        )
                    )
                self.last_timings_ms = timings(data.get("timings_ms"))
                self.last_timings_ms["request_total"] = (time.perf_counter() - started) * 1000
                self.last_frame_accepted = True
                self._lifecycle("reassociated_frame_available", "first_valid_frame")
                return results
            except asyncio.CancelledError:
                self._lifecycle("recovering", "cancelled_inflight")
                await self._disconnect()
                raise
            except Exception as exc:
                self.last_drop_reason = (
                    "timeout" if isinstance(exc, TimeoutError) else "invalid_or_lost_reply"
                )
                self._lifecycle("recovering", self.last_drop_reason)
                await self._disconnect()
                # Drop the lost frame. Next frame creates a fresh connection; never
                # consume a late reply as if it belonged to a newer image.
                raise RuntimeError("SAM frame failed; tracker recovery is pending") from None

    def acknowledge_reassociation(self) -> None:
        """Call only after the hub has associated the latest accepted boxes by IoU."""
        if not self.last_frame_accepted:
            raise RuntimeError("No accepted frame is available for reassociation")
        self._lifecycle("recovered", "hub_reassociated")

    async def add_concept(self, noun: str) -> None:
        noun = self._noun(noun)
        async with self._lock:
            if self._closed:
                raise RuntimeError("Call start_session before adding concepts")
            if noun in self._vocabulary:
                return
            if len(self._vocabulary) >= 20:
                raise ValueError("SAM vocabulary is limited to20 concepts")
            self._vocabulary.append(noun)
            # A full, observable session reset avoids unknown mid-session tracker semantics.
            await self._disconnect()
            await self._connect("vocabulary_changed")

    async def _disconnect(self) -> None:
        ws, self._ws = self._ws, None
        if ws is not None:
            with contextlib.suppress(Exception):
                await asyncio.wait_for(ws.close(), 3)

    async def end_session(self) -> None:
        self._closed = True
        # Close immediately to unblock an in-flight recv; do not wait behind it.
        await self._disconnect()
        self._lifecycle("closed", "end_session")
