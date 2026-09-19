"""Durable personal notes, isolated from capture buffers and face embeddings."""
from __future__ import annotations

import hashlib
import json
import math
import os
import sqlite3
import threading
from collections.abc import Iterable
from datetime import datetime
from pathlib import Path

_FIELDS = ("schema_version", "id", "profile_id", "text", "created_at", "updated_at", "source")
_PROVENANCE_LIMITS = {"attribution": 40, "speaker": 40, "source_segment_id": 300,
                      "source_session_id": 128, "source_encounter_id": 128,
                      "decision_model": 80, "source_text": 1000}


def memory_path_for_gallery(gallery_path: Path, override: str | None = None) -> Path:
    """A fixture gallery naturally gets a separate store unless explicitly overridden."""
    if override is not None:
        if not override.strip():
            raise ValueError("REMEMBER_MEMORY_PATH must name a SQLite file")
        return Path(override).expanduser()
    return Path(gallery_path).expanduser().with_suffix(".memory.sqlite3")


def _text(value, name: str, limit: int, *, multiline: bool = False) -> str:
    if (not isinstance(value, str) or not value.strip() or len(value) > limit or
            any(ord(char) < 32 and not (multiline and char in "\n\t") for char in value)):
        raise ValueError(f"Invalid personal note {name}")
    return value


def _timestamp(value, name: str) -> float:
    value = _text(value, name, 64)
    try:
        stamp = datetime.fromisoformat(value.replace("Z", "+00:00"))
        if stamp.tzinfo is None:
            raise ValueError
        epoch = stamp.timestamp()
        if not math.isfinite(epoch):
            raise ValueError
        return epoch
    except (ValueError, OverflowError):
        raise ValueError(f"Invalid personal note {name}") from None


