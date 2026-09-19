"""Verified Baseten streaming Whisper protocol, no keys in client responses."""
import json
import os
from pathlib import Path

MODEL_ID = os.getenv("BASETEN_STT_MODEL_ID", "wdlg2oe3")
METADATA = {
    "streaming_vad_config": {"threshold": 0.5, "min_silence_duration_ms": 300, "speech_pad_ms": 30},
    "streaming_params": {"encoding": "pcm_s16le", "sample_rate": 16000,
                         "enable_partial_transcripts": True, "partial_transcript_interval_s": 0.5,
                         "final_transcript_max_duration_s": 30},
    "whisper_params": {"audio_language": "en", "show_word_timestamps": True},
}


def read_key():
    if os.getenv("BASETEN_API_KEY"):
        return os.environ["BASETEN_API_KEY"]
    try:
        data = json.loads((Path.home() / "Library/Application Support/baseten/auth.json").read_text())
        return data["profiles"]["h100-permanent"]["api_key"]
    except (OSError, KeyError, ValueError) as error:
        raise RuntimeError("Configure the h100-permanent Baseten profile or BASETEN_API_KEY on the Mac server") from error


def transcript_event(raw):
    data = json.loads(raw)
    if data.get("type") != "transcription":
        return None
    segments = data.get("segments", [])
    return {"type": "transcript", "segment_id": str(data.get("transcription_num", 0)),
            "text": " ".join(segment.get("text", "").strip() for segment in segments).strip(),
            "is_final": bool(data.get("is_final")),
            "words": [word for segment in segments for word in segment.get("word_timestamps", [])]}
