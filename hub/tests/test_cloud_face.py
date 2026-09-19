import asyncio
import base64

import pytest
from remember_hub.perception.face.baseten_http import BasetenFaceBackend


def payload():
    return {
        "model": "buffalo_l",
        "input_wh": [640, 480],
        "detected_count": 2,
        "faces": [
            {"box": [10, 20, 110, 120], "det_score": 0.9, "embedding_512": [1.0] + [0.0] * 511}
        ],
        "timings_ms": {"handler_total": 7.5},
    }


class Client:
    def __init__(self, data=None):
        self.data = payload() if data is None else data
        self.calls = []
        self.gate = None

    async def post(self, url, **kw):
        self.calls.append((url, kw))
        if self.gate is not None:
            await self.gate.wait()
        return self

    def raise_for_status(self):
        pass

    def json(self):
        return self.data


async def test_face_actual_request_schema_and_sent_geometry():
    client = Client()
    backend = BasetenFaceBackend("qvm6y6eq", "test", client=client)
    result = await backend.embed_faces(b"jpeg", (640, 480))
    assert result[0].box == (10, 20, 110, 120)
    assert result[0].model == "buffalo_l"
    url, call = client.calls[0]
    assert url.endswith("/environments/production/predict")
    assert call["headers"] == {"Authorization": "Api-Key test"}
    assert base64.b64decode(call["json"]["image_b64"]) == b"jpeg"
    assert call["json"]["min_face_size"] == 80
    assert backend.last_timings_ms["handler_total"] == 7.5
    assert backend.last_detected_count == 2


@pytest.mark.parametrize("mutation", ["model", "dimensions", "norm", "nan", "box"])
async def test_face_rejects_mismatched_or_corrupt_response(mutation):
    data = payload()
    if mutation == "model":
        data["model"] = "buffalo_s"
    elif mutation == "dimensions":
        data["input_wh"] = [1280, 720]
    elif mutation == "norm":
        data["faces"][0]["embedding_512"] = [0.0] * 512
    elif mutation == "nan":
        data["faces"][0]["embedding_512"][0] = float("nan")
    else:
        data["faces"][0]["box"] = [110, 20, 10, 120]
    backend = BasetenFaceBackend("model", "test", client=Client(data))
    with pytest.raises(ValueError):
        await backend.embed_faces(b"jpeg", (640, 480))
    assert not backend.last_frame_accepted


async def test_face_drops_concurrent_work_without_queueing():
    client = Client()
    client.gate = asyncio.Event()
    backend = BasetenFaceBackend("model", "test", client=client)
    task = asyncio.create_task(backend.embed_faces(b"one", (640, 480)))
    await asyncio.sleep(0)
    assert await backend.embed_faces(b"two", (640, 480)) == []
    assert not backend.last_frame_accepted
    client.gate.set()
    await task
    assert len(client.calls) == 1


async def test_face_timeout_is_bounded_and_sanitized():
    client = Client()
    client.gate = asyncio.Event()
    backend = BasetenFaceBackend("model", "secret", timeout_s=0.01, client=client)
    with pytest.raises(RuntimeError, match="request failed") as error:
        await backend.embed_faces(b"one", (640, 480))
    assert "secret" not in str(error.value)
    assert backend.last_timings_ms == {}


async def test_face_cancellation_releases_inflight_lock():
    client = Client()
    client.gate = asyncio.Event()
    backend = BasetenFaceBackend("model", "test", client=client)
    task = asyncio.create_task(backend.embed_faces(b"one", (640, 480)))
    await asyncio.sleep(0)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    client.gate.set()
    assert await backend.embed_faces(b"two", (640, 480))
