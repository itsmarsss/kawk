"""Client for the verified buffalo_l R&D Truss (qvm6y6eq schema).

Input is already resized by the caller to <=640px. No implicit resize or model
substitution: returned coordinates refer to exactly those transmitted bytes.
"""

import asyncio
import base64
import time
from typing import Any

from remember_hub.contracts.percepts import Dimensions, FaceObservation
from remember_hub.perception.baseten_common import checked_box, endpoint, timings


class FaceRequestTimeout(RuntimeError):
    """The request exceeded its deadline; the caller may skip this video frame."""


def _is_httpx_timeout(error: Exception) -> bool:
    # Keep importing the adapter safe without the optional cloud dependencies.
    try:
        import httpx
    except ImportError:
        return False
    return isinstance(error, httpx.TimeoutException)


class BasetenFaceBackend:
    def __init__(
        self,
        model_id: str,
        api_key: str,
        *,
        timeout_s: float = 10,
        min_face_size: int = 80,
        client: Any = None,
    ):
        self.url = endpoint(model_id, api_key)
        self._key = api_key
        self._client = client
        self._owns_client = client is None
        self.timeout_s = timeout_s
        self.min_face_size = min_face_size
        self.last_timings_ms: dict[str, float] = {}
        self.last_frame_accepted = False
        self.last_detected_count: int | None = None
        self._busy = asyncio.Lock()

    async def embed_faces(self, jpeg: bytes, wh: Dimensions) -> list[FaceObservation]:
        self.last_frame_accepted = False
        if not jpeg or max(wh) > 640 or min(wh) <= 0:
            raise ValueError("Send a nonempty JPEG resized to a longest side of <=640 pixels")
        if self._busy.locked():
            return []  # caller must ignore a dropped frame, not treat it as absence
        async with self._busy:
            self.last_timings_ms = {}
            if self._client is None:
                try:
                    import httpx
                except ImportError as exc:
                    raise RuntimeError("Cloud HTTP requires: uv sync --extra cloud") from exc
                self._client = httpx.AsyncClient(timeout=self.timeout_s)
            captured = time.monotonic()
            started = time.perf_counter()
            try:
                response = await asyncio.wait_for(
                    self._client.post(
                        self.url,
                        headers={"Authorization": "Api-Key " + self._key},
                        json={
                            "image_b64": base64.b64encode(jpeg).decode("ascii"),
                            "min_face_size": self.min_face_size,
                        },
                    ),
                    self.timeout_s,
                )
                response.raise_for_status()
            except asyncio.CancelledError:
                raise
            except TimeoutError:
                raise FaceRequestTimeout("Baseten face request timed out; skip this frame") from None
            except Exception as exc:
                if _is_httpx_timeout(exc):
                    raise FaceRequestTimeout(
                        "Baseten face request timed out; skip this frame"
                    ) from None
                raise RuntimeError(
                    "Baseten face request failed; check deployment and credentials"
                ) from None
            data = response.json()
            if data.get("model") != "buffalo_l":
                raise ValueError("Cloud face model mismatch: expected buffalo_l")
            if tuple(data.get("input_wh", ())) != tuple(wh):
                raise ValueError("Cloud decoded dimensions differ from the SENT wh")
            now = time.monotonic()
            faces = [
                FaceObservation(
                    box=checked_box(item["box"], wh, clip=True),
                    det_score=item["det_score"],
                    embedding_512=item["embedding_512"],
                    model=data["model"],
                    wh=wh,
                    t_captured=captured,
                    t_percept=now,
                )
                for item in data["faces"]
            ]
            self.last_timings_ms = timings(data.get("timings_ms"))
            self.last_timings_ms["request_total"] = (time.perf_counter() - started) * 1000
            count = data["detected_count"]
            if not isinstance(count, int) or isinstance(count, bool) or count < len(faces):
                raise ValueError("Invalid cloud face detected_count")
            self.last_detected_count = count
            self.last_frame_accepted = True
            return faces

    async def aclose(self) -> None:
        if self._owns_client and self._client is not None:
            await self._client.aclose()
            self._client = None
