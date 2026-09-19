"""Vocabulary-proposer slow lane — STUB ONLY tonight (AGENTS.md §4, H100 #4).

A future implementation watches the snapshot/transcript and proposes new SAM
concepts via SamBackend.add_concept(). Registered here so the extension point
exists by registration (§3.7); NOT built tonight.
"""

from __future__ import annotations

from abc import ABC, abstractmethod


class VocabProposer(ABC):
    @abstractmethod
    async def propose(self, snapshot_text: str) -> list[str]:
        """Return new 1-3 word noun phrases worth tracking (may be empty)."""
        ...
