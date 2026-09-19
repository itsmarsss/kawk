"""Local V1 transport. Temporary sessions bridge existing perception to the product UI.

The production agent, database, and hardware DeviceLink are deliberately absent.
This router never calls inference or holds browser-visible cloud credentials.
"""
from __future__ import annotations

import asyncio
import contextlib
import copy
import json
import math
import struct
import time
import uuid
from collections import OrderedDict
from datetime import datetime

from fastapi import APIRouter, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse

from .clips import SessionClipBuffer
from .product import ProductSession, iso, text
from .product_decisions import DecisionEvent, V1DecisionBridge


class BrowserSession:
    def __init__(self, gallery_people, *, decision_backend=None, note_memory=None, delete_person=None,
                 on_note_change=None):
        self.id = uuid.uuid4().hex
        self.created_at = self.last_used = time.time()
        self.queue = asyncio.Queue(maxsize=256)
        self.attached = False
        self.overflow = False
        self.closed = False
        self.camera_active = False
        self.websocket = None
        self.clock_origin = None
        self.device_origin = None
        self.last_media = {}
        self.decision_tokens = OrderedDict()
        self.decision_sources = OrderedDict()
        self.last_decision_state = ""
        self.last_perception_decision = 0.0
        self.delete_person = delete_person
        self.on_note_change = on_note_change
        self._syncing_note = False
        self._persisted_note_profiles = {}
        self.decision_status = {
            "backend": "typesafe" if decision_backend else "rules",
            "phase": "idle" if decision_backend else "rules",
            "model": getattr(decision_backend, "model", None),
            "message": "Jev waits for capture" if decision_backend else "V1 command and object rules; Jev is not connected",
        }
        self.product = ProductSession(
            self.id, self.enqueue, gallery_people=gallery_people,
            trigger_clip=self._trigger_clip, control=self._control,
            auto_capture_rules=decision_backend is None,
            on_decision_event=self._decision_source,
            note_memory=note_memory,
        )
        self._persisted_note_profiles = {
            ident: note["profile_id"] for ident, note in self.product.notes.items()
            if self.product.profiles.get(note["profile_id"], {}).get("kind") == "person"
        }
        self.clips = SessionClipBuffer(on_update=self._clip_update)
        self.decisions = V1DecisionBridge(
            decision_backend, on_voice=self._voice_decision,
            on_moment=self._significant_moment, on_status=self._decision_status,
        ) if decision_backend else None

    def _decision_status(self, status):
        phase = status.get("state", status.get("phase", "idle"))
        messages = {"ready": "Jev ready", "deciding": "Jev deciding",
                    "dropped": "Jev skipped superseded or stale input",
                    "backoff": "Jev temporarily waiting after a service limit",
                    "error": "Jev unavailable; no fallback decision applied",
                    "stopped": "Jev stopped"}
        self.decision_status = {"backend": "typesafe", "phase": phase,
                                "model": status.get("model", self.decision_status.get("model")),
                                "message": status.get("message", messages.get(phase, "Jev waits for capture")),
                                **{key: value for key, value in status.items()
                                   if key not in {"state", "provider", "phase", "message"}}}
        if phase in {"dropped", "error", "backoff"}:
            self.decision_tokens.pop(status.get("event_id"), None)
            self.last_decision_state = ""
        self.enqueue({"type": "v1.decision_status", "status": dict(self.decision_status)})

    def _voice_decision(self, event, decision):
        token = self.decision_tokens.pop(event.event_id, None)
        if token is not None:
            self.product.apply_transcript_decision(token, decision)

    def _significant_moment(self, event, decision):
        if not self.product.running or self.product.capture["camera"] != "live":
            return False
        try:
            self.product.dispatch({"type": "moment.mark", "payload": {
                "title": "Jev significant moment", "event_at": iso(event.event_at),
                "source": "jev-1.13.0",
                "profile_ids": [ident for ident in event.profile_ids if ident in self.product.profiles],
            }})
        except (ValueError, RuntimeError) as exc:
            self._decision_status({"phase": "error", "message": str(exc)[:300]})
            return False
        return True

    def _decision_source(self, event):
        """Keep source provenance until the complete perception update has finished."""
        if not self.decisions:
            return
        self.decision_sources[event["event_id"]] = event
        while len(self.decision_sources) > 16:
            event_id, _ = self.decision_sources.popitem(last=False)
            self._decision_status({"state": "dropped", "event_id": event_id,
                                   "reason": "source_queue_full"})

    def _flush_decision_sources(self):
        if not self.decision_sources:
            return False
        sources, self.decision_sources = list(self.decision_sources.values()), OrderedDict()
        if not self.decisions or not self.product.running or self.product.capture["camera"] != "live":
            return False
        # A single clip must have a single source time. Only same-frame losses
        # may share it; never attach unrelated historical or still-visible IDs.
        latest = max(sources, key=lambda event: event["event_at"])
        matching = [event for event in sources if event["event_at"] == latest["event_at"]]
        for event in sources:
            if event["event_at"] != latest["event_at"]:
                self._decision_status({"state": "dropped", "event_id": event["event_id"],
                                       "reason": "superseded_source_time"})
        self._decision_input("perception.objects", {}, None, source={
            **latest, "profile_ids": tuple(sorted({event["profile_id"] for event in matching})),
        })
        return True

    def _decision_input(self, kind, data, stream_id, *, source=None):
        if not self.decisions:
            return
        state = self.product.decision_state()
        event_id = uuid.uuid4().hex
        if kind == "perception.speech":
            if not data.get("is_final"):
                return
            raw_id = str(data.get("segment_id", data.get("id", "")))
            token = self.product.pending_transcript_decision(raw_id, stream_id=stream_id)
            if token is None:
                return
            self.decision_tokens[event_id] = token
            while len(self.decision_tokens) > 8:
                self.decision_tokens.popitem(last=False)
            event_kind, transcript = "transcript", data["text"]
        else:
            if source is None and (state == self.last_decision_state or
                                   time.monotonic() - self.last_perception_decision < 1):
                return
            self.last_perception_decision = time.monotonic()
            event_kind, transcript = "perception", ""
        previous = self.last_decision_state
        event_at = data.get("observed_at", time.time())
        if isinstance(event_at, bool) or not isinstance(event_at, (int, float)) or not math.isfinite(event_at):
            event_at = time.time()
        profiles = tuple(sorted(self.product.active))[:16]
        previous_limit = 1024 if source is not None else 1600
        context = f"Previous observed context:\n{previous[:previous_limit]}\nCurrent observed context:\n{state[:4096]}"
        if source is not None:
            event_id, event_at, profiles = source["event_id"], source["event_at"], source["profile_ids"]
            # This categorical delta remains visible even if a timer confirmed
            # the disappearance between frames. Current state is read above,
            # after every object in this update has been processed.
            labels = [self.product.profiles[ident]["name"] for ident in profiles
                      if ident in self.product.profiles]
            while len(json.dumps(labels, ensure_ascii=False)) > 512:
                labels.pop()
            context = f"Source event: object_disappeared; labels={json.dumps(labels, ensure_ascii=False)}\n{context}"
        submitted = self.decisions.submit(DecisionEvent(
            event_id=event_id, event_at=event_at, kind=event_kind,
            state=context,
            transcript=transcript[:1000], profile_ids=profiles,
            subject_key=("|".join(profiles) or "scene")[:256],
            clip_eligible=self.product.capture["camera"] == "live",
        ))
        if not submitted:
            self.decision_tokens.pop(event_id, None)
        else:
            self.last_decision_state = state

    def touch(self):
        self.last_used = time.time()

    def tick(self):
        self.product.tick()
        self._flush_decision_sources()

    def enqueue(self, message):
        if self.closed:
            return
        try:
            self.queue.put_nowait(message)
        except asyncio.QueueFull:
            self.overflow = True
        self._publish_note_change(message)

    def _publish_note_change(self, message):
        if self.product.note_memory is None:
            return
        kind, payload = message.get("type"), message.get("payload", {})
        if kind == "note.upserted":
            note = payload["note"]
            profile_id = note["profile_id"]
            if self.product.profiles.get(profile_id, {}).get("kind") != "person":
                self._persisted_note_profiles.pop(note["id"], None)
                return  # Object notes belong only to the originating capture session.
            self._persisted_note_profiles[note["id"]] = profile_id
        elif kind == "note.deleted":
            profile_id = self._persisted_note_profiles.pop(payload["note_id"], None)
            if profile_id is None:
                return
        elif kind == "profile.deleted":
            for ident, profile_id in list(self._persisted_note_profiles.items()):
                if profile_id == payload["profile_id"]:
                    self._persisted_note_profiles.pop(ident)
            return
        else:
            return
        if self.on_note_change is not None and not self._syncing_note:
            self.on_note_change(self, kind, payload, profile_id)

    def sync_person_note(self, kind, payload, profile_id):
        """Apply an already-persisted peer change without writing or rebroadcasting it."""
        if self.closed or self.product.profiles.get(profile_id, {}).get("kind") != "person":
            return
        self._syncing_note = True
        try:
            old_profile = None
            if kind == "note.upserted":
                note = copy.deepcopy(payload["note"])
                old = self.product.notes.pop(note["id"], None)
                old_profile = old["profile_id"] if old else None
                self.product.notes[note["id"]] = note
            else:
                ident = payload["note_id"]
                old = self.product.notes.pop(ident, None)
                old_profile = old["profile_id"] if old else None
                self.product._deleted_notes[ident] = None
                while len(self.product._deleted_notes) > 512:
                    self.product._deleted_notes.popitem(last=False)
            self.product._emit(kind, copy.deepcopy(payload))
            if self.product.foreground and self.product.foreground in (profile_id, old_profile):
                self.product._profile_card(self.product.foreground)
        finally:
            self._syncing_note = False

    def _control(self, control):
        self.enqueue({"type": "v1.control", "control": control})

    def _trigger_clip(self, request):
        try:
            event_at = datetime.fromisoformat(request["event_at"].replace("Z", "+00:00"))
            self.clips.trigger(event_at=event_at.timestamp(), clip_id=request["moment_id"])
        except (KeyError, TypeError, ValueError, RuntimeError) as exc:
            self.product.clip_failed(request["moment_id"], str(exc))

    def _clip_update(self, status):
        if status.status == "saved" and status.clip:
            url = f"/api/v1/sessions/{self.id}/clips/{status.id}.mp4"
            self.product.clip_completed(status.id, status.clip.to_clip(url))
        elif status.status in {"failed", "cancelled", "expired"}:
            self.product.clip_failed(status.id, status.error or "Temporary clip is unavailable")

    def hello(self, device_ts_ms):
        if self.clock_origin is not None:
            raise ValueError("Capture clock is already bound for this connection")
        if not isinstance(device_ts_ms, (int, float)) or isinstance(device_ts_ms, bool):
            raise ValueError("hello requires a finite device_ts_ms")
        if not math.isfinite(device_ts_ms) or not 0 <= device_ts_ms < 2**32:
            raise ValueError("device_ts_ms must be an unsigned 32-bit timestamp")
        self.clock_origin, self.device_origin = time.time(), int(device_ts_ms)
        self.last_media.clear()

    def capture_time(self, timestamp):
        if self.clock_origin is None:
            raise ValueError("Send hello before capture samples")
        if not isinstance(timestamp, (int, float)) or isinstance(timestamp, bool):
            raise ValueError("Invalid capture timestamp")
        if not math.isfinite(timestamp) or not 0 <= timestamp < 2**32:
            raise ValueError("Invalid capture timestamp")
        delta = (int(timestamp) - self.device_origin) % 2**32
        # Audio's first sample can precede hello by one worklet chunk.
        if delta > 2**31:
            delta -= 2**32
        mapped = self.clock_origin + delta / 1000
        if not -0.5 <= time.time() - mapped <= 30:
            raise ValueError("Capture timestamp is outside the current session clock")
        return mapped

    def receive_media(self, message):
        if len(message) < 10 or len(message) > 500_000:
            raise ValueError("Expected an eight-byte capture header and bounded media payload")
        kind, _flags, seq, stamp = struct.unpack_from("<BBHI", message)
        captured_at = self.capture_time(stamp)
        if captured_at < self.last_media.get(kind, -math.inf):
            raise ValueError("Out-of-order capture sample")
        self.last_media[kind] = captured_at
        payload = message[8:]
        if kind == 1:
            accepted = self.clips.add_frame(payload, captured_at=captured_at)
            self.enqueue({"type": "v1.frame_ack", "seq": seq, "accepted": accepted})
        elif kind == 2:
            if len(payload) > 6400 or len(payload) % 2:
                raise ValueError("Audio must be bounded mono PCM16 at 16 kHz")
            self.clips.add_audio(payload, captured_at=captured_at)
        else:
            raise ValueError("Unsupported capture media type")

    async def receive_json(self, message):
        if not isinstance(message, dict):
            raise ValueError("Expected a JSON object")
        kind = message.get("type")
        if kind == "hello":
            self.hello(message.get("device_ts_ms"))
            # A reconnect discards stale queued envelopes. Publish the current
            # state on the same ordered socket before accepting new commands,
            # including Stop/clip failures produced during disconnect cleanup.
            self.enqueue({"type": "v1.ack", "receipt": {"hello": True},
                          "snapshot": self.product.snapshot()})
            self.enqueue({"type": "v1.decision_status", "status": dict(self.decision_status)})
        elif kind == "command":
            command = message.get("command")
            if not isinstance(command, dict):
                raise ValueError("Expected a command object")
            if command.get("type") == "profile.delete":
                payload = command.get("payload", {})
                if not isinstance(payload, dict):
                    raise ValueError("Expected command payload")
                ident = text(payload.get("profile_id"), "profile_id", 128)
                if self.delete_person is None:
                    raise RuntimeError("Person deletion is not available in this session")
                self.delete_person(ident)
                receipt = {"ok": True}
            elif command.get("type") == "moment.delete":
                payload = command.get("payload", {})
                if not isinstance(payload, dict):
                    raise ValueError("Expected command payload")
                ident = text(payload.get("moment_id"), "moment_id", 128)
                try:
                    await self.clips.delete(ident)
                except OSError as exc:
                    raise RuntimeError("Could not delete this moment's clip; please retry") from exc
                receipt = self.product.dispatch(command)
            else:
                receipt = self.product.dispatch(command)
            if command.get("type") == "capture.status":
                payload = command.get("payload", {})
                if payload.get("camera") == "live" and not self.camera_active:
                    self.clips.start()
                    self.camera_active = True
                elif payload.get("camera") == "off" and self.camera_active:
                    await self.clips.stop()
                    self.camera_active = False
                if self.decisions:
                    if "live" in self.product.capture.values():
                        self.decisions.start()
                    else:
                        await self.decisions.stop()
                        self.decision_tokens.clear()
                        self.decision_sources.clear()
                        self.last_decision_state = ""
            self.enqueue({"type": "v1.ack", "request_id": message.get("request_id"),
                          "receipt": receipt})
        elif kind == "stream.state":
            if message.get("kind") not in {"faces", "objects", "speech"}:
                raise ValueError("Unknown perception stream")
            if not isinstance(message.get("available"), bool):
                raise ValueError("Stream availability must be boolean")
            self.product.stream_state(message["kind"], message["available"],
                                      stream_id=message.get("stream_id"))
        elif kind in {"perception.faces", "perception.objects", "perception.speech"}:
            data = message.get("data")
            if not isinstance(data, dict):
                raise ValueError("Perception data must be an object")
            data = dict(data)
            if "capture_ts_ms" in message:
                data["observed_at"] = self.capture_time(message["capture_ts_ms"])
            methods = {"perception.faces": self.product.ingest_faces,
                       "perception.objects": self.product.ingest_objects,
                       "perception.speech": self.product.ingest_transcript}
            stream_id = message.get("stream_id")
            if kind == "perception.speech":
                accepted = self.product.ingest_transcript(data, stream_id=stream_id,
                                                         execute_rules=self.decisions is None)
            else:
                accepted = methods[kind](data, stream_id=stream_id)
            source_consumed = self._flush_decision_sources()
            if accepted and (not source_consumed or kind == "perception.speech"):
                self._decision_input(kind, data, stream_id)
        elif kind == "enrollment.status":
            self.product.dispatch({"type": "enrollment.status", "payload": {
                "data": message.get("data"), "stream_id": message.get("stream_id")}})
        elif kind == "ping":
            self.enqueue({"type": "v1.pong"})
        else:
            raise ValueError("Unknown V1 message")

    async def pause(self):
        self.product.stop()
        if self.decisions:
            await self.decisions.stop()
        self.decision_tokens.clear()
        self.decision_sources.clear()
        self.last_decision_state = ""
        self.camera_active = False
        await self.clips.stop()

    async def close(self):
        if self.closed:
            return
        await self.pause()
        self.closed = True
        if self.websocket:
            with contextlib.suppress(RuntimeError, WebSocketDisconnect):
                await self.websocket.close(code=1000)
        await self.clips.close()
        if self.decisions:
            await self.decisions.aclose()


