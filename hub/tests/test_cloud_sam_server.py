import asyncio
import importlib.util
import json
import subprocess
import sys
import threading
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from pathlib import Path
from types import SimpleNamespace

import pytest

ROOT = Path(__file__).resolve().parents[2]


def load(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / "deployments/sam3p1/model" / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


server = load("server")
windowed = load("windowed")


def control(data):
    return {"type": "websocket.receive", "text": json.dumps(data)}


def frame(index, wh=None):
    return [control({"type": "frame", "frame_id": str(index), "wh": wh or [100, 50]}),
            {"type": "websocket.receive", "bytes": b"\xff\xd8" + bytes([index]) + b"\xff\xd9"}]


class Socket:
    def __init__(self, messages):
        self.messages = iter(messages)
        self.sent = []
        self.closed = None

    async def receive(self):
        return next(self.messages, {"type": "websocket.disconnect"})

    async def send_json(self, value):
        self.sent.append(value)

    async def close(self, code=1000):
        self.closed = code


class Engine:
    def __init__(self):
        self.calls = []

    def infer(self, frames, wh, vocabulary, generation):
        self.calls.append((frames, wh, vocabulary, generation))
        return {"objects": [{"track_id": f"g{generation}:c0:o1", "label": vocabulary[0],
                             "box_xyxy": [1, 2, 30, 40], "score": 0.9}],
                "timings_ms": {}, "window_frames": len(frames)}


@pytest.mark.asyncio
async def test_only_arrived_frames_are_in_bounded_windows_and_ids_never_persist():
    engine = Engine()
    handler = server.WindowSocketServer(engine, 4)
    messages = [control({"type": "start_session", "vocabulary": ["person"]})]
    for index in range(1, 7):
        messages.extend(frame(index))
    messages.append(control({"type": "end_session"}))
    socket = Socket(messages)
    await handler.serve(socket)
    assert socket.sent[0] == {"type": "ready", "model_version": "sam3.1",
                              "streaming_mode": "windowed_reinitialization",
                              "tracking_persistent": False, "window_size": 4}
    assert [len(call[0]) for call in engine.calls] == [1, 2, 3, 4, 4, 4]
    for index, call in enumerate(engine.calls, 1):
        assert [data[2] for data in call[0]] == list(range(max(1, index - 3), index + 1))
    replies = socket.sent[1:]
    assert [item["tracker_generation"] for item in replies] == list(range(1, 7))
    assert len({item["objects"][0]["track_id"] for item in replies}) == 6
    assert all(item["wh"] == [100, 50] for item in replies)
    assert socket.closed == 1000 and handler.active is False


@pytest.mark.asyncio
async def test_add_concept_and_resolution_change_are_explicit():
    engine = Engine()
    handler = server.WindowSocketServer(engine, 4)
    socket = Socket([control({"type": "start_session", "vocabulary": ["person"]}),
                     *frame(1), control({"type": "add_concept", "noun": "car"}),
                     *frame(2), *frame(3, [200, 100])])
    await handler.serve(socket)
    assert engine.calls[0][2] == ["person"]
    assert engine.calls[1][2] == ["person", "car"]
    assert [len(item[0]) for item in engine.calls] == [1, 2, 1]
    assert {"type": "concept_added", "noun": "car"} in socket.sent


@pytest.mark.parametrize("bad", [
    control({"type": "frame", "frame_id": "x", "wh": [100, 50]}),
    control({"type": "start_session", "vocabulary": []}),
    control({"type": "start_session", "vocabulary": ["person", "person"]}),
    control({"type": "start_session", "vocabulary": [""]}),
    {"type": "websocket.receive", "text": "not json"},
])
@pytest.mark.asyncio
async def test_invalid_controls_never_infer(bad):
    engine = Engine()
    socket = Socket([bad])
    handler = server.WindowSocketServer(engine)
    await handler.serve(socket)
    assert engine.calls == []
    assert socket.sent[-1]["type"] == "error" and socket.closed == 1008
    assert not handler.active


@pytest.mark.parametrize("wh,payload", [([True, 20], b"\xff\xd8xx\xff\xd9"),
    ([5000, 50], b"\xff\xd8xx\xff\xd9"), ([100, 50], b"not jpeg")])
@pytest.mark.asyncio
async def test_bad_dimensions_or_jpeg_never_infer(wh, payload):
    engine = Engine()
    socket = Socket([control({"type": "start_session", "vocabulary": ["person"]}),
                     control({"type": "frame", "frame_id": "x", "wh": wh}),
                     {"type": "websocket.receive", "bytes": payload}])
    await server.WindowSocketServer(engine).serve(socket)
    assert not engine.calls and socket.sent[-1]["type"] == "error"


@pytest.mark.asyncio
async def test_cancel_waits_for_gpu_thread_before_releasing_admission():
    entered, release = threading.Event(), threading.Event()

    class BlockingEngine(Engine):
        def infer(self, *args):
            entered.set()
            release.wait(timeout=2)
            return super().infer(*args)

    handler = server.WindowSocketServer(BlockingEngine())
    socket = Socket([control({"type": "start_session", "vocabulary": ["person"]}), *frame(1)])
    task = asyncio.create_task(handler.serve(socket))
    while not entered.is_set():
        await asyncio.sleep(0.001)
    task.cancel()
    await asyncio.sleep(0)
    assert handler.active
    other = Socket([])
    await handler.serve(other)
    assert other.closed == 1013
    release.set()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert not handler.active


def test_absolute_sent_box_conversion_and_generation_label_identity():
    output = {"out_obj_ids": [7], "out_probs": [0.9], "out_boxes_xywh": [[0.1, 0.2, 0.3, 0.4]]}
    result = windowed.output_objects(output, "keys", (200, 100), 3, 2)
    assert result[0]["box_xyxy"] == pytest.approx([20, 20, 80, 60])
    assert result[0]["track_id"] == "g3:c2:o7" and result[0]["label"] == "keys"
    output["out_probs"] = [float("nan")]
    with pytest.raises(RuntimeError):
        windowed.output_objects(output, "keys", (200, 100), 3, 2)


@pytest.mark.parametrize("fail_prompt", [False, True])
def test_independent_concept_sessions_always_close_and_only_newest_is_returned(monkeypatch, fail_prompt):
    class FakeImage:
        format = "JPEG"
        size = (100, 50)

        def __enter__(self): return self
        def __exit__(self, *args): pass
        def verify(self): pass

    monkeypatch.setitem(sys.modules, "PIL", SimpleNamespace(Image=SimpleNamespace(open=lambda _: FakeImage())))

    class Predictor:
        def __init__(self):
            self.requests, self.closed = [], []

        def handle_request(self, request):
            self.requests.append(request)
            if request["type"] == "start_session":
                assert len(list(Path(request["resource_path"]).glob("*.jpg"))) == 2
                return {"session_id": str(len(self.requests))}
            if request["type"] == "close_session":
                self.closed.append(request["session_id"])
                return {}
            if fail_prompt:
                raise RuntimeError("model failed")
            return {"frame_index": 0, "outputs": {}}

        def handle_stream_request(self, request):
            for index in range(2):
                yield {"frame_index": index, "outputs": {
                    "out_obj_ids": [index], "out_probs": [.8],
                    "out_boxes_xywh": [[.1, .2, .3, .4]],
                }}

    predictor = Predictor()
    engine = windowed.WindowedSamEngine(None, predictor=predictor)
    if fail_prompt:
        with pytest.raises(RuntimeError, match="model failed"):
            engine.infer([b"one", b"two"], (100, 50), ["person", "car"], 1)
        assert len(predictor.closed) == 1
    else:
        result = engine.infer([b"one", b"two"], (100, 50), ["person", "car"], 1)
        assert len(predictor.closed) == 2 and len(set(predictor.closed)) == 2
        assert [item["label"] for item in result["objects"]] == ["person", "car"]
        assert all(item["track_id"].endswith(":o1") for item in result["objects"])


def test_truss_entrypoint_does_not_accept_again():
    source = (ROOT / "deployments/sam3p1/model/model.py").read_text()
    assert "websocket.accept" not in source


def test_truss_entrypoint_imports_without_package_context():
    # Managed Truss loads this file directly with spec_from_file_location.
    # Package-relative entry imports pass ordinary imports but fail in production.
    script = """
import importlib.util
import sys
from types import SimpleNamespace
sys.modules['fastapi'] = SimpleNamespace(WebSocket=object)
spec = importlib.util.spec_from_file_location('truss_user_model', 'model/model.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
assert module.Model and module.WindowSocketServer and module.WindowedSamEngine
assert 'torch' not in sys.modules
"""
    subprocess.run([sys.executable, "-c", script], cwd=ROOT / "deployments/sam3p1", check=True)


@pytest.mark.asyncio
async def test_arbitrary_model_value_error_is_not_exposed():
    class BrokenEngine:
        def infer(self, *args):
            raise ValueError("private input or internal credential must not be exposed")

    socket = Socket([control({"type": "start_session", "vocabulary": ["person"]}), *frame(1)])
    handler = server.WindowSocketServer(BrokenEngine())
    await handler.serve(socket)
    assert socket.sent[-1] == {"type": "error", "message": "SAM inference or connection failed"}
    assert not handler.active


def test_gpu_precision_context_is_entered_on_actual_executor_thread():
    local = threading.local()
    parent_thread = threading.get_ident()

    @contextmanager
    def scope(name):
        local.active = [*getattr(local, "active", []), name]
        try:
            yield
        finally:
            local.active.pop()

    engine = windowed.WindowedSamEngine(None, predictor=object())
    engine.torch = SimpleNamespace(
        bfloat16="bf16", inference_mode=lambda: scope("inference"),
        autocast=lambda device, dtype: scope(f"autocast:{device}:{dtype}"),
    )

    def infer(*args):
        assert threading.get_ident() != parent_thread
        assert local.active == ["inference", "autocast:cuda:bf16"]
        return {"executed": True}

    engine._infer_window = infer
    with ThreadPoolExecutor(max_workers=1) as pool:
        assert pool.submit(engine.infer, [], (1, 1), [], 1).result() == {"executed": True}
    assert not getattr(local, "active", [])
