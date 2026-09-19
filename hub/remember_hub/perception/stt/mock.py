"""Scenario-scripted STT mock. Emits finals at scenario time; `words: true`
synthesizes evenly spaced word timestamps across the final (AGENTS.md §10)."""

from __future__ import annotations

import time
from collections.abc import AsyncIterator
from typing import TYPE_CHECKING

from ...contracts.percepts import TranscriptSegment, Word
from .base import SttBackend

if TYPE_CHECKING:
    from ...scenario import Scenario, ScenarioClock

_WORD_S = 0.35  # synthetic per-word duration


class MockStt(SttBackend):
    def __init__(self, scenario: Scenario | None = None, clock: ScenarioClock | None = None):
        self.scenario = scenario
        self.clock = clock

    async def stream(self, chunks: AsyncIterator[bytes]) -> AsyncIterator[TranscriptSegment]:
        if self.scenario is None or self.clock is None:
            return
        for i, event in enumerate(self.scenario.stt_events):
            await self.clock.sleep_until(event.t)
            words: list[Word] = []
            duration = _WORD_S * len(event.final.split())
            if event.words:
                words = [
                    Word(w=w, t0=j * _WORD_S, t1=(j + 1) * _WORD_S)
                    for j, w in enumerate(event.final.split())
                ]
            yield TranscriptSegment(
                seg_id=f"seg{i}",
                text=event.final,
                is_final=True,
                words=words,
                t_start_hub=time.time() - duration,
            )
