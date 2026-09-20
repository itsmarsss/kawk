"""Raspberry Pi camera device (AGENTS.md §5) — same wire protocol as every device.

Video-only client (no mic on the camera rig): Picamera2 capture in its own
thread feeding a depth-1 newest-wins slot; asyncio sends JPEG frames paced by
the hub-pushed config; reconnect-with-backoff is the client's job (§5).
Cards are printed to stdout (no display attached yet).

Runs on the system python (needs apt: python3-picamera2 python3-websockets):
    python3 rpi_device.py --hub ws://<hub-ip>:8765
"""

from __future__ import annotations

import argparse
import asyncio
import json
import struct
import sys
import threading
import time

import websockets

HDR = struct.Struct("<BBHI")
T_VIDEO = 0x01


def millis() -> int:
    return int(time.monotonic() * 1000) & 0xFFFFFFFF


class Camera:
    """Picamera2 in a thread -> newest-wins JPEG slot. Configured once from the
    hub's config message (stop/reconfigure mid-run is not worth it tonight).

    Prefers the Pi 4's HARDWARE MJPEG encoder (VideoCore, ~zero CPU — 1080p30
    capable); falls back to software simplejpeg if the hw path fails (Pi 5 has
    no hw encoder; software tops out ~36 fps at VGA, ~15 fps at 720p)."""

    def __init__(self, hflip: bool = False, vflip: bool = False) -> None:
        self._slot: bytes | None = None
        self._lock = threading.Lock()
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self.dead = threading.Event()  # FATAL only (no camera / no libs) — never on restart
        self.params: tuple[int, int, int, int] | None = None
        self.hflip = hflip  # source-side flips for a physically rotated rig —
        self.vflip = vflip  # these fix PERCEPTION too, not just the dashboard view

    def _transform(self):
        from libcamera import Transform

        return Transform(hflip=int(self.hflip), vflip=int(self.vflip))

    def start(self, width: int, height: int, fps: int, quality: int) -> None:
        self.params = (width, height, fps, quality)
        self._stop = threading.Event()  # fresh event per run; threads capture their own
        self._thread = threading.Thread(
            target=self._run, args=(self._stop, width, height, fps, quality), daemon=True
        )
        self._thread.start()

    def restart(self, width: int, height: int, fps: int, quality: int) -> None:
        """Blocking (call via executor): tear down the current run, start anew.
        No-op when params are unchanged (e.g. the hub re-pushes config on reconnect)."""
        if self.params == (width, height, fps, quality):
            return
        old = self._thread
        self._stop.set()
        if old is not None:
            old.join(timeout=8)
        self.start(width, height, fps, quality)

    def stop(self) -> None:
        self._stop.set()

    def latest(self) -> bytes | None:
        with self._lock:
            jpeg, self._slot = self._slot, None
            return jpeg

    def _offer(self, jpeg: bytes) -> None:
        with self._lock:
            self._slot = jpeg

    def _run(self, stop, width: int, height: int, fps: int, quality: int) -> None:
        try:
            from picamera2 import Picamera2
        except ImportError as e:
            print(
                f"FATAL: {e}. Install with: sudo apt install python3-picamera2",
                file=sys.stderr,
            )
            stop.set()
            self.dead.set()
            return
        try:
            picam2 = Picamera2()
        except Exception as e:
            print(
                f"FATAL: camera failed to open ({e}). Check the ribbon cable and "
                "`rpicam-hello --list-cameras`.",
                file=sys.stderr,
            )
            stop.set()
            self.dead.set()
            return
        try:
            if not self._run_hardware(picam2, stop, width, height, fps, quality):
                self._run_software(picam2, stop, width, height, fps, quality)
        finally:
            try:
                picam2.close()  # release the camera so a restart() can re-acquire it
            except Exception:
                pass

    def _run_hardware(self, picam2, stop, width: int, height: int, fps: int, quality: int) -> bool:
        import io

        offer = self._offer

        class SlotIO(io.BufferedIOBase):
            """FileOutput requires a real BufferedIOBase; each write() is one JPEG."""

            def writable(self) -> bool:
                return True

            def write(self, buf) -> int:
                offer(bytes(buf))
                return len(buf)

        try:
            from picamera2.encoders import MJPEGEncoder
            from picamera2.outputs import FileOutput

            picam2.configure(
                picam2.create_video_configuration(
                    main={"size": (width, height), "format": "YUV420"},
                    controls={"FrameRate": float(fps)},
                    transform=self._transform(),
                )
            )
            # 0.75 bits/pixel ≈ JPEG q70 look; scale with the quality knob.
            # 720p24@q70 ≈ 17 Mbit/s, 1080p24@q70 ≈ 37 Mbit/s.
            bitrate = int(width * height * fps * 0.75 * (quality / 70))
            picam2.start_recording(MJPEGEncoder(bitrate=bitrate), FileOutput(SlotIO()))
        except Exception as e:
            print(f"[camera] hw MJPEG unavailable ({e}); software fallback", file=sys.stderr)
            try:
                picam2.stop_recording()
            except Exception:
                pass
            return False
        print(f"[camera] HW MJPEG {width}x{height}@{fps} q{quality} ~{bitrate / 1e6:.0f} Mbit/s")
        while not stop.is_set():
            time.sleep(0.2)
        picam2.stop_recording()
        return True

    def _run_software(self, picam2, stop, width: int, height: int, fps: int, quality: int) -> None:
        try:
            import simplejpeg

            picam2.configure(
                picam2.create_video_configuration(
                    main={"size": (width, height), "format": "RGB888"},
                    controls={"FrameRate": float(fps)},
                    transform=self._transform(),
                )
            )
            picam2.start()
        except Exception as e:
            print(f"FATAL: software camera path failed ({e})", file=sys.stderr)
            stop.set()
            self.dead.set()
            return
        print(f"[camera] SW simplejpeg {width}x{height} q{quality}")
        while not stop.is_set():
            try:
                # picamera2 quirk: "RGB888" arrays are BGR channel order.
                array = picam2.capture_array("main")
                jpeg = simplejpeg.encode_jpeg(
                    array, quality=quality, colorspace="BGR", fastdct=True
                )
            except Exception as e:
                print(f"[camera] capture failed: {e}", file=sys.stderr)
                time.sleep(0.5)
                continue
            self._offer(jpeg)
        picam2.stop()


