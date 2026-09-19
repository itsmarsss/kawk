from typing import Protocol


class VocabProposer(Protocol):
    async def propose(self, snapshot: str) -> list[str]: ...
