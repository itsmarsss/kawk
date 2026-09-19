"""The world model — the only truth (AGENTS.md §3.4, §8).

Perception writes here via bus subscriptions; Jev reads a serialization (snapshot.py);
tasks query it. Publishes WorldDelta events on world.delta.
"""

from __future__ import annotations

import time
from collections import deque

from ..bus import EventBus
from ..config import FaceCfg, WorldCfg
from ..contracts.percepts import AudioState, Detection, FaceObservation, TranscriptSegment
from ..contracts.world import DeltaKind, Entity, LastSeen, PersonAttrs, WorldDelta
from ..memory.faces import FaceGallery
from ..memory.store import MemoryStore
from .tracks import TrackTable, iou


class WorldModel:
    def __init__(
        self,
        bus: EventBus,
        cfg: WorldCfg,
        face_cfg: FaceCfg,
        memory: MemoryStore,
        gallery: FaceGallery,
        score_threshold: float = 0.35,
    ) -> None:
        self.bus = bus
        self.cfg = cfg
        self.face_cfg = face_cfg
        self.memory = memory
        self.gallery = gallery
        self.tracks = TrackTable(cfg, score_threshold)
        self.transcript: dict[str, TranscriptSegment] = {}
        self._transcript_order: deque[str] = deque(maxlen=200)
        self._seg_wall: dict[str, float] = {}
        self.audio_state = AudioState(speech_active=False)
        self.events: deque[tuple[float, str]] = deque(maxlen=100)
        self._face_buffers: dict[str, deque[FaceObservation]] = {}
        self._vote_buffers: dict[str, deque[str | None]] = {}

        bus.subscribe("percepts.detections", self.on_detections)
        bus.subscribe("percepts.face", self.on_face)
        bus.subscribe("percepts.stt", self.on_stt)
        bus.subscribe("percepts.audio", self.on_audio)

    # ---- perception ingest ---------------------------------------------------

    async def on_detections(self, detections: list[Detection]) -> None:
        now = time.time()
        appeared, ended = self.tracks.update(detections, now)
        for ent in appeared:
            self._event(now, f"{ent.label}#{ent.track_id} appeared")
            await self.bus.publish(
                "world.delta",
                WorldDelta(kind=DeltaKind.APPEARED, entity_id=ent.track_id, label=ent.label),
            )
        for ent in ended:
            await self._end_track(ent, now)

    async def _end_track(self, ent: Entity, now: float) -> None:
        self._face_buffers.pop(ent.track_id, None)
        self._vote_buffers.pop(ent.track_id, None)
        await self.bus.publish(
            "world.delta",
            WorldDelta(kind=DeltaKind.DISAPPEARED, entity_id=ent.track_id, label=ent.label),
        )
        if ent.label == "person":
            return
        context = [
            e.label
            for e in self.tracks.in_view(now)
            if e.track_id != ent.track_id and e.label != "person"
        ][:3]
        ls = LastSeen(
            label=ent.label,
            ts=ent.last_seen,
            keyframe_ref=ent.keyframe_ref,  # None in mock mode; frames.py lands in M3
            context_labels=context,
        )
        self.memory.write_last_seen(ls)
        self._event(now, f"{ent.label} last-seen recorded")
        await self.bus.publish(
            "world.delta",
            WorldDelta(kind=DeltaKind.LAST_SEEN_WRITTEN, entity_id=ent.track_id, label=ent.label),
        )

    async def on_face(self, observations: list[FaceObservation]) -> None:
        now = time.time()
        for obs in observations:
            if obs.det_score < 0.5:
                continue
            # Reject tiny crops (§6.2) — but frame_wh (1,1) means normalized synthetic
            # boxes from the mock, where pixel checks are meaningless (notes/KNOWLEDGE.md).
            if obs.frame_wh[0] > 1:
                width_px = (obs.box_xyxy[2] - obs.box_xyxy[0]) * 1.0
                if width_px < self.face_cfg.min_bbox_px:
                    continue
            track_id = obs.track_id or self._sole_person_track()
            if track_id is None or track_id not in self.tracks.entities:
                continue
            buf = self._face_buffers.setdefault(track_id, deque(maxlen=12))
            buf.append(obs)
            await self._vote_identity(track_id, obs, now)

    async def _vote_identity(self, track_id: str, obs: FaceObservation, now: float) -> None:
        ent = self.tracks.entities[track_id]
        match = self.gallery.match(obs.embedding, obs.model_tag, self.face_cfg.match_threshold)
        votes = self._vote_buffers.setdefault(track_id, deque(maxlen=self.face_cfg.vote_n))
        votes.append(match.person_id if match else None)
        if len(votes) < self.face_cfg.vote_n or len(set(votes)) != 1:
            return
        current = ent.person.person_id if ent.person else None
        winner = votes[0]
        if winner == current:
            if ent.person and match:
                ent.person.sim = match.sim
                ent.person.stable_votes += 1
            return
        if winner is None:
            return  # never demote a name back to unknown on a vote of Nones (§6.2 hysteresis)
        assert match is not None
        ent.person = PersonAttrs(
            person_id=match.person_id,
            name=match.name,
            sim=match.sim,
            stable_votes=self.face_cfg.vote_n,
        )
        self._event(now, f"person#{track_id} identified as {match.name}")
        await self.bus.publish(
            "world.delta",
            WorldDelta(kind=DeltaKind.IDENTITY_CHANGED, entity_id=track_id, label="person"),
        )

    async def on_stt(self, seg: TranscriptSegment) -> None:
        if seg.seg_id not in self.transcript:
            self._transcript_order.append(seg.seg_id)
        self.transcript[seg.seg_id] = seg  # partials revise by seg_id (§6.3)
        self._seg_wall[seg.seg_id] = time.time()
        if seg.is_final:
            self.memory.add_transcript(seg)

    async def on_audio(self, state: AudioState) -> None:
        self.audio_state = state

    # ---- queries used by snapshot/gate/tasks ----------------------------------

    def in_view(self) -> list[Entity]:
        return self.tracks.in_view()

    def find_live(self, label: str) -> Entity | None:
        for ent in self.in_view():
            if ent.label == label:
                return ent
        return None

    def known_labels(self) -> list[str]:
        live = {e.label for e in self.in_view() if e.label != "person"}
        remembered = {ls.label for ls in self.memory.recent_last_seen(10)}
        return sorted(live | remembered)

    def stable_unknown_person(self, min_dwell_s: float = 3.0) -> str | None:
        now = time.time()
        for ent in self.in_view():
            if ent.label != "person":
                continue
            named = ent.person is not None and ent.person.name
            if not named and now - ent.first_seen >= min_dwell_s:
                return ent.track_id
        return None

    def face_embeddings(self, track_id: str, n: int = 10) -> tuple[list[list[float]], str | None]:
        buf = self._face_buffers.get(track_id)
        if not buf:
            return [], None
        obs = list(buf)[-n:]
        return [o.embedding for o in obs], obs[-1].model_tag

    def reset_identity_votes(self, track_id: str) -> None:
        self._vote_buffers.pop(track_id, None)

    def recent_finals(self, window_s: float = 15.0) -> list[TranscriptSegment]:
        now = time.time()
        out = []
        for seg_id in self._transcript_order:
            seg = self.transcript[seg_id]
            if seg.is_final and now - self._seg_wall.get(seg_id, 0.0) <= window_s:
                out.append(seg)
        return out

    def last_utterance(self) -> str:
        finals = self.recent_finals(60.0)
        return finals[-1].text if finals else ""

    def speech_active(self) -> bool:
        if self.audio_state.speech_active:
            return True
        finals = self.recent_finals(2.0)
        return bool(finals)

    def user_in_conversation(self) -> bool:
        person_in_view = any(e.label == "person" for e in self.in_view())
        return person_in_view and bool(self.recent_finals(10.0))

    def recent_events(self, window_s: float = 30.0) -> list[str]:
        now = time.time()
        return [text for t, text in self.events if now - t <= window_s]

    def held_by(self, ent: Entity) -> str | None:
        """Attribute derivation §8: object center contained in a person box."""
        cx = (ent.box_xyxy[0] + ent.box_xyxy[2]) / 2
        cy = (ent.box_xyxy[1] + ent.box_xyxy[3]) / 2
        for person in self.in_view():
            if person.label != "person" or person.track_id == ent.track_id:
                continue
            x1, y1, x2, y2 = person.box_xyxy
            if x1 <= cx <= x2 and y1 <= cy <= y2 and iou(ent.box_xyxy, person.box_xyxy) > 0:
                return person.track_id
        return None

    def _sole_person_track(self) -> str | None:
        people = [e.track_id for e in self.in_view() if e.label == "person"]
        return people[0] if len(people) == 1 else None

    def _event(self, t: float, text: str) -> None:
        self.events.append((t, text))
        self.memory.record_event("world", text, t)
