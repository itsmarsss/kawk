"""Local buffalo_l, explicit enrollment, and a small persistent gallery."""
from __future__ import annotations

import os
import time
import uuid
from pathlib import Path

import numpy as np

MODEL = "buffalo_l"


def unit(vector):
    vector = np.asarray(vector, dtype=np.float32)
    if vector.shape != (512,) or not np.isfinite(vector).all():
        raise ValueError("Expected a finite 512-dimensional face embedding")
    norm = np.linalg.norm(vector)
    if norm < 1e-6:
        raise ValueError("Empty face embedding")
    return vector / norm


class Gallery:
    def __init__(self, path: Path):
        self.path = path
        self.entries = {}
        if path.exists():
            with np.load(path, allow_pickle=False) as data:
                if str(data["model"].item()) != MODEL:
                    raise ValueError("Gallery model mismatch; use a buffalo_l gallery")
                for person_id, name, embedding in zip(data["ids"], data["names"], data["embeddings"]):
                    self.entries[str(person_id)] = (str(name), unit(embedding))

    def list(self):
        return [{"id": key, "name": row[0]} for key, row in self.entries.items()]

    def save(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        temp = self.path.with_suffix(".tmp")
        with temp.open("wb") as file:
            np.savez(file, model=MODEL, ids=np.asarray(list(self.entries), dtype=str),
                     names=np.asarray([v[0] for v in self.entries.values()], dtype=str),
                     embeddings=np.asarray([v[1] for v in self.entries.values()], dtype=np.float32).reshape(-1, 512))
        os.chmod(temp, 0o600)
        os.replace(temp, self.path)

    def enroll(self, name, embeddings):
        name = name.strip()
        if not 1 <= len(name) <= 80 or any(ord(char) < 32 for char in name):
            raise ValueError("Enter a name of 1–80 characters")
        if not 5 <= len(embeddings) <= 10:
            raise ValueError("Enrollment needs 5–10 usable frames")
        vectors = [unit(vector) for vector in embeddings]
        if any(float(vectors[0] @ vector) < 0.45 for vector in vectors[1:]):
            raise ValueError("Faces changed during enrollment; try again with one person")
        person_id = uuid.uuid4().hex
        self.entries[person_id] = (name, unit(np.mean(vectors, axis=0)))
        self.save()
        return {"id": person_id, "name": name}

    def delete(self, person_id):
        if person_id not in self.entries:
            return False
        del self.entries[person_id]
        self.save()
        return True

    def match(self, embedding, threshold=0.40):
        if not self.entries:
            return {"id": None, "name": None, "similarity": None}
        vector = unit(embedding)
        person_id, score = max(((key, float(vector @ row[1])) for key, row in self.entries.items()), key=lambda row: row[1])
        return {"id": person_id if score >= threshold else None,
                "name": self.entries[person_id][0] if score >= threshold else None,
                "similarity": score}


class FaceEngine:
    def __init__(self, root: Path, provider="CoreMLExecutionProvider"):
        # Lazy imports keep health and speech available without face dependencies.
        import cv2
        import onnxruntime as ort
        from insightface.app import FaceAnalysis

        for name in ("det_10g.onnx", "w600k_r50.onnx"):
            if not (root / "models" / MODEL / name).is_file():
                raise RuntimeError(f"Missing {name}. Set REMEMBER_FACE_MODEL_ROOT to a directory containing models/buffalo_l; no automatic download.")
        if provider not in ort.get_available_providers():
            raise RuntimeError(f"{provider} is unavailable; select CPUExecutionProvider explicitly if needed")
        cv2.setNumThreads(1)
        started = time.perf_counter()
        self.app = FaceAnalysis(name=MODEL, root=str(root), allowed_modules=["detection", "recognition"], providers=[provider])
        self.app.prepare(ctx_id=-1 if provider == "CPUExecutionProvider" else 0, det_size=(640, 640), det_thresh=0.5)
        self.providers = {name: model.session.get_providers() for name, model in self.app.models.items()}
        if any(value[0] != provider for value in self.providers.values()):
            raise RuntimeError(f"Unexpected execution providers: {self.providers}")
        self.load_ms = (time.perf_counter() - started) * 1000

    def infer(self, jpeg):
        import cv2
        from insightface.utils import face_align

        start = time.perf_counter()
        frame = cv2.imdecode(np.frombuffer(jpeg, dtype=np.uint8), cv2.IMREAD_COLOR)
        if frame is None or max(frame.shape[:2]) > 640:
            raise ValueError("Send a JPEG with longest side at most 640 pixels")
        decode_end = time.perf_counter()
        boxes, points = self.app.det_model.detect(frame, max_num=0, metric="default")
        detect_end = time.perf_counter()
        faces = []
        for box, landmarks in zip(boxes, points if points is not None else []):
            if min(box[2] - box[0], box[3] - box[1]) < 80:
                continue
            aligned = face_align.norm_crop(frame, landmark=landmarks, image_size=112)
            embedding = unit(self.app.models["recognition"].get_feat(aligned).reshape(-1))
            faces.append({"box": box[:4].tolist(), "detection_score": float(box[4]), "embedding": embedding})
        return {"faces": faces, "detected_count": len(boxes), "input_wh": [frame.shape[1], frame.shape[0]],
                "timings_ms": {"decode": (decode_end - start) * 1000,
                               "detection": (detect_end - decode_end) * 1000,
                               "embedding_and_alignment": (time.perf_counter() - detect_end) * 1000,
                               "inference": (time.perf_counter() - start) * 1000}}


def iou(a, b):
    overlap = max(0, min(a[2], b[2]) - max(a[0], b[0])) * max(0, min(a[3], b[3]) - max(a[1], b[1]))
    area = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1])
    return overlap / max(1, area - overlap)