class ProductSessions:
    """Small local resource owner; expires abandoned tabs and all temporary footage."""
    def __init__(self, gallery, same_origin, *, max_sessions=4, idle_ttl=900, decision_factory=None,
                 note_memory=None):
        self.gallery, self.same_origin = gallery, same_origin
        self.max_sessions, self.idle_ttl = max_sessions, idle_ttl
        self.sessions = {}
        self.decision_factory = decision_factory
        self.note_memory = note_memory
        self.router = APIRouter()
        self.router.add_api_route("/api/v1/sessions", self.create, methods=["POST"])
        self.router.add_api_route("/api/v1/sessions/{session_id}", self.snapshot, methods=["GET"])
        self.router.add_api_route("/api/v1/sessions/{session_id}", self.delete, methods=["DELETE"])
        self.router.add_api_route("/api/v1/sessions/{session_id}/clips/{clip_id}.mp4",
                                  self.clip, methods=["GET", "HEAD"])
        self.router.add_api_websocket_route("/ws/v1/{session_id}", self.socket)

    async def reap(self):
        now = time.time()
        stale = [sid for sid, s in self.sessions.items()
                 if s.closed or (not s.attached and now - s.last_used > self.idle_ttl)]
        for sid in stale:
            session = self.sessions.pop(sid, None)
            if session:
                await session.close()

    async def cleanup_loop(self):
        while True:
            await asyncio.sleep(30)
            await self.reap()

    async def close(self):
        sessions, self.sessions = list(self.sessions.values()), {}
        results = await asyncio.gather(*(s.close() for s in sessions), return_exceptions=True)
        if self.note_memory is not None:
            self.note_memory.close()
        for result in results:
            if isinstance(result, BaseException):
                raise result

    def get(self, session_id):
        session = self.sessions.get(session_id)
        if not session or session.closed:
            raise HTTPException(404, "Temporary session expired; start a new V1 session")
        session.touch()
        return session

    async def create(self):
        await self.reap()
        if len(self.sessions) >= self.max_sessions:
            raise HTTPException(429, "Four V1 sessions are already open. Close or reset an old tab.")
        try:
            backend = self.decision_factory() if self.decision_factory else None
        except (ValueError, RuntimeError) as exc:
            raise HTTPException(503, str(exc)) from None
        try:
            session = BrowserSession(self.gallery.list(), decision_backend=backend,
                                     note_memory=self.note_memory, delete_person=self.delete_person,
                                     on_note_change=self.sync_person_note)
        except (ValueError, RuntimeError) as exc:
            if backend is not None:
                await backend.aclose()
            raise HTTPException(503, str(exc)) from None
        self.sessions[session.id] = session
        return {"session_id": session.id, "snapshot": session.product.snapshot(),
                "websocket_url": f"/ws/v1/{session.id}",
                "limits": {"jpeg_max_bytes": session.clips.max_frame_bytes, "clip_fps": 5,
                           "audio_sample_rate": 16000, "idle_ttl_s": self.idle_ttl}}

    def sync_person_note(self, origin, kind, payload, profile_id):
        """Person notes are shared across open tabs; capture state and object notes are not."""
        for session in self.sessions.values():
            if session is not origin and not session.closed:
                session.sync_person_note(kind, payload, profile_id)

    def delete_person(self, person_id: str) -> bool:
        """Remove the enrollment and synchronize every open product session."""
        ident = text(person_id, "profile_id", 128)
        for session in self.sessions.values():
            profile = session.product.profiles.get(ident)
            if profile is not None and profile["kind"] != "person":
                raise ValueError("Only people can be deleted")
        try:
            deleted = self.gallery.delete(ident)
        except OSError as exc:
            raise RuntimeError("Could not save the face gallery; the person was not deleted") from exc
        # Do this before publishing success. A retry also cleans up notes if a
        # previous attempt removed the face but the note store was unavailable.
        if self.note_memory is not None:
            self.note_memory.delete_profile_notes(ident)
        for session in self.sessions.values():
            if not session.closed:
                session.product.delete_profile(ident, delete_notes=False)
                session.decision_tokens.clear()
                session.decision_sources.clear()
                session.last_decision_state = ""
        return deleted

    async def snapshot(self, session_id: str):
        return self.get(session_id).product.snapshot()

    async def delete(self, session_id: str):
        session = self.get(session_id)
        self.sessions.pop(session_id)
        await session.close()
        return {"deleted": True}

    async def clip(self, session_id: str, clip_id: str):
        session = self.get(session_id)
        status = session.clips.get(clip_id)
        if not status or status.status != "saved" or not status.clip:
            raise HTTPException(404, "This temporary clip is not available")
        return FileResponse(status.clip.path, media_type="video/mp4")

    async def socket(self, ws: WebSocket, session_id: str):
        if not self.same_origin(ws.headers):
            await ws.close(code=1008)
            return
        session = self.sessions.get(session_id)
        if not session or session.closed or session.attached:
            await ws.close(code=1008)
            return
        await ws.accept()
        session.attached = True
        session.websocket = ws
        session.clock_origin = session.device_origin = None
        session.overflow = False
        while not session.queue.empty():
            session.queue.get_nowait()

        async def send():
            while not session.closed:
                if session.overflow:
                    await ws.send_json({"type": "v1.error", "message": "UI fell behind; restart V1 capture"})
                    await ws.close(code=1013)
                    return
                message = await session.queue.get()
                await ws.send_json(message)

        async def tick():
            while not session.closed:
                session.tick()
                await asyncio.sleep(0.2)

        sender = asyncio.create_task(send())
        ticker = asyncio.create_task(tick())
        try:
            while not session.closed:
                incoming = await asyncio.wait_for(ws.receive(), timeout=60)
                if incoming["type"] == "websocket.disconnect":
                    break
                session.touch()
                request_id = None
                try:
                    if incoming.get("bytes") is not None:
                        session.receive_media(incoming["bytes"])
                    elif incoming.get("text") is not None:
                        if len(incoming["text"]) > 100_000:
                            raise ValueError("V1 JSON message is too large")
                        message = json.loads(incoming["text"])
                        request_id = message.get("request_id") if isinstance(message, dict) else None
                        await session.receive_json(message)
                except (ValueError, TypeError, KeyError, RuntimeError) as exc:
                    raw = incoming.get("bytes")
                    if raw and len(raw) >= 8 and raw[0] == 1:
                        seq = struct.unpack_from("<H", raw, 2)[0]
                        session.enqueue({"type": "v1.frame_ack", "seq": seq, "accepted": False})
                    session.enqueue({"type": "v1.error", "message": str(exc),
                                     "request_id": request_id})
        except (WebSocketDisconnect, asyncio.TimeoutError):
            pass
        finally:
            sender.cancel()
            ticker.cancel()
            with contextlib.suppress(asyncio.CancelledError, WebSocketDisconnect, RuntimeError):
                await sender
            with contextlib.suppress(asyncio.CancelledError):
                await ticker
            if session.websocket is ws:
                try:
                    await session.pause()
                finally:
                    # Do not admit a replacement socket until the old socket's
                    # asynchronous clip/capture cleanup has finished.
                    session.websocket = None
                    session.attached = False
