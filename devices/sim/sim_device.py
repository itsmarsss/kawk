"""Laptop sim device (AGENTS.md §5).

Headless mode (CI + overnight verification): streams fixture JPEGs + a wav over
the wire protocol using CORE deps only (websockets + stdlib). Live mode uses
[sim] extras (opencv/sounddevice/pygame) with the specced threading model:
pygame on the MAIN thread; asyncio client loop in a background thread; camera
capture in its own thread feeding a depth-1 newest-wins slot; every cross-thread
handoff into asyncio goes through run_coroutine_threadsafe.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import struct
import sys
import time
import wave
from dataclasses import dataclass, field
from pathlib import Path

import websockets

HDR = struct.Struct("<BBHI")
T_VIDEO, T_AUDIO = 0x01, 0x02
AUDIO_CHUNK = 1280  # 40 ms @ 16 kHz mono PCM16

# A real 1x1 grey JPEG (cv2-encoded, verified decodable + SOF-parseable) so headless
# mode needs no fixture files at all.
FALLBACK_JPEG = bytes.fromhex(
    "ffd8ffe000104a46494600010100000100010000ffdb0043000a07070807060a0808080b0a0a0b0e18100e0d0d0e1d15161118231f2524221f2221262b372f26293429212230413134393b3e3e3e252e4449433c48373d3e3bffdb0043010a0b0b0e0d0e1c10101c3b2822283b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3bffc00011080001000103012200021101031101ffc4001f0000010501010101010100000000000000000102030405060708090a0bffc400b5100002010303020403050504040000017d01020300041105122131410613516107227114328191a1082342b1c11552d1f02433627282090a161718191a25262728292a3435363738393a434445464748494a535455565758595a636465666768696a737475767778797a838485868788898a92939495969798999aa2a3a4a5a6a7a8a9aab2b3b4b5b6b7b8b9bac2c3c4c5c6c7c8c9cad2d3d4d5d6d7d8d9dae1e2e3e4e5e6e7e8e9eaf1f2f3f4f5f6f7f8f9faffc4001f0100030101010101010101010000000000000102030405060708090a0bffc400b51100020102040403040705040400010277000102031104052131061241510761711322328108144291a1b1c109233352f0156272d10a162434e125f11718191a262728292a35363738393a434445464748494a535455565758595a636465666768696a737475767778797a82838485868788898a92939495969798999aa2a3a4a5a6a7a8a9aab2b3b4b5b6b7b8b9bac2c3c4c5c6c7c8c9cad2d3d4d5d6d7d8d9dae2e3e4e5e6e7e8e9eaf2f3f4f5f6f7f8f9faffda000c03010002110311003f0028a28a00ffd9"
)


@dataclass
class Stats:
    frames_tx: int = 0
    audio_tx: int = 0
    cards_rx: list = field(default_factory=list)
    blits_rx: int = 0


def millis() -> int:
    return int(time.monotonic() * 1000) & 0xFFFFFFFF


def load_fixtures(fixtures_dir: str | None, wav_path: str | None) -> tuple[list[bytes], bytes]:
    frames: list[bytes] = []
    if fixtures_dir:
        for p in sorted(Path(fixtures_dir).glob("*.jpg")):
            frames.append(p.read_bytes())
    if not frames:
        frames = [FALLBACK_JPEG]
    pcm = b"\x00" * (AUDIO_CHUNK * 25)  # 1 s of silence
    if wav_path:
        with wave.open(wav_path, "rb") as w:
            assert w.getframerate() == 16000 and w.getnchannels() == 1, "need 16 kHz mono wav"
            pcm = w.readframes(w.getnframes())
    return frames, pcm


async def run_headless(
    hub_url: str,
    fixtures_dir: str | None,
    wav_path: str | None,
    fps: float,
    seconds: float,
    device_id: str = "sim-headless",
    stats: Stats | None = None,
) -> Stats:
    """Reconnect-with-backoff is the client's job (§5): retry until the deadline."""
    stats = stats or Stats()
    frames, pcm = load_fixtures(fixtures_dir, wav_path)
    t_end = time.monotonic() + seconds
    backoff = 0.5
    while time.monotonic() < t_end:
        try:
            await _headless_session(hub_url, frames, pcm, fps, t_end, device_id, stats)
            break  # ran to the deadline
        except (OSError, websockets.WebSocketException) as e:
            wait = min(backoff, max(0.05, t_end - time.monotonic()))
            print(f"[sim] connection lost ({e!r}); retrying in {wait:.1f}s")
            await asyncio.sleep(wait)
            backoff = min(backoff * 2, 5.0)
    return stats


