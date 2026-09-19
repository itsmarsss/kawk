"""SQLite memory (WAL): events (append-only, doubles as replay log), last_seen,
notes, transcript (AGENTS.md §8). Sync sqlite3 — calls are sub-ms at demo scale."""

from __future__ import annotations

import json
import sqlite3
import time
from pathlib import Path

from ..contracts.percepts import TranscriptSegment
from ..contracts.world import LastSeen

_SCHEMA = """
CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY, t REAL NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS last_seen (
    id INTEGER PRIMARY KEY, label TEXT NOT NULL, ts REAL NOT NULL,
    keyframe_ref TEXT, context_labels TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS notes (
    id INTEGER PRIMARY KEY, t REAL NOT NULL, text TEXT NOT NULL, keyframe_ref TEXT);
CREATE TABLE IF NOT EXISTS transcript (
    seg_id TEXT PRIMARY KEY, t REAL NOT NULL, text TEXT NOT NULL, words TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_last_seen_label ON last_seen(label, ts DESC);
"""


class MemoryStore:
    def __init__(self, db_path: str | Path) -> None:
        path = Path(db_path)
        path.parent.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(path)
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.executescript(_SCHEMA)
        self.db.commit()

    def close(self) -> None:
        self.db.close()

    # ---- events ----------------------------------------------------------------

    def record_event(self, kind: str, payload: str, t: float | None = None) -> None:
        self.db.execute(
            "INSERT INTO events (t, kind, payload) VALUES (?, ?, ?)",
            (t if t is not None else time.time(), kind, payload),
        )
        self.db.commit()

    # ---- last-seen index (the heart of the keys demo) ----------------------------

    def write_last_seen(self, ls: LastSeen) -> None:
        self.db.execute(
            "INSERT INTO last_seen (label, ts, keyframe_ref, context_labels) VALUES (?, ?, ?, ?)",
            (ls.label, ls.ts, ls.keyframe_ref, json.dumps(ls.context_labels)),
        )
        self.db.commit()

    def get_last_seen(self, label: str) -> LastSeen | None:
        row = self.db.execute(
            "SELECT label, ts, keyframe_ref, context_labels FROM last_seen "
            "WHERE label = ? OR label LIKE ? ORDER BY ts DESC LIMIT 1",
            (label, f"%{label}%"),
        ).fetchone()
        if row is None:
            return None
        return LastSeen(
            label=row[0], ts=row[1], keyframe_ref=row[2], context_labels=json.loads(row[3])
        )

    def recent_last_seen(self, n: int = 5) -> list[LastSeen]:
        rows = self.db.execute(
            "SELECT label, ts, keyframe_ref, context_labels FROM last_seen "
            "WHERE id IN (SELECT MAX(id) FROM last_seen GROUP BY label) "
            "ORDER BY ts DESC LIMIT ?",
            (n,),
        ).fetchall()
        return [
            LastSeen(label=r[0], ts=r[1], keyframe_ref=r[2], context_labels=json.loads(r[3]))
            for r in rows
        ]

    # ---- notes -------------------------------------------------------------------

    def add_note(self, text: str, keyframe_ref: str | None = None, t: float | None = None) -> None:
        self.db.execute(
            "INSERT INTO notes (t, text, keyframe_ref) VALUES (?, ?, ?)",
            (t if t is not None else time.time(), text, keyframe_ref),
        )
        self.db.commit()

    def search_notes(self, query: str, n: int = 3) -> list[tuple[float, str]]:
        words = [w for w in query.lower().split() if len(w) > 2]
        rows = self.db.execute("SELECT t, text FROM notes ORDER BY t DESC LIMIT 50").fetchall()
        scored = []
        for t, text in rows:
            hits = sum(1 for w in words if w in text.lower())
            if hits or not words:
                scored.append((hits, t, text))
        scored.sort(key=lambda s: (-s[0], -s[1]))
        return [(t, text) for _, t, text in scored[:n]]

    # ---- transcript ----------------------------------------------------------------

    def add_transcript(self, seg: TranscriptSegment) -> None:
        self.db.execute(
            "INSERT OR REPLACE INTO transcript (seg_id, t, text, words) VALUES (?, ?, ?, ?)",
            (seg.seg_id, seg.t_start_hub, seg.text, seg.model_dump_json(include={"words"})),
        )
        self.db.commit()
