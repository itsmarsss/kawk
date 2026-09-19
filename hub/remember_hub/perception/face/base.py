from typing import Protocol

from remember_hub.contracts.percepts import Dimensions, FaceObservation


class FaceBackend(Protocol):
    async def embed_faces(self, jpeg: bytes, wh: Dimensions) -> list[FaceObservation]: ...