async def session(ws, camera: Camera, video_cfg: dict, device_id: str) -> None:
    await ws.send(
        json.dumps(
            {
                "type": "hello",
                "device_id": device_id,
                "class": "pi",
                "display": {"w": 240, "h": 240},
                "caps": {"video": True, "audio": False},
            }
        )
    )
    got_config = asyncio.Event()
    config_dirty = asyncio.Event()

    async def receiver() -> None:
        async for message in ws:
            if isinstance(message, bytes):
                continue  # blits: no display attached yet
            msg = json.loads(message)
            if msg.get("type") == "config":
                video_cfg.update(msg.get("video", {}))
                got_config.set()
                config_dirty.set()  # runtime pushes (dashboard) reconfigure the camera
            elif msg.get("type") == "card":
                print(f"[display] {msg['template']}: {msg['title']} — {msg['body']}")
            elif msg.get("type") == "ping":
                await ws.send(json.dumps({"type": "pong"}))

    recv = asyncio.create_task(receiver())
    try:
        try:
            await asyncio.wait_for(got_config.wait(), timeout=2.0)
        except TimeoutError:
            print("[rpi] no config from hub within 2s; using defaults")
        if camera._thread is None:  # configure the camera ONCE, from hub config
            camera.start(
                int(video_cfg["w"]),
                int(video_cfg["h"]),
                int(video_cfg["fps"]),
                int(video_cfg["quality"]),
            )

        seq = 0
        sent = 0
        t_report = time.monotonic()
        next_send = time.monotonic()
        loop = asyncio.get_running_loop()
        while True:
            if config_dirty.is_set():
                config_dirty.clear()
                # restart() joins the camera thread — keep it off the event loop.
                await loop.run_in_executor(
                    None,
                    camera.restart,
                    int(video_cfg["w"]),
                    int(video_cfg["h"]),
                    int(video_cfg["fps"]),
                    int(video_cfg["quality"]),
                )
            interval = 1.0 / max(1, int(video_cfg["fps"]))  # fps is dynamic now
            jpeg = camera.latest()
            if jpeg is not None:
                seq = (seq + 1) & 0xFFFF
                await ws.send(HDR.pack(T_VIDEO, 0, seq, millis()) + jpeg)
                sent += 1
            if time.monotonic() - t_report >= 5.0:
                print(f"[rpi] {sent / (time.monotonic() - t_report):.1f} fps sent")
                sent, t_report = 0, time.monotonic()
            # Deadline pacing: sleep to the NEXT slot so send time doesn't eat the period.
            next_send += interval
            delay = next_send - time.monotonic()
            if delay < -1.0:  # fell far behind (WiFi stall): reset instead of spiraling
                next_send = time.monotonic()
                delay = 0.0
            await asyncio.sleep(max(0.001, delay))
    finally:
        recv.cancel()


async def main() -> None:
    ap = argparse.ArgumentParser(description="Remember rpi camera device")
    ap.add_argument("--hub", required=True, help="ws://<hub-ip>:8765")
    ap.add_argument("--device-id", default="rpi-cam")
    ap.add_argument("--width", type=int, default=1280)
    ap.add_argument("--height", type=int, default=720)
    ap.add_argument("--fps", type=int, default=24)
    ap.add_argument("--quality", type=int, default=70)
    ap.add_argument("--hflip", action="store_true", help="mirror at the source (fixes perception)")
    ap.add_argument(
        "--vflip", action="store_true", help="flip at the source (rig mounted upside down)"
    )
    args = ap.parse_args()

    video_cfg = {"w": args.width, "h": args.height, "fps": args.fps, "quality": args.quality}
    camera = Camera(hflip=args.hflip, vflip=args.vflip)
    backoff = 0.5
    try:
        while True:
            try:
                async with websockets.connect(args.hub, compression=None) as ws:
                    print(f"[rpi] connected to {args.hub}")
                    backoff = 0.5
                    await session(ws, camera, video_cfg, args.device_id)
            except (OSError, websockets.WebSocketException) as e:
                print(f"[rpi] hub connection lost ({e!r}); retry in {backoff:.1f}s")
                await asyncio.sleep(backoff)
                backoff = min(backoff * 2, 5.0)
            if camera.dead.is_set():
                raise SystemExit(1)  # camera is FATALLY dead; no point reconnecting
    finally:
        camera.stop()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
