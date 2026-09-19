"""STT interface (AGENTS.md §6.3). FROZEN after m0.

Backends: mock.py (Lane A) · local_whisper.py (Lane C) · baseten_ws.py (Lane D).
Partials REVISE earlier text — consumers key by seg_id and replace, never append.
vad.py (Lane C) sits in front of non-mock backends: 640->512-sample re-framing +
pre-roll/hangover gating per §6.3.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from collections.abc import AsyncIterator

from ...contracts.percepts import TranscriptSegment


class SttBackend(ABC):
    @abstractmethod
    def stream(self, chunks: AsyncIterator[bytes]) -> AsyncIterator[TranscriptSegment]:
        """Consume 16 kHz mono PCM16-LE chunks; yield revising segments."""
        ...
