"""Real pinned SAM3.1 on bounded, already-arrived JPEG windows.

This reinitializes tracking on every update. It is not an appendable/infinite
upstream video session, and it deliberately makes no persistent-ID claim.
"""

import hashlib
import inspect
import io
import math
import tempfile
from pathlib import Path
from time import perf_counter

CODE_REVISION = "2345a4ad109ac29c569da749c91d84f10dc08c40"
WEIGHT_SHA256 = "0567debeec80ba4ac6369540c6c248025283cb3ff2b92827509e57e2b3541cb6"


def check_checkpoint(path):
    digest = hashlib.sha256()
    with open(path, "rb") as source:
        for chunk in iter(lambda: source.read(8 * 1024 * 1024), b""):
            digest.update(chunk)
    if digest.hexdigest() != WEIGHT_SHA256:
        raise RuntimeError("SAM3.1 checkpoint SHA256 does not match the pinned Meta checkpoint")


def output_objects(output, label, wh, generation, concept_index):
    """Official out_boxes_xywh is normalized; produce absolute SENT xyxy."""
    ids, boxes, scores = (output[name] for name in ("out_obj_ids", "out_boxes_xywh", "out_probs"))
    if not len(ids) == len(boxes) == len(scores):
        raise RuntimeError("SAM3.1 output lengths disagree")
    width, height = wh
    objects = []
    for object_id, box, probability in zip(ids, boxes, scores):
        x, y, w, h = map(float, box)
        score = float(probability)
        if not all(math.isfinite(v) for v in (x, y, w, h, score)) or w < 0 or h < 0:
            raise RuntimeError("SAM3.1 returned an invalid box")
        if not 0 <= score <= 1:
            raise RuntimeError("SAM3.1 returned an invalid score")
        xyxy = [max(0, min(width, x * width)), max(0, min(height, y * height)),
                max(0, min(width, (x + w) * width)), max(0, min(height, (y + h) * height))]
        if xyxy[2] <= xyxy[0] or xyxy[3] <= xyxy[1]:
            continue
        objects.append({"track_id": f"g{generation}:c{concept_index}:o{int(object_id)}",
                        "label": label, "box_xyxy": xyxy, "score": score})
    return objects