class FaceSession:
    """Per-camera votes and enrollment; embeddings never leave the Mac server."""
    def __init__(self, gallery):
        self.gallery = gallery
        self.tracks = []
        self.next_track = 1
        self.enrolling = None
        self.observed_track_ids = set()
        self.detected_count = 0

    def begin_enrollment(self, name, target_track_id=None):
        name = str(name).strip()
        if not 1 <= len(name) <= 80 or any(ord(char) < 32 for char in name):
            raise ValueError("Enter a name of 1–80 characters")
        now = time.monotonic()
        anchor = None
        if target_track_id is not None:
            if (isinstance(target_track_id, str) and target_track_id.isascii()
                    and target_track_id.isdecimal() and not target_track_id.startswith("0")):
                target_track_id = int(target_track_id)
            if isinstance(target_track_id, bool) or not isinstance(target_track_id, int) or target_track_id < 1:
                raise ValueError("Choose an observed face track for this introduction")
            target = next((track for track in self.tracks if track["track_id"] == target_track_id), None)
            if target is None or target_track_id not in self.observed_track_ids or now - target["seen"] >= 1:
                raise ValueError("The introduced face is no longer in view; start the introduction again")
            if self.detected_count != 1 or len(self.observed_track_ids) != 1:
                raise ValueError("Keep only the introduced person in view before enrolling")
            if target["stable_id"] is not None or target["match_id"] is not None:
                raise ValueError("This face is already recognized; choose an unknown person")
            # Bind to the face observed when the name was supplied, including before
            # the first enrollment sample. IoU tracking alone can reuse a track.
            anchor = target["embedding"].copy()
        self.enrolling = {"name": name, "samples": [], "started": now,
                          "target_track_id": target_track_id, "anchor": anchor}

    def _process_bound_enrollment(self, state, result, output, now):
        enrollment = {"name": state["name"], "collected": len(state["samples"]),
                      "required": 5, "status": "collecting", "reason": "collecting",
                      "target_track_id": state["target_track_id"]}
        reason, message = None, None
        if now - state["started"] > 30:
            reason, message = "enrollment_timeout", "Enrollment timed out. Start the introduction again."
        elif result["detected_count"] > 1 or len(output) > 1:
            reason, message = "ambiguous_faces", "Another face entered view. Start again with only the introduced person visible."
        elif len(output) != 1 or result["detected_count"] != 1:
            reason, message = "target_missing", "The introduced face is no longer usable or visible. Start the introduction again."
        elif output[0]["track_id"] != state["target_track_id"]:
            reason, message = "target_changed", "The introduced face track changed. Start the introduction again."
        elif output[0]["stable_id"] is not None or output[0]["match"]["id"] is not None:
            reason, message = "target_known", "This face is already recognized; no new enrollment was saved."
        else:
            vector = unit(result["faces"][0]["embedding"])
            if float(state["anchor"] @ vector) < 0.45 or (
                state["samples"] and float(state["samples"][0] @ vector) < 0.45
            ):
                reason, message = "target_changed", "The face changed during the introduction. Start again with the same person."
            else:
                state["samples"].append(vector)
                enrollment["collected"] = len(state["samples"])
                if len(state["samples"]) >= 5:
                    enrollment.update(status="complete", reason="enrollment_complete",
                                      person=self.gallery.enroll(state["name"], state["samples"]))
                    self.enrolling = None
        if reason is not None:
            enrollment.update(status="error", reason=reason, message=message)
            self.enrolling = None
        return enrollment

    def process(self, result):
        now = time.monotonic()
        available = [track for track in self.tracks if now - track["seen"] < 1]
        updated, output = [], []
        for face in result["faces"]:
            match = self.gallery.match(face["embedding"])
            track = max(available, key=lambda item: iou(item["box"], face["box"]), default=None)
            if track and iou(track["box"], face["box"]) >= 0.25:
                available.remove(track)
            else:
                track = {"track_id": self.next_track, "votes": [], "stable_id": None}
                self.next_track += 1
            track.update(box=face["box"], seen=now, embedding=unit(face["embedding"]), match_id=match["id"])
            candidate = match["id"]
            if candidate is not None and (
                track["stable_id"] not in (None, candidate)
                or any(vote not in (None, candidate) for vote in track["votes"])
            ):
                # A conflicting positive match must never inherit the old name or
                # combine alternating people into a two-out-of-three majority.
                track["votes"] = []
                track["stable_id"] = None
            track["votes"] = (track["votes"] + [candidate])[-3:]
            if candidate is not None and track["votes"].count(candidate) >= 2:
                track["stable_id"] = candidate
                track["identity_seen"] = now
            elif candidate is None and track["stable_id"] is not None and (
                now - track["identity_seen"] >= 1
                or track["votes"] == [None, None, None]
            ):
                # A brief weak frame may coast, but repeated weak evidence cannot
                # keep a name forever, even while geometric tracking continues.
                track["stable_id"] = None
            stable = self.gallery.entries.get(track["stable_id"])
            updated.append(track)
            output.append({"box": face["box"], "detection_score": face["detection_score"],
                           "track_id": track["track_id"], "match": match,
                           "stable_name": stable[0] if stable else None,
                           "stable_id": track["stable_id"] if stable else None})
        self.tracks = updated + available
        self.observed_track_ids = {track["track_id"] for track in updated}
        self.detected_count = result["detected_count"]
        enrollment = None
        if self.enrolling:
            state = self.enrolling
            if state.get("target_track_id") is not None:
                enrollment = self._process_bound_enrollment(state, result, output, now)
                return {"faces": output, "enrollment": enrollment}
            enrollment = {"name": state["name"], "collected": len(state["samples"]), "required": 5, "status": "collecting"}
            if now - state["started"] > 30:
                enrollment.update(status="error", message="Enrollment timed out. Try again with one face in view.")
                self.enrolling = None
            elif len(result["faces"]) != 1 or result["detected_count"] != 1:
                state["samples"].clear()
                enrollment.update(collected=0, message="Keep exactly one face in view and move closer.")
            else:
                vector = result["faces"][0]["embedding"]
                if state["samples"] and float(state["samples"][0] @ vector) < 0.45:
                    state["samples"].clear()
                state["samples"].append(vector)
                enrollment["collected"] = len(state["samples"])
                if len(state["samples"]) >= 5:
                    enrollment.update(status="complete", person=self.gallery.enroll(state["name"], state["samples"]))
                    self.enrolling = None
        return {"faces": output, "enrollment": enrollment}