class NoteMemory:
    """One shared SQLite connection; bounded reads never remove historical rows.

    The caller supplies enrolled person IDs and verifies gallery membership before
    writes. This module never reads the gallery, models, images or credentials.
    """

    def __init__(self, path: Path | str):
        self.path = Path(path).expanduser()
        self._lock = threading.RLock()
        self._connection: sqlite3.Connection | None = None
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            fd = os.open(self.path, os.O_CREAT | os.O_RDWR, 0o600)
            try:
                os.fchmod(fd, 0o600)
            finally:
                os.close(fd)
            self._connection = sqlite3.connect(self.path, timeout=2, check_same_thread=False)
            self._connection.row_factory = sqlite3.Row
            self._connection.execute("PRAGMA journal_mode=WAL")
            self._connection.execute("PRAGMA synchronous=FULL")
            self._connection.execute("PRAGMA secure_delete=ON")
            with self._connection:
                self._connection.execute("""CREATE TABLE IF NOT EXISTS personal_notes (
                    id TEXT PRIMARY KEY, profile_id TEXT NOT NULL,
                    schema_version TEXT NOT NULL, text TEXT NOT NULL,
                    created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
                    source TEXT NOT NULL, updated_epoch REAL NOT NULL,
                    provenance TEXT NOT NULL DEFAULT '{}')""")
                self._connection.execute("CREATE INDEX IF NOT EXISTS personal_notes_profile_updated "
                                         "ON personal_notes(profile_id, updated_epoch DESC)")
                self._connection.execute("""CREATE TABLE IF NOT EXISTS conversation_fingerprints (
                    profile_id TEXT NOT NULL, digest TEXT NOT NULL,
                    PRIMARY KEY (profile_id, digest))""")
            self._secure_files()
        except (OSError, sqlite3.Error) as exc:
            if self._connection is not None:
                self._connection.close()
                self._connection = None
            raise RuntimeError(f"Cannot open personal note memory at {self.path}: {exc}") from exc

    def _secure_files(self) -> None:
        for filename in (self.path, Path(str(self.path) + "-wal"), Path(str(self.path) + "-shm")):
            try:
                os.chmod(filename, 0o600)
            except FileNotFoundError:
                if filename == self.path:
                    raise

    def _db(self) -> sqlite3.Connection:
        if self._connection is None:
            raise RuntimeError("Personal note memory is closed")
        return self._connection

    def list_notes(self, profile_ids: Iterable[str], limit: int = 256) -> list[dict]:
        if isinstance(limit, bool) or not isinstance(limit, int) or limit < 0:
            raise ValueError("Personal note load limit must be a nonnegative integer")
        people = set()
        for index, ident in enumerate(profile_ids):
            if index >= 256:
                raise ValueError("Personal note loading accepts at most 256 profile IDs")
            ident = _text(ident, "profile_id", 128)
            if not ident.startswith("object:"):
                people.add(ident)
        with self._lock:
            db = self._db()
            if not people or limit == 0:
                return []
            placeholders = ",".join("?" for _ in people)
            try:
                rows = db.execute(f"SELECT * FROM personal_notes WHERE profile_id IN ({placeholders}) "
                                  "ORDER BY updated_epoch DESC, id LIMIT ?", (*sorted(people), min(limit, 256)))
                return [{**{field: row[field] for field in _FIELDS}, **json.loads(row["provenance"])} for row in rows]
            except (sqlite3.Error, ValueError, TypeError) as exc:
                raise RuntimeError(f"Cannot load personal notes: {exc}") from exc

    def upsert_note(self, note: dict) -> None:
        if not isinstance(note, dict) or set(note) - set(_FIELDS) - set(_PROVENANCE_LIMITS) - {"edited_by_user"}:
            raise ValueError("Personal note contains unsupported fields")
        for field, limit in (("id", 128), ("profile_id", 128), ("text", 1000), ("source", 80)):
            _text(note.get(field), field, limit, multiline=field == "text")
        if note.get("schema_version") != "1.0" or note["profile_id"].startswith("object:"):
            raise ValueError("Only version 1.0 enrolled-person notes can be persisted")
        _timestamp(note.get("created_at"), "created_at")
        updated_epoch = _timestamp(note.get("updated_at"), "updated_at")
        provenance = {}
        for field, limit in _PROVENANCE_LIMITS.items():
            if field in note:
                provenance[field] = _text(note[field], field, limit, multiline=field == "source_text")
        if "edited_by_user" in note:
            if not isinstance(note["edited_by_user"], bool):
                raise ValueError("Personal note edited_by_user must be boolean")
            provenance["edited_by_user"] = note["edited_by_user"]
        with self._lock:
            db = self._db()
            try:
                with db:
                    db.execute("""INSERT INTO personal_notes
                        (schema_version, id, profile_id, text, created_at, updated_at, source, updated_epoch, provenance)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                        ON CONFLICT(id) DO UPDATE SET
                        profile_id=excluded.profile_id, text=excluded.text,
                        updated_at=excluded.updated_at, source=excluded.source,
                        updated_epoch=excluded.updated_epoch, provenance=excluded.provenance""",
                               (*[note[field] for field in _FIELDS], updated_epoch,
                                json.dumps(provenance, ensure_ascii=False)))
                    if note["source"] == "live-agent" and provenance.get("attribution") == "conversation_context":
                        source_text = provenance.get("source_text")
                        if source_text is None:
                            raise ValueError("Conversation notes require their original source_text")
                        db.execute("INSERT OR IGNORE INTO conversation_fingerprints (profile_id, digest) VALUES (?, ?)",
                                   (note["profile_id"], self._conversation_digest(source_text)))
                    self._secure_files()
            except (OSError, sqlite3.Error) as exc:
                raise RuntimeError(f"Cannot save personal note: {exc}") from exc

    @staticmethod
    def _conversation_digest(value: str) -> str:
        value = _text(value, "source_text", 1000, multiline=True)
        normalized = " ".join(value.replace("’", "'").split()).casefold().rstrip(".?! ")
        return hashlib.sha256(normalized.encode("utf-8")).hexdigest()

    def conversation_seen(self, profile_id: str, text: str) -> bool:
        profile_id = _text(profile_id, "profile_id", 128)
        digest = self._conversation_digest(text)
        with self._lock:
            try:
                return self._db().execute("SELECT 1 FROM conversation_fingerprints "
                                          "WHERE profile_id = ? AND digest = ?",
                                          (profile_id, digest)).fetchone() is not None
            except sqlite3.Error as exc:
                raise RuntimeError(f"Cannot check remembered conversation: {exc}") from exc

    def delete_note(self, note_id: str) -> None:
        note_id = _text(note_id, "id", 128)
        with self._lock:
            db = self._db()
            try:
                with db:
                    db.execute("DELETE FROM personal_notes WHERE id = ?", (note_id,))
                    self._secure_files()
                # secure_delete clears freed cells; truncate the write-ahead log
                # so a deleted note's original text is not kept as a tombstone.
                db.execute("PRAGMA wal_checkpoint(TRUNCATE)")
            except (OSError, sqlite3.Error) as exc:
                raise RuntimeError(f"Cannot delete personal note: {exc}") from exc

    def delete_profile_notes(self, profile_id: str) -> None:
        """Forgetting a person removes all their notes and suppression digests."""
        profile_id = _text(profile_id, "profile_id", 128)
        with self._lock:
            db = self._db()
            try:
                with db:
                    db.execute("DELETE FROM personal_notes WHERE profile_id = ?", (profile_id,))
                    db.execute("DELETE FROM conversation_fingerprints WHERE profile_id = ?", (profile_id,))
                    self._secure_files()
                db.execute("PRAGMA wal_checkpoint(TRUNCATE)")
            except (OSError, sqlite3.Error) as exc:
                raise RuntimeError(f"Cannot delete this person's note memory: {exc}") from exc

    def close(self) -> None:
        with self._lock:
            if self._connection is not None:
                self._connection.close()
                self._connection = None