class WindowedSamEngine:
    def __init__(self, checkpoint, *, predictor=None):
        self.load_report = {}
        self.predictor = predictor
        self.torch = None
        if predictor is not None:
            return  # Test dependency; cannot be selected by the deployed Model.
        import torch
        from sam3.model_builder import build_sam3_predictor

        self.torch = torch
        check_checkpoint(checkpoint)
        start = perf_counter()
        torch.set_num_threads(4)
        self.predictor = build_sam3_predictor(
            checkpoint_path=str(checkpoint), version="sam3.1", compile=False,
            warm_up=False, max_num_objects=16, multiplex_count=16,
            use_fa3=False, use_rope_real=True, async_loading_frames=False,
        )
        weights = torch.load(checkpoint, map_location="cpu", weights_only=True)
        if "model" in weights and isinstance(weights["model"], dict):
            weights = weights["model"]
        derived = []
        for key in self.predictor.model.state_dict():
            if key not in weights and key.endswith((".freqs_cis_real", ".freqs_cis_imag")):
                source = weights[key[:-5]]
                weights[key] = source.real if key.endswith("_real") else source.imag
                derived.append(key)
        self.predictor.model.load_state_dict(weights, strict=True)
        del weights
        model = self.predictor.model
        shim = "offload_state_to_cpu" not in inspect.signature(model.init_state).parameters
        if shim:
            original = model.init_state

            def compatible_init_state(*args, offload_state_to_cpu=False, **kwargs):
                if offload_state_to_cpu:
                    raise NotImplementedError("Multiplex CPU state offloading is unsupported")
                return original(*args, **kwargs)

            model.init_state = compatible_init_state
        # Disable filters that need future frames; the window ends at NOW.
        settings = {
            "hotstart_delay": 0, "hotstart_unmatch_thresh": 0, "hotstart_dup_thresh": 0,
            "postprocess_batch_size": 1, "use_batched_grounding": False,
            "batched_grounding_batch_size": 1, "masklet_confirmation_enable": False,
            "masklet_confirmation_consecutive_det_thresh": 1,
        }
        for key, value in settings.items():
            setattr(model, key, value)
        torch.cuda.synchronize()
        self.load_report = {"code_revision": CODE_REVISION, "checkpoint_sha256": WEIGHT_SHA256,
                            "checkpoint_strict_load": True, "derived_buffers": derived,
                            "init_state_shim": shim, "settings": settings,
                            "model_load_seconds": perf_counter() - start,
                            "gpu": torch.cuda.get_device_name(0), "torch": torch.__version__,
                            "compile": False, "precision": "bfloat16 autocast"}

    def memory(self):
        if self.torch is None:
            return {}
        return {"allocated_gib": self.torch.cuda.memory_allocated() / 2**30,
                "reserved_gib": self.torch.cuda.memory_reserved() / 2**30,
                "peak_allocated_gib": self.torch.cuda.max_memory_allocated() / 2**30,
                "active_sessions": len(self.predictor._all_inference_states)}

    def infer(self, frames, wh, vocabulary, generation):
        # Both contexts are thread-local. The builder may enable autocast on its
        # loading thread; an async server's executor does NOT inherit that state.
        if self.torch is not None:
            with self.torch.inference_mode(), self.torch.autocast("cuda", dtype=self.torch.bfloat16):
                return self._infer_window(frames, wh, vocabulary, generation)
        return self._infer_window(frames, wh, vocabulary, generation)

    def _infer_window(self, frames, wh, vocabulary, generation):
        from PIL import Image

        start = perf_counter()
        if not 1 <= len(frames) <= 4:
            raise ValueError("SAM3.1 requires 1–4 already-received JPEGs")
        if self.torch is not None:
            self.torch.cuda.reset_peak_memory_stats()
        stages = {"session": 0.0, "prompt": 0.0, "propagate": 0.0, "cleanup": 0.0}
        objects = []
        with tempfile.TemporaryDirectory(prefix="sam31-arrived-") as directory:
            for index, jpeg in enumerate(frames):
                with Image.open(io.BytesIO(jpeg)) as image:
                    if image.format != "JPEG" or image.size != tuple(wh):
                        raise ValueError("JPEG dimensions/format disagree with frame metadata")
                    image.verify()
                Path(directory, f"{index:05d}.jpg").write_bytes(jpeg)
            # Each noun receives an independent session; prompts cannot overwrite
            # earlier nouns or silently assign their label to another concept.
            for concept_index, label in enumerate(vocabulary):
                session = None
                try:
                    phase = perf_counter()
                    session = self.predictor.handle_request({
                        "type": "start_session", "resource_path": directory,
                        "offload_video_to_cpu": True,
                    })["session_id"]
                    stages["session"] += (perf_counter() - phase) * 1000
                    phase = perf_counter()
                    prompted = self.predictor.handle_request({
                        "type": "add_prompt", "session_id": session,
                        "frame_index": 0, "text": label,
                    })
                    stages["prompt"] += (perf_counter() - phase) * 1000
                    phase = perf_counter()
                    newest = prompted if len(frames) == 1 else None
                    if len(frames) > 1:
                        stream = self.predictor.handle_stream_request({
                            "type": "propagate_in_video", "session_id": session,
                            "propagation_direction": "forward", "start_frame_index": 0,
                            "max_frame_num_to_track": len(frames),
                        })
                        try:
                            for item in stream:
                                if item["frame_index"] == len(frames) - 1:
                                    newest = item
                        finally:
                            stream.close()
                    if newest is None or newest["frame_index"] != len(frames) - 1:
                        raise RuntimeError("SAM3.1 did not return the latest received frame")
                    objects.extend(output_objects(newest["outputs"], label, wh, generation, concept_index))
                    del newest, prompted
                    stages["propagate"] += (perf_counter() - phase) * 1000
                finally:
                    if session is not None:
                        phase = perf_counter()
                        self.predictor.handle_request({"type": "close_session", "session_id": session})
                        stages["cleanup"] += (perf_counter() - phase) * 1000
        if self.torch is not None:
            self.torch.cuda.synchronize()
        stages["inference_total"] = (perf_counter() - start) * 1000
        return {"objects": objects, "timings_ms": stages, "memory": self.memory(),
                "window_frames": len(frames), "concept_count": len(vocabulary)}
