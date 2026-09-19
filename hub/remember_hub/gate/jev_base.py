from typing import Protocol

from remember_hub.contracts.decisions import GateAnswer, GateQuestion


class JevBackend(Protocol):
    async def decide(self, snapshot: str, questions: list[GateQuestion]) -> list[GateAnswer]: ...
