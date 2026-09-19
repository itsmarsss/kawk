"""The question bank registry (AGENTS.md §7). Ambient Nouls route via .intent."""

from __future__ import annotations

from ..contracts.decisions import Intent, Question
from ..world.model import WorldModel

INTENT_CHOICES = [i.value for i in Intent]


def build_bank(world: WorldModel) -> list[Question]:
    bank = [
        Question(
            key="addressed",
            kind="noul",
            instructions=(
                "The most recent user speech is directed at the assistant, not at another person"
            ),
            fire_threshold=0.65,
        ),
        Question(
            key="intent",
            kind="choice",
            instructions="The user's current request, judged from the transcript",
            choices=INTENT_CHOICES,
        ),
        Question(
            key="show_profile",
            kind="noul",
            instructions=(
                "A person is prominent and the wearer would benefit from seeing their profile now"
            ),
            intent=Intent.IDENTIFY_PERSON,
            fire_threshold=0.70,
        ),
        Question(
            key="enroll_worthy",
            kind="noul",
            instructions="An unidentified person has been stably in view for a long dwell",
            intent=Intent.ENROLL_PERSON,
            fire_threshold=0.70,
            debounce_ticks=3,
        ),
        Question(
            key="clear_display",
            kind="noul",
            instructions="The displayed content is stale or no longer relevant",
            intent=Intent.CLEAR_DISPLAY,
            fire_threshold=0.75,
            debounce_ticks=2,
        ),
    ]
    # Dynamic find_target — omitted when < 2 real options (§7: 1-option Choice is degenerate).
    labels = world.known_labels()
    if len(labels) >= 2:
        bank.append(
            Question(
                key="find_target",
                kind="choice",
                instructions="The object the user wants to locate",
                intent=Intent.FIND_OBJECT,
                choices=[*labels, "none of these"],
            )
        )
    return bank
