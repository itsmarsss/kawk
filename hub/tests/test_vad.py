import numpy as np
import pytest
from remember_hub.perception.stt.vad import FRAME_BYTES, PcmReframer, SileroOnnxVad, VadGate


def test_640_to_512_reframe_preserves_every_sample():
    source = np.arange(640 * 4, dtype='<i2').tobytes()
    reframer = PcmReframer()
    frames = []
    for offset in range(0, len(source), 1280):
        frames += reframer.push(source[offset:offset+1280])
        assert reframer.pending_bytes < FRAME_BYTES
    assert len(frames) == 5
    assert all(len(frame) == FRAME_BYTES for frame in frames)
    assert b''.join(frames) == source
    assert reframer.finish() == b''


def test_reframer_rejects_unbounded_and_partial_sample_input():
    framer = PcmReframer()
    with pytest.raises(ValueError):
        framer.push(b'x')
    with pytest.raises(ValueError):
        framer.push(bytes(32002))
    framer.push(bytes(640))
    assert framer.finish() == bytes(640)  # never pad real silence


def test_silero_onnx_context_and_recurrent_state_without_torch():
    class Session:
        def __init__(self):
            self.calls = []
        def run(self, _, inputs):
            self.calls.append({key: value.copy() for key, value in inputs.items()})
            return np.array([[.8]], dtype=np.float32), inputs['state'] + 1
    session = Session()
    vad = SileroOnnxVad(session=session)
    frame = np.full(512, 8192, dtype='<i2').tobytes()
    assert vad(frame) == pytest.approx(.8)
    vad(frame)
    assert session.calls[0]['input'].shape == (1, 576)
    assert np.all(session.calls[0]['input'][:, :64] == 0)
    assert np.all(session.calls[1]['input'][:, :64] == .25)
    assert np.all(session.calls[1]['state'] == 1)
    assert session.calls[1]['sr'] == 16000
    vad.reset()
    vad(frame)
    assert np.all(session.calls[-1]['state'] == 0)
    with pytest.raises(ValueError):
        vad(bytes(1280))


def test_gate_preroll_hangover_real_samples_and_silence_gaps():
    gate = VadGate(lambda pcm: 1. if np.frombuffer(pcm, '<i2')[0] == 10 else 0.)
    forwarded = []
    originals = []
    # 20 silence frames, 2 speech, 30 silence, then another onset.
    for index, value in enumerate([1]*20 + [10]*2 + [2]*30 + [10]):
        frame = np.full(512, value, dtype='<i2').tobytes()
        originals.append(frame)
        forwarded += gate.process(frame, t_start_hub=100)
    first = [frame for frame in forwarded if frame.utterance_start]
    ends = [frame for frame in forwarded if frame.utterance_end]
    assert [frame.sample_index // 512 for frame in first] == [10, 42]
    assert len(ends) == 1
    assert ends[0].sample_index // 512 == 37  #16*32ms=512ms real silence
    assert all(frame.pcm == originals[frame.sample_index//512] for frame in forwarded)
    assert gate.last_state.speech_active
    assert gate.last_state.t_hub == pytest.approx(100 + 52*.032)
    assert len(gate._pre) <= 10


def test_gate_speech_resumption_restarts_hangover():
    probabilities = iter([1] + [0]*15 + [1] + [0]*16)
    gate = VadGate(lambda _: next(probabilities))
    end_indexes = []
    for i in range(33):
        end_indexes += [i for frame in gate.process(bytes(FRAME_BYTES)) if frame.utterance_end]
    assert end_indexes == [32]
