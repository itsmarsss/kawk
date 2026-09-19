"""Run genuine local models on fixtures and record cold/warm timing separately.

No downloads: run make fixtures and make fetch-local-models first.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import platform
import subprocess
import time
import wave
from importlib.metadata import version
from pathlib import Path

import numpy as np
from remember_hub.perception.face.local_insight import LocalInsightFaceBackend
from remember_hub.perception.sam.local_yolo import LocalYoloBackend
from remember_hub.perception.stt.local_whisper import LocalWhisperBackend
from remember_hub.perception.stt.vad import SileroOnnxVad


def stats(values):
    return {"n": len(values), "p50_ms": round(float(np.percentile(values, 50)), 2),
            "p95_ms": round(float(np.percentile(values, 95)), 2),
            "samples_ms": [round(value, 2) for value in values]}


def hardware():
    try:
        return subprocess.check_output(['sysctl', '-n', 'machdep.cpu.brand_string'], text=True).strip()
    except (OSError, subprocess.CalledProcessError):
        return platform.processor()


async def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--models', type=Path, default=Path('data/models'))
    parser.add_argument('--fixtures', type=Path, default=Path('data/fixtures'))
    parser.add_argument('--output', type=Path, default=Path('data/local-verification.json'))
    parser.add_argument('--warm-runs', type=int, default=5)
    parser.add_argument('--face-provider', default='CPUExecutionProvider')
    parser.add_argument('--face-image', type=Path, help='Optional authorized face fixture for embedding validation')
    args = parser.parse_args()
    if not 1 <= args.warm_runs <= 30:
        raise ValueError('warm-runs must be1–30')
    import cv2
    report = {'hardware': hardware(), 'os': platform.platform(), 'python': platform.python_version(),
              'versions': {name: version(name) for name in ['ultralytics','onnxruntime','insightface','faster-whisper','ctranslate2']},
              'network_in_inference': False, 'limitations': 'Fixture smoke tests, not live camera accuracy or concurrency benchmarks.'}
    bus_path = args.fixtures / 'bus.jpg'
    bus = cv2.imread(str(bus_path))
    if bus is None:
        raise RuntimeError('Missing bus fixture; run make fixtures')
    yolo = LocalYoloBackend(args.models / 'yolov8s-worldv2.pt')
    started = time.perf_counter()
    await yolo.start_session(['person', 'bus', 'keys', 'wallet'])
    load_ms = (time.perf_counter()-started)*1000
    times, counts = [], []
    for i in range(args.warm_runs+1):
        started = time.perf_counter()
        detections = await yolo.push_frame(str(i), bus_path.read_bytes(), (bus.shape[1], bus.shape[0]))
        times.append((time.perf_counter()-started)*1000)
        counts.append(sum(d.label == 'person' for d in detections))
    assert min(counts) >= 1, 'YOLO-World failed to detect a person on the bus fixture'
    report['yolo_world'] = {'load_ms': round(load_ms, 2), 'first_inference_ms': round(times[0], 2),
                            'warm': stats(times[1:]), 'sent_wh': [bus.shape[1],bus.shape[0]],
                            'vocabulary': ['person','bus','keys','wallet'], 'person_counts': counts,
                            'device': 'cpu', 'tracking_ids': [d.track_id for d in detections]}
    print('YOLO-World:', report['yolo_world'], flush=True)
    await yolo.close()
    face = LocalInsightFaceBackend(args.models, provider=args.face_provider)
    noise = cv2.imread(str(args.fixtures / 'noise.png'))
    if noise is None:
        raise RuntimeError('Missing noise fixture; run make fixtures')
    ok, jpg = cv2.imencode('.jpg', noise)
    assert ok
    face_times = []
    for _ in range(args.warm_runs+1):
        started = time.perf_counter()
        faces = await face.embed_faces(jpg.tobytes(), (640,480))
        face_times.append((time.perf_counter()-started)*1000)
        assert not faces, 'Noise should produce zero accepted faces'
    report['insightface'] = {'load_ms': face.load_ms, 'first_call_including_load_ms': face_times[0],
                             'warm_noise': stats(face_times[1:]), 'sent_wh': [640,480],
                             'accepted_faces': 0, 'providers': face.providers, 'model': 'buffalo_l'}
    if args.face_image:
        image = cv2.imread(str(args.face_image))
        if image is None:
            raise ValueError('Cannot decode face fixture')
        scale = min(1, 640 / max(image.shape[:2]))
        image = cv2.resize(image, (round(image.shape[1]*scale), round(image.shape[0]*scale)))
        _, jpg = cv2.imencode('.jpg', image)
        times = []
        for _ in range(args.warm_runs+1):
            started = time.perf_counter()
            faces = await face.embed_faces(jpg.tobytes(), (image.shape[1],image.shape[0]))
            times.append((time.perf_counter()-started)*1000)
        assert faces, 'Face fixture produced no accepted >=80 px faces'
        report['insightface']['face_fixture'] = {'first_face_inference_ms': times[0], 'warm': stats(times[1:]), 'accepted_faces': len(faces),
                                               'embedding_norms': [float(np.linalg.norm(f.embedding_512)) for f in faces]}
    print('InsightFace:', report['insightface'], flush=True)
    await face.close()
    with wave.open(str(args.fixtures / 'where_keys.wav')) as source:
        assert (source.getframerate(),source.getnchannels(),source.getsampwidth()) == (16000,1,2)
        speech = source.readframes(source.getnframes())
    pcm = bytes(16000) + speech + bytes(32000)  # .5s pre + 1s real silence in synthetic fixture
    samples = np.frombuffer(pcm, '<i2')
    active = np.flatnonzero(abs(samples.astype(np.int32)) > 300)
    onset, offset = float(active[0])/16000, float(active[-1]+1)/16000
    started = time.perf_counter()
    vad = SileroOnnxVad(args.models/'silero_vad.onnx')
    vad_load = (time.perf_counter()-started)*1000
    vad_times, probabilities = [], []
    for i in range(0,len(pcm)-1023,1024):
        started = time.perf_counter()
        probabilities.append(vad(pcm[i:i+1024]))
        vad_times.append((time.perf_counter()-started)*1000)
    assert max(probabilities) > .5, 'VAD did not detect synthetic speech'
    report['silero_onnx'] = {'load_ms': vad_load, 'first_frame_ms': vad_times[0],
                             'warm': stats(vad_times[1:]), 'max_speech_probability': max(probabilities),
                             'frame_samples': 512, 'sample_rate': 16000, 'provider': 'CPUExecutionProvider'}
    whisper = LocalWhisperBackend(args.models/'faster-whisper-small', vad_model_path=args.models/'silero_vad.onnx')
    trials = []
    for trial in range(2):
        clock = {'start': 0.}
        async def stream():
            clock['start'] = time.monotonic()
            for i in range(0,len(pcm),1280):
                await asyncio.sleep(max(0, clock['start']+i/32000-time.monotonic()))
                yield pcm[i:i+1280]
        started = time.perf_counter()
        events = []
        async for segment in whisper.stream(stream()):
            elapsed = time.monotonic()-clock['start']
            events.append({'arrival_s': elapsed, 'text':segment.text, 'is_final':segment.is_final,
                           'seg_id': segment.seg_id, 'words': [word.model_dump() for word in segment.words]})
        finals = [event for event in events if event['is_final']]
        assert any('keys' in event['text'].lower() for event in finals), f'Whisper failed keys fixture: {events}'
        partials = [event for event in events if not event['is_final'] and event['text']]
        trials.append({'cold': trial==0, 'wall_including_load_ms':(time.perf_counter()-started)*1000,
                       'first_partial_after_onset_ms': (partials[0]['arrival_s']-onset)*1000 if partials else None,
                       'final_after_acoustic_offset_ms':(finals[-1]['arrival_s']-offset)*1000,
                       'events':events})
    report['local_whisper'] = {'model':'small','compute_type':'int8','device':'cpu','load_ms':whisper.load_ms,
                               'input_duration_s':len(speech)/32000,'speech_onset_s':onset,'speech_offset_s':offset,
                               'partial_interval_s':1.,'trials':trials}
    await whisper.close()
    args.output.parent.mkdir(parents=True,exist_ok=True)
    args.output.write_text(json.dumps(report,indent=2)+'\n')
    print(f'All genuine fixture checks passed. Results: {args.output}',flush=True)


if __name__ == '__main__':
    asyncio.run(main())
