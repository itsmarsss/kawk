"""Keyword/regex Jev mock — same interface, deterministic enough to drive every
demo scenario (AGENTS.md §7). Reads only the snapshot text, like the real model."""

from __future__ import annotations

import re

from ..contracts.decisions import Answer, Intent, Question
from .jev_base import JevBackend

_INTENT_RULES: list[tuple[str, Intent]] = [
    (r"where (is|are|did i (put|leave))|where('s| is) my", Intent.FIND_OBJECT),
    (r"who is|who's th", Intent.IDENTIFY_PERSON),
    (r"remember (that|to|this)|note that", Intent.REMEMBER_NOTE),
    (r"what did i (say|note)|my notes|recall", Intent.RECALL_NOTE),
    (r"clear( the)? (display|screen)|never ?mind", Intent.CLEAR_DISPLAY),
]

_ADDRESSED = re.compile(
    r"where (is|are|did)|where's|who is|who's|remember|note that|what did i|recall|"
    r"clear( the)? (display|screen)",
)
_UNKNOWN_PERSON_DWELL = re.compile(r"person#\S+ name=\?(?: \S+)* dwell=(short|long)")


def _last_utterance(state: str) -> str:
    quotes = re.findall(r'\[user\] "([^"]*)"', state)
    return quotes[-1].lower() if quotes else ""


class JevMock(JevBackend):
    async def ask(self, state: str, questions: list[Question]) -> dict[str, Answer]:
        utt = _last_utterance(state)
        answers: dict[str, Answer] = {}
        for q in questions:
            if q.key == "addressed":
                answers[q.key] = Answer(noul=0.9 if _ADDRESSED.search(utt) else 0.15)
            elif q.key == "intent":
                intent = Intent.NONE
                for pattern, candidate in _INTENT_RULES:
                    if re.search(pattern, utt):
                        intent = candidate
                        break
                probs = {c: 0.02 for c in (q.choices or [])}
                probs[intent.value] = 0.9
                answers[q.key] = Answer(choice=intent.value, probabilities=probs)
            elif q.key == "find_target":
                choices = q.choices or []
                pick = "none of these"
                for c in choices:
                    if c != "none of these" and all(w in utt for w in c.lower().split()):
                        pick = c
                        break
                probs = {c: 0.02 for c in choices}
                probs[pick] = 0.9
                answers[q.key] = Answer(choice=pick, probabilities=probs)
            elif q.key == "show_profile":
                answers[q.key] = Answer(noul=0.85 if "identified as" in state else 0.10)
            elif q.key == "enroll_worthy":
                answers[q.key] = Answer(noul=0.80 if _UNKNOWN_PERSON_DWELL.search(state) else 0.10)
            elif q.key == "clear_display":
                answers[q.key] = Answer(noul=0.85 if "(stale)" in state else 0.05)
            else:
                answers[q.key] = Answer(noul=0.0)
        return answers
