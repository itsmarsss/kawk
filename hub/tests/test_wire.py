"""M1 codec unit tests — the three §5 edge cases, pinned at m0."""

import pytest
from remember_hub.contracts import wire


def test_av_frame_roundtrip_8_byte_header():
    f = wire.WireFrame(type=wire.T_VIDEO, flags=0, seq=42, ts_ms=123456, payload=b"\xff\xd8jpeg")
    buf = wire.encode(f)
    assert buf[0] == wire.T_VIDEO
    assert len(buf) == 8 + len(f.payload)
    out = wire.decode(buf)
    assert (out.type, out.seq, out.ts_ms, out.payload) == (
        wire.T_VIDEO,
        42,
        123456,
        b"\xff\xd8jpeg",
    )
    assert out.geometry is None


def test_blit_frame_roundtrip_16_byte_header():
    f = wire.WireFrame(
        type=wire.T_BLIT_JPEG, flags=1, seq=7, ts_ms=99, payload=b"img", geometry=(10, 20, 100, 80)
    )
    buf = wire.encode(f)
    assert len(buf) == 16 + 3  # type-conditional header length
    out = wire.decode(buf)
    assert out.geometry == (10, 20, 100, 80)
    assert out.payload == b"img"


def test_blit_requires_geometry():
    f = wire.WireFrame(type=wire.T_BLIT_RGB565, flags=0, seq=0, ts_ms=0, payload=b"")
    with pytest.raises(ValueError):
        wire.encode(f)


def test_seq_wraparound_modular():
    assert wire.seq_delta(0xFFFF, 0x0000) == 1  # wrap forward
    assert wire.seq_delta(0x0000, 0xFFFF) == -1  # wrap backward
    assert wire.seq_delta(100, 105) == 5
    assert wire.seq_delta(0xFFFE, 0x0003) == 5  # gap across the wrap
    # encode masks seq to u16
    f = wire.WireFrame(type=wire.T_AUDIO, flags=0, seq=0x1_0005, ts_ms=0, payload=b"")
    assert wire.decode(wire.encode(f)).seq == 5


def test_ts_ms_u32_wraps_and_roundtrips():
    f = wire.WireFrame(type=wire.T_AUDIO, flags=0, seq=1, ts_ms=2**32 + 77, payload=b"")
    assert wire.decode(wire.encode(f)).ts_ms == 77


def test_audio_chunk_size_constant():
    # 40 ms @ 16 kHz mono PCM16 = 640 samples = 1280 bytes (§5)
    assert wire.AUDIO_CHUNK_BYTES == 640 * 2


def test_parse_control_rejects_unknown():
    with pytest.raises(ValueError):
        wire.parse_control('{"type":"nope"}')
    hello = wire.make_hello("dev1", "laptop", (240, 240), True, True)
    msg = wire.parse_control(hello)
    assert msg["class"] == "laptop" and msg["display"]["w"] == 240