async def _headless_session(
    hub_url: str,
    frames: list[bytes],
    pcm: bytes,
    fps: float,
    t_end: float,
    device_id: str,
    stats: Stats,
) -> None:
    async with websockets.connect(hub_url, compression=None) as ws:
        await ws.send(
            json.dumps(
                {
                    "type": "hello",
                    "device_id": device_id,
                    "class": "laptop",
                    "display": {"w": 240, "h": 240},
                    "caps": {"video": True, "audio": True},
                }
            )
        )

        async def receiver() -> None:
            async for message in ws:
                if isinstance(message, bytes):
                    stats.blits_rx += 1
                else:
                    msg = json.loads(message)
                    if msg.get("type") == "card":
                        stats.cards_rx.append(msg)
                        print(f"[display] {msg['template']}: {msg['title']} — {msg['body']}")

        recv_task = asyncio.create_task(receiver())
        seq_v = seq_a = 0
        frame_i = audio_off = 0
        frame_interval = 1.0 / fps
        next_frame = time.monotonic()
        try:
            while time.monotonic() < t_end:
                # §5: audio before video each tick.
                chunk = pcm[audio_off : audio_off + AUDIO_CHUNK]
                if len(chunk) < AUDIO_CHUNK:
                    audio_off = 0
                    chunk = pcm[:AUDIO_CHUNK]
                audio_off += AUDIO_CHUNK
                seq_a = (seq_a + 1) & 0xFFFF
                await ws.send(HDR.pack(T_AUDIO, 0, seq_a, millis()) + chunk)
                stats.audio_tx += 1

                if time.monotonic() >= next_frame:
                    seq_v = (seq_v + 1) & 0xFFFF
                    jpeg = frames[frame_i % len(frames)]
                    frame_i += 1
                    await ws.send(HDR.pack(T_VIDEO, 0, seq_v, millis()) + jpeg)
                    stats.frames_tx += 1
                    next_frame += frame_interval
                await asyncio.sleep(0.04)
        finally:
            recv_task.cancel()


# ---- live mode ([sim] extras; verification is a morning-checklist item) ---------


