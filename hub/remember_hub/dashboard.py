"""Local ops dashboard: live camera feed (MJPEG) + device stats + display state.

Zero new dependencies — a tiny asyncio HTTP server (core deps rule, AGENTS.md §11).
The feed is multipart/x-mixed-replace pulled from devicelink's newest-wins frame
slots, so it adds no capture path and can never back-pressure the pipeline
(slow browser -> frames simply skip; same drop-when-behind discipline as §3.1).

Endpoints:
  GET /            the dashboard page
  GET /stream      MJPEG of the newest frame across devices (?device=<id> to pin)
  GET /frame.jpg   single latest frame (snapshot)
  GET /stats.json  devices, current display, recent display actions
  GET /control?device=<id>&w=&h=&fps=&quality=   push video config to a device
                   (GET-with-params on purpose: local testing surface, tiny server)
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
from collections import deque
from urllib.parse import parse_qs, urlparse

from .branding import PRODUCT_NAME
from .bus import EventBus
from .config import DashboardCfg
from .contracts.display import DisplayAction
from .devicelink.server import DeviceLinkServer
from .display.compositor import Compositor

log = logging.getLogger(__name__)

_STREAM_FPS = 30.0  # poll rate of the newest-wins slot; must exceed device fps

_PAGE = """<!doctype html>
<html><head><meta charset="utf-8"><title>{name} — dashboard</title>
<style>
  body {{ background:#0b0e14; color:#cdd6f4; font:14px/1.5 -apple-system,system-ui,monospace;
         margin:0; padding:24px; }}
  h1 {{ font-size:18px; margin:0 0 16px; color:#89b4fa; }}
  .row {{ display:flex; gap:24px; flex-wrap:wrap; align-items:flex-start; }}
  img {{ max-width:640px; width:100%; border:1px solid #313244; border-radius:8px;
        background:#000; }}
  .panel {{ background:#11141c; border:1px solid #313244; border-radius:8px;
           padding:14px 18px; min-width:320px; }}
  .panel h2 {{ font-size:13px; margin:0 0 8px; color:#94a3c0; text-transform:uppercase; }}
  pre {{ margin:0; white-space:pre-wrap; font-size:12px; }}
  .card {{ font-size:16px; }} .card b {{ color:#a6e3a1; }}
  .toolbar {{ margin-top:8px; display:flex; gap:8px; }}
  button {{ background:#1e2433; color:#cdd6f4; border:1px solid #45475a; border-radius:6px;
           padding:6px 14px; font:inherit; cursor:pointer; }}
  button:hover {{ background:#2a3145; }}
  button.on {{ background:#2b3a55; border-color:#89b4fa; color:#89b4fa; }}
</style></head>
<body>
<h1>{name} — hub dashboard</h1>
<div class="row">
  <div>
    <img id="feed" src="/stream" alt="camera feed">
    <div class="toolbar">
      <button id="flipH">flip ↔</button>
      <button id="flipV">flip ↕</button>
      <button onclick="window.open('/frame.jpg','_blank')">snapshot</button>
    </div>
    <div class="panel toolbar" style="margin-top:12px; align-items:center; flex-wrap:wrap;">
      <select id="res">
        <option value="640x480">640×480</option>
        <option value="1280x720" selected>1280×720</option>
        <option value="1920x1080">1920×1080</option>
      </select>
      <select id="fps">
        <option>5</option><option>10</option><option>15</option>
        <option selected>24</option><option>30</option>
      </select>
      <label>q <input id="q" type="range" min="10" max="95" value="70"
        oninput="document.getElementById('qv').textContent=this.value"></label>
      <span id="qv">70</span>
      <button id="apply">apply to device</button>
      <span id="applyMsg"></span>
    </div>
  </div>
  <div>
    <div class="panel"><h2>display now</h2><div class="card" id="card">—</div></div>
    <br>
    <div class="panel"><h2>devices</h2><pre id="devices">—</pre></div>
    <br>
    <div class="panel"><h2>recent display actions</h2><pre id="actions">—</pre></div>
  </div>
</div>
<script>
// View-only flips (per-browser, persisted). For a physically upside-down rig,
// flip at the SOURCE instead: rpi_device.py --hflip/--vflip (fixes perception too).
const feed = document.getElementById('feed');
let fx = +(localStorage.fx || 0), fy = +(localStorage.fy || 0);
function applyFlip() {{
  feed.style.transform = `scale(${{fx ? -1 : 1}}, ${{fy ? -1 : 1}})`;
  document.getElementById('flipH').classList.toggle('on', !!fx);
  document.getElementById('flipV').classList.toggle('on', !!fy);
}}
document.getElementById('flipH').onclick = () => {{ fx ^= 1; localStorage.fx = fx; applyFlip(); }};
document.getElementById('flipV').onclick = () => {{ fy ^= 1; localStorage.fy = fy; applyFlip(); }};
applyFlip();
document.getElementById('apply').onclick = async () => {{
  const [w, h] = document.getElementById('res').value.split('x');
  const fps = document.getElementById('fps').value;
  const q = document.getElementById('q').value;
  const msg = document.getElementById('applyMsg');
  msg.textContent = '…';
  try {{
    const r = await (await fetch(`/control?w=${{w}}&h=${{h}}&fps=${{fps}}&quality=${{q}}`)).json();
    msg.textContent = r.ok ? `pushed to ${{r.pushed.join(', ')}}` : 'no device connected';
  }} catch (e) {{ msg.textContent = 'failed'; }}
  setTimeout(() => {{ msg.textContent = ''; }}, 4000);
}};
async function poll() {{
  try {{
    const s = await (await fetch('/stats.json')).json();
    document.getElementById('devices').textContent = s.devices.map(d =>
      `${{d.id}} (${{d.cls}})  ${{d.fps.toFixed(1)}} fps  frames=${{d.frames_rx}}  ` +
      `audio=${{d.audio_rx}}  ${{d.wh ? d.wh.join('x') : '-'}}  ${{d.kb}}KB  ` +
      `lag=${{d.lag_ms == null ? '-' : d.lag_ms + 'ms'}}`).join('\\n') || '(none connected)';
    const c = s.display;
    document.getElementById('card').innerHTML =
      c.template === 'idle' ? '<i>idle</i>' :
      `<b>[${{c.template}}]</b> ${{c.title}} — ${{c.body}} <small>(${{c.age_s.toFixed(0)}}s)</small>`;
    document.getElementById('actions').textContent =
      s.actions.map(a => `${{a.t}}  [${{a.template}}] ${{a.title}} — ${{a.body}}`).join('\\n') || '(none yet)';
  }} catch (e) {{}}
  setTimeout(poll, 1000);
}}
poll();
</script>
</body></html>
"""


class Dashboard:
    def __init__(
        self, bus: EventBus, link: DeviceLinkServer, compositor: Compositor, cfg: DashboardCfg
    ) -> None:
        self.link = link
        self.compositor = compositor
        self.cfg = cfg
        self._server: asyncio.Server | None = None
        self._actions: deque[dict] = deque(maxlen=8)
        self._fps: dict[str, tuple[float, int, float]] = {}  # id -> (t, frames_rx, fps)
        bus.subscribe("display.action", self._on_action)

    async def _on_action(self, action: DisplayAction) -> None:
        if action.card is not None:
            self._actions.appendleft(
                {
                    "t": time.strftime("%H:%M:%S"),
                    "template": action.card.template.value,
                    "title": action.card.title,
                    "body": action.card.body,
                }
            )

    async def start(self, port: int | None = None) -> int:
        self._server = await asyncio.start_server(
            self._handle, self.cfg.host, self.cfg.port if port is None else port
        )
        actual = self._server.sockets[0].getsockname()[1]
        log.info("dashboard on http://%s:%s", self.cfg.host, actual)
        return actual

    async def stop(self) -> None:
        if self._server:
            self._server.close()
            await self._server.wait_closed()

    # ---- http ------------------------------------------------------------------

    async def _handle(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        try:
            request = await asyncio.wait_for(reader.readuntil(b"\r\n\r\n"), timeout=5)
            path = request.split(b" ", 2)[1].decode("latin-1", "replace")
            parsed = urlparse(path)
            if parsed.path == "/":
                body = _PAGE.format(name=PRODUCT_NAME).encode()
                self._respond(writer, "200 OK", "text/html; charset=utf-8", body)
            elif parsed.path == "/stats.json":
                body = json.dumps(self._stats()).encode()
                self._respond(writer, "200 OK", "application/json", body)
            elif parsed.path == "/stream":
                device = (parse_qs(parsed.query).get("device") or [None])[0]
                await self._stream(writer, device)
            elif parsed.path == "/frame.jpg":
                device = (parse_qs(parsed.query).get("device") or [None])[0]
                got = self._frame_for(device)
                if got is None:
                    self._respond(writer, "404 Not Found", "text/plain", b"no frame yet")
                else:
                    self._respond(writer, "200 OK", "image/jpeg", got[1].jpeg)
            elif parsed.path == "/control":
                body = await self._control(parse_qs(parsed.query))
                self._respond(writer, "200 OK", "application/json", body)
            else:
                self._respond(writer, "404 Not Found", "text/plain", b"not found")
            await writer.drain()
        except (TimeoutError, asyncio.IncompleteReadError, ConnectionResetError, BrokenPipeError):
            pass
        except Exception:
            log.exception("dashboard request failed")
        finally:
            try:
                writer.close()
                await writer.wait_closed()
            except Exception:
                pass

    def _respond(self, writer: asyncio.StreamWriter, status: str, ctype: str, body: bytes) -> None:
        writer.write(
            f"HTTP/1.1 {status}\r\nContent-Type: {ctype}\r\n"
            f"Content-Length: {len(body)}\r\nCache-Control: no-store\r\n"
            f"Connection: close\r\n\r\n".encode()
            + body
        )

    async def _stream(self, writer: asyncio.StreamWriter, device: str | None) -> None:
        """MJPEG: push each new frame; skip when the browser is slower than the feed."""
        writer.write(
            b"HTTP/1.1 200 OK\r\n"
            b"Content-Type: multipart/x-mixed-replace; boundary=frame\r\n"
            b"Cache-Control: no-store\r\nConnection: close\r\n\r\n"
        )
        last: tuple[str, int] | None = None
        while True:
            got = self._frame_for(device)
            if got is not None:
                device_id, lf = got
                key = (device_id, lf.seq)
                if key != last:
                    last = key
                    writer.write(
                        b"--frame\r\nContent-Type: image/jpeg\r\n"
                        + f"Content-Length: {len(lf.jpeg)}\r\n\r\n".encode()
                        + lf.jpeg
                        + b"\r\n"
                    )
                    await writer.drain()
            await asyncio.sleep(1.0 / _STREAM_FPS)

    async def _control(self, params: dict[str, list[str]]) -> bytes:
        def num(key: str, default: int) -> int:
            try:
                return int(params.get(key, [default])[0])
            except (TypeError, ValueError):
                return default

        device = (params.get("device") or [None])[0]
        targets = [device] if device else list(self.link.devices)
        video = {
            "w": max(64, min(4096, num("w", 1280))),
            "h": max(64, min(4096, num("h", 720))),
            "fps": max(1, min(60, num("fps", 24))),
            "quality": max(5, min(95, num("quality", 70))),
        }
        pushed = []
        for target in targets:
            try:
                await self.link.push_config(target, video)
                pushed.append(target)
            except KeyError:
                pass
        return json.dumps({"ok": bool(pushed), "pushed": pushed, "video": video}).encode()

    def _frame_for(self, device: str | None):
        if device:
            session = self.link.devices.get(device)
            if session is None or session.latest_frame is None:
                return None
            return (device, session.latest_frame)
        return self.link.any_frame()

    def _stats(self) -> dict:
        now = time.time()
        devices = []
        for device_id, session in self.link.devices.items():
            entry = self._fps.get(device_id)
            if entry is None:
                self._fps[device_id] = (now, session.frames_rx, 0.0)  # seed the first sample
                fps = 0.0
            else:
                prev_t, prev_n, fps = entry
                if now - prev_t >= 1.0:
                    fps = (session.frames_rx - prev_n) / (now - prev_t)
                    self._fps[device_id] = (now, session.frames_rx, fps)
            lf = session.latest_frame
            lag = session.frame_lag_ms()
            devices.append(
                {
                    "id": device_id,
                    "cls": session.cls,
                    "frames_rx": session.frames_rx,
                    "audio_rx": session.audio_rx,
                    "fps": round(max(fps, 0.0), 1),
                    "wh": list(lf.wh) if lf else None,
                    "kb": round(len(lf.jpeg) / 1024) if lf else 0,
                    "lag_ms": round(lag) if lag is not None else None,
                }
            )
        template, age_s = self.compositor.state()
        card = self.compositor.current.card
        return {
            "devices": devices,
            "display": {
                "template": template,
                "title": card.title if card else "",
                "body": card.body if card else "",
                "age_s": age_s,
            },
            "actions": list(self._actions),
        }
