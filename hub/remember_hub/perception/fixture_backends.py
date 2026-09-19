"""Small offline contract references. These are synthetic data, never model results.

The full scenario/world implementation belongs to Lane A. These injected-fixture
backends let the independent C/D adapters be used and tested without that lane.
"""
from collections.abc import AsyncIterable, AsyncIterator

from remember_hub.contracts.decisions import GateAnswer, GateQuestion
from remember_hub.contracts.percepts import (
    Detection,
    Dimensions,
    FaceObservation,
    TranscriptSegment,
)


class FixtureSamBackend:
    def __init__(self, frames: dict[str, list[Detection]] | None = None):
        self.frames = frames or {}
        self.vocabulary: list[str] = []

    async def start_session(self, vocabulary: list[str]) -> None:
        self.vocabulary = list(vocabulary)

    async def push_frame(self, frame_id: str, jpeg: bytes, wh: Dimensions) -> list[Detection]:
        return [row.model_copy(deep=True, update={"frame_id": frame_id, "wh": wh})
                for row in self.frames.get(frame_id, []) if row.label in self.vocabulary]

    async def add_concept(self, noun: str) -> None:
        if noun not in self.vocabulary:
            self.vocabulary.append(noun)

    async def end_session(self) -> None:
        self.vocabulary = []


class FixtureFaceBackend:
    def __init__(self, faces: list[FaceObservation] | None = None):
        self.faces = faces or []

    async def embed_faces(self, jpeg: bytes, wh: Dimensions) -> list[FaceObservation]:
        return [row.model_copy(deep=True, update={"wh": wh}) for row in self.faces]


class FixtureSttBackend:
    def __init__(self, segments: list[TranscriptSegment] | None = None):
        self.segments = segments or []

    async def stream(self, pcm16_chunks: AsyncIterable[bytes]) -> AsyncIterator[TranscriptSegment]:
        iterator = iter(self.segments)
        async for _ in pcm16_chunks:
            segment = next(iterator, None)
            if segment is not None:
                yield segment.model_copy(deep=True)


class FixtureJevBackend:
    def __init__(self, answers: dict[str, GateAnswer] | None = None):
        self.answers = answers or {}

    async def decide(self, snapshot: str, questions: list[GateQuestion]) -> list[GateAnswer]:
        return [self.answers[q.key].model_copy(deep=True) for q in questions if q.key in self.answers]
