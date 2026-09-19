"""CLEAR_DISPLAY — reset to the idle card."""

from __future__ import annotations

import time

from ..contracts.decisions import Intent
from ..contracts.display import Card, CardTemplate, DisplayAction
from .base import TaskContext


class ClearDisplayHandler:
    intent = Intent.CLEAR_DISPLAY

    async def run(self, ctx: TaskContext) -> DisplayAction:
        return DisplayAction(
            card=Card(template=CardTemplate.IDLE, ttl_ms=0),
            ttl_ms=0,
            priority=100,  # clear always wins; compositor stores idle at priority 0
            t_created=time.time(),
        )