def run_live(hub_url: str, camera_index: int, device_id: str = "sim-laptop") -> None:
    try:
        import cv2
        import pygame
        import sounddevice as sd
    except ImportError as e:
        raise SystemExit(f"live sim needs the [sim] extra ({e}). Run: uv sync --extra sim") from e

    import threading

    frame_slot: list = [None]  # depth-1 newest-wins
    slot_lock = threading.Lock()
    stop = threading.Event()
    card_slot: list = [None]
    # Hub-pushed config (§5) — receiver updates it; camera + send loops honor it.
    video_cfg = {"w": 1280, "h": 720, "fps": 12, "quality": 70}

    def camera_thread() -> None:
        cap = cv2.VideoCapture(camera_index, cv2.CAP_AVFOUNDATION)
        if not cap.isOpened():
            print(
                "FATAL: camera did not open. macOS: grant Camera permission to THIS terminal "
                "app (System Settings > Privacy & Security), and check camera_index in "
                "remember.toml (Continuity Camera can hijack index 0).",
                file=sys.stderr,
            )
            stop.set()
            return
        while not stop.is_set():
            ok, frame = cap.read()
            if not ok:
                continue
            frame = cv2.resize(frame, (video_cfg["w"], video_cfg["h"]))
            ok, jpeg = cv2.imencode(
                ".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, int(video_cfg["quality"])]
            )
            if ok:
                with slot_lock:
                    frame_slot[0] = jpeg.tobytes()
        cap.release()

    async def session(ws) -> None:
        await ws.send(
            json.dumps(
                {
                    "type": "hello",
                    "device_id": device_id,
                    "class": "laptop",
                    "display": {"w": 240, "h": 240},
                    "caps": {"video": True, "audio": True},
                }
            )
        )

        async def receiver() -> None:
            async for message in ws:
                if isinstance(message, str):
                    msg = json.loads(message)
                    if msg.get("type") == "card":
                        card_slot[0] = msg
                    elif msg.get("type") == "config":
                        video_cfg.update(msg.get("video", {}))

        recv = asyncio.create_task(receiver())
        seq_a = seq_v = 0
        next_frame = time.monotonic()
        try:
            while not stop.is_set():
                try:
                    chunk = await asyncio.wait_for(audio_q.get(), timeout=0.1)
                    seq_a = (seq_a + 1) & 0xFFFF
                    await ws.send(HDR.pack(T_AUDIO, 0, seq_a, millis()) + chunk)
                except TimeoutError:
                    pass
                if time.monotonic() >= next_frame:
                    with slot_lock:
                        jpeg = frame_slot[0]
                        frame_slot[0] = None
                    if jpeg is not None:
                        seq_v = (seq_v + 1) & 0xFFFF
                        await ws.send(HDR.pack(T_VIDEO, 0, seq_v, millis()) + jpeg)
                    next_frame = time.monotonic() + 1 / max(1, video_cfg["fps"])
        finally:
            recv.cancel()

    audio_q: asyncio.Queue[bytes] = asyncio.Queue(maxsize=32)

    async def client() -> None:
        loop = asyncio.get_running_loop()

        def audio_cb(indata, _frames, _time, status) -> None:  # PortAudio thread
            if status:
                print(f"[audio] {status}", file=sys.stderr)
            data = bytes(indata)

            def _put() -> None:
                if audio_q.full():
                    audio_q.get_nowait()
                audio_q.put_nowait(data)

            loop.call_soon_threadsafe(_put)

        stream = sd.RawInputStream(
            samplerate=16000, channels=1, dtype="int16", blocksize=640, callback=audio_cb
        )
        stream.start()
        backoff = 0.5
        try:
            # Reconnect-with-backoff is the client's job (§5): a hub restart
            # mid-demo must never leave the glasses silently offline.
            while not stop.is_set():
                try:
                    async with websockets.connect(hub_url, compression=None) as ws:
                        backoff = 0.5
                        await session(ws)
                except (OSError, websockets.WebSocketException) as e:
                    print(
                        f"[sim] hub connection lost ({e!r}); retry in {backoff:.1f}s",
                        file=sys.stderr,
                    )
                    await asyncio.sleep(backoff)
                    backoff = min(backoff * 2, 5.0)
        finally:
            stream.stop()

    threading.Thread(target=camera_thread, daemon=True).start()
    client_thread = threading.Thread(target=lambda: asyncio.run(client()), daemon=True)
    client_thread.start()

    # pygame MUST own the main thread on macOS.
    pygame.init()
    screen = pygame.display.set_mode((240, 240))
    pygame.display.set_caption("Remember display sim")
    font = pygame.font.SysFont(None, 22)
    small = pygame.font.SysFont(None, 16)
    clock = pygame.time.Clock()
    try:
        while not stop.is_set():
            for event in pygame.event.get():
                if event.type == pygame.QUIT:
                    stop.set()
            screen.fill((8, 8, 16))
            card = card_slot[0]
            if card and card.get("template") != "idle":
                screen.blit(font.render(card.get("title", ""), True, (240, 240, 255)), (10, 40))
                body = card.get("body", "")
                for i in range(0, len(body), 28):
                    screen.blit(
                        small.render(body[i : i + 28], True, (180, 200, 220)),
                        (10, 80 + 18 * (i // 28)),
                    )
            else:
                screen.blit(font.render(time.strftime("%H:%M"), True, (120, 130, 150)), (85, 105))
            pygame.display.flip()
            clock.tick(30)
    finally:
        stop.set()
        pygame.quit()


def main() -> None:
    ap = argparse.ArgumentParser(description="Remember laptop sim device")
    ap.add_argument("--hub", default="ws://127.0.0.1:8765")
    ap.add_argument("--headless", action="store_true")
    ap.add_argument("--fixtures", default=None, help="dir of *.jpg to stream (headless)")
    ap.add_argument("--wav", default=None, help="16 kHz mono wav to stream (headless)")
    ap.add_argument("--fps", type=float, default=10.0)
    ap.add_argument("--seconds", type=float, default=30.0)
    ap.add_argument("--camera-index", type=int, default=0)
    ap.add_argument("--device-id", default=None)
    args = ap.parse_args()
    if args.headless:
        stats = asyncio.run(
            run_headless(
                args.hub,
                args.fixtures,
                args.wav,
                args.fps,
                args.seconds,
                device_id=args.device_id or "sim-headless",
            )
        )
        print(
            f"headless sim done: {stats.frames_tx} frames, {stats.audio_tx} audio chunks sent; "
            f"{len(stats.cards_rx)} cards, {stats.blits_rx} blits received"
        )
    else:
        run_live(args.hub, args.camera_index, device_id=args.device_id or "sim-laptop")


if __name__ == "__main__":
    main()
