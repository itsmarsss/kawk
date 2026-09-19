from collections.abc import AsyncIterable, AsyncIterator
from typing import Protocol

from remember_hub.contracts.percepts import TranscriptSegment


class SttBackend(Protocol):
    def stream(self, pcm16_chunks: AsyncIterable[bytes]) -> AsyncIterator[TranscriptSegment]: ...
