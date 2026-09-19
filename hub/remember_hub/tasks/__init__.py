"""Task router: Intent -> handler registry; new task = new file + one register line."""

from __future__ import annotations

import logging

from ..bus import EventBus
from ..contracts.decisions import GateResult
from ..memory.faces import FaceGallery
from ..memory.store import MemoryStore
from ..world.model import WorldModel
from .base import TaskContext, TaskHandler
from .clear_display import ClearDisplayHandler
from .enroll_person import EnrollPersonHandler
from .find_object import FindObjectHandler
from .identify_person import IdentifyPersonHandler
from .notes import RecallNoteHandler, RememberNoteHandler

log = logging.getLogger(__name__)


class TaskRouter:
    def __init__(
        self,
        bus: EventBus,
        world: WorldModel,
        memory: MemoryStore,
        gallery: FaceGallery,
    ) -> None:
        self.bus = bus
        self.world = world
        self.memory = memory
        self.gallery = gallery

        enroll = EnrollPersonHandler()
        handlers: list[TaskHandler] = [
            FindObjectHandler(),
            ClearDisplayHandler(),
            IdentifyPersonHandler(),
            enroll,
            RememberNoteHandler(),
            RecallNoteHandler(),
        ]
        self.registry = {h.intent: h for h in handlers}

        bus.subscribe("gate.result", self.on_gate_result)
        bus.subscribe("percepts.stt", enroll.on_stt)  # phase 2 of the enroll state machine

    async def on_gate_result(self, result: GateResult) -> None:
        handler = self.registry.get(result.intent)
        if handler is None:
            log.warning("no handler for intent %s", result.intent)
            return
        ctx = TaskContext(
            world=self.world,
            memory=self.memory,
            gallery=self.gallery,
            gate_result=result,
            bus=self.bus,
        )
        action = await handler.run(ctx)
        if action is not None:
            await self.bus.publish("display.action", action)
