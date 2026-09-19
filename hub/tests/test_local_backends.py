import asyncio
import threading
import time
from types import SimpleNamespace

import numpy as np
import pytest
from remember_hub.perception.face.local_insight import LocalInsightFaceBackend
from remember_hub.perception.sam.local_yolo import LocalYoloBackend
from remember_hub.perception.stt.local_whisper import LocalWhisperBackend
from remember_hub.perception.stt.vad import VadGate


class YoloEngine:
    def set_classes(self, vocabulary):
        self.words = vocabulary
    def infer(self, jpeg, wh, confidence):
        return [('keys', [10, 20, 110, 120], .8), ('keys', [11, 20, 111, 120], .7),
                ('person', [200, 10, 500, 400], .9)]


async def test_yolo_vocabulary_absolute_boxes_track_reuse_and_session_namespace():
    engine = YoloEngine()
    backend = LocalYoloBackend(engine=engine)
    await backend.start_session(['keys', 'person'])
    first = await backend.push_frame('f1', b'fixture', (640, 480))
    second = await backend.push_frame('f2', b'fixture', (640, 480))
    assert len(first) == 2  # duplicate suppression
    assert [row.track_id for row in first] == [row.track_id for row in second]
    assert first[1].box_xyxy == (10, 20, 110, 120)
    assert first[1].wh == (640, 480)
    await backend.add_concept('wallet')
    assert engine.words == ['keys', 'person', 'wallet']
    await backend.end_session()
    with pytest.raises(RuntimeError):
        await backend.push_frame('f3', b'fixture', (640, 480))
    await backend.start_session(['keys', 'person'])
    assert (await backend.push_frame('f4', b'fixture', (640, 480)))[0].track_id != first[0].track_id
    with pytest.raises(ValueError):
        await backend.start_session(['noun'] * 0)


async def test_face_drops_concurrent_frames_and_keeps_native_work_off_event_loop():
    entered, release = threading.Event(), threading.Event()
    class Engine:
        def infer(self, jpeg, wh, min_face_size, threshold):
            entered.set()
            release.wait(timeout=2)
            vector = [1.] + [0.] * 511
            return [([10, 10, 120, 120], .9, vector)], {'total': 10.}
    backend = LocalInsightFaceBackend(engine=Engine())
    work = asyncio.create_task(backend.embed_faces(b'fixture', (640, 480)))
    for _ in range(100):
        if entered.is_set():
            break
        await asyncio.sleep(.001)
    assert entered.is_set()
    assert await backend.embed_faces(b'newest', (640, 480)) == []
    release.set()
    result = await work
    assert result[0].model == 'buffalo_l'
    assert len(result[0].embedding_512) == 512
    with pytest.raises(ValueError):
        await backend.embed_faces(b'fixture', (1280, 720))


class WhisperEngine:
    def __init__(self, delay=0):
        self.calls = 0
        self.delay = delay
    def transcribe(self, audio, **kwargs):
        time.sleep(self.delay)
        self.calls += 1
        assert kwargs['word_timestamps'] is True
        word = SimpleNamespace(word=' keys', start=.1, end=.3, probability=.9)
        segment = SimpleNamespace(text='where are my keys', words=[word])
        return iter([segment]), SimpleNamespace()


async def audio_source(frame_values, *, pace=.001):
    # Device packet size640 samples exercises production rebuffering.
    audio = b''.join(np.full(512, value, dtype='<i2').tobytes() for value in frame_values)
    for offset in range(0, len(audio), 1280):
        yield audio[offset:offset+1280]
        await asyncio.sleep(pace)


def fake_gate():
    return VadGate(lambda pcm: float(np.max(np.frombuffer(pcm, '<i2')) > 1))


async def test_whisper_partials_replace_same_id_finalizes_and_preserves_silence_time():
    engine = WhisperEngine()
    backend = LocalWhisperBackend(engine=engine, vad_factory=fake_gate, window_seconds=.25)
    segments = [segment async for segment in backend.stream(audio_source([0]*12+[10]*16+[0]*32+[10]*16+[0]*20))]
    finals = [segment for segment in segments if segment.is_final]
    assert len(finals) == 2
    assert finals[0].seg_id != finals[1].seg_id
    assert len({seg.seg_id for seg in segments}) == 2
    assert any(not seg.is_final and seg.seg_id == finals[0].seg_id for seg in segments)
    assert finals[1].t_start_hub-finals[0].t_start_hub == pytest.approx((60-10-2)*.032)
    assert finals[0].words[0].t0 == .1
    assert finals[0].words[0].t1 == .3
    assert not backend._active


async def test_whisper_end_of_input_finalizes_without_manufactured_silence():
    backend = LocalWhisperBackend(engine=WhisperEngine(), vad_factory=fake_gate)
    segments = [segment async for segment in backend.stream(audio_source([10]*5))]
    assert len(segments) == 1 and segments[0].is_final


async def test_whisper_queue_overrun_fails_instead_of_building_audio_backlog():
    backend = LocalWhisperBackend(engine=WhisperEngine(.1), vad_factory=fake_gate, window_seconds=.25)
    with pytest.raises(RuntimeError, match='queue exceeded'):
        _ = [seg async for seg in backend.stream(audio_source([10]*100, pace=0))]
    assert not backend._active


async def test_whisper_utterance_cap_and_new_stream_have_distinct_ids():
    backend = LocalWhisperBackend(engine=WhisperEngine(), vad_factory=fake_gate,
                                 window_seconds=.25, max_utterance_seconds=1)
    first = [seg async for seg in backend.stream(audio_source([10]*70))]
    assert sum(seg.is_final for seg in first) == 3
    second = [seg async for seg in backend.stream(audio_source([10]*3))]
    assert first[0].seg_id != second[0].seg_id


async def test_explicit_whisper_load_prepares_vad_before_audio_starts():
    gates = []
    def make_gate():
        gate = fake_gate()
        gates.append(gate)
        return gate
    backend = LocalWhisperBackend(engine=WhisperEngine(), vad_factory=make_gate)
    await backend.load()
    await backend.load()
    assert len(gates) == 1
    result = [seg async for seg in backend.stream(audio_source([10]*3))]
    assert result[-1].is_final
    assert len(gates) == 1
    await backend.close()


async def test_cancelled_face_call_waits_for_native_session_before_reuse():
    entered, release = threading.Event(), threading.Event()
    class Engine:
        def infer(self, *_):
            entered.set()
            release.wait(timeout=2)
            return [], {}
    backend = LocalInsightFaceBackend(engine=Engine())
    running = asyncio.create_task(backend.embed_faces(b'fixture', (640, 480)))
    for _ in range(100):
        if entered.is_set():
            break
        await asyncio.sleep(.001)
    running.cancel()
    await asyncio.sleep(.005)
    assert not running.done()
    assert await backend.embed_faces(b'fixture', (640, 480)) == []
    release.set()
    with pytest.raises(asyncio.CancelledError):
        await running
    assert not backend._lock.locked()
