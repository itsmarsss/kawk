"""Local ops dashboard: live camera feed (MJPEG) + graphs + device control.

Zero new dependencies — a tiny asyncio HTTP server (core deps rule, AGENTS.md §11).
The feed is multipart/x-mixed-replace pulled from devicelink's newest-wins frame
slots, so it adds no capture path and can never back-pressure the pipeline
(slow browser -> frames simply skip; same drop-when-behind discipline as §3.1).
Graphs are client-side canvas sparklines over /stats.json polls — no chart libs.

Endpoints:
  GET /            the dashboard page
  GET /stream      MJPEG of the newest frame across devices (?device=<id> to pin)
  GET /frame.jpg   single latest frame (snapshot)
  GET /stats.json  devices (fps/lag/bitrate), display state, recent actions, backends
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
from .contracts.decisions import GateResult
from .contracts.display import DisplayAction
from .contracts.percepts import TranscriptSegment
from .devicelink.server import DeviceLinkServer
from .display.compositor import Compositor

log = logging.getLogger(__name__)

_STREAM_FPS = 30.0  # poll rate of the newest-wins slot; must exceed device fps

_PAGE = r"""<!doctype html>
<html><head><meta charset="utf-8"><title>__NAME__ — dashboard</title>
<style>
  :root { --bg:#0b0e14; --panel:#11141c; --line:#313244; --text:#cdd6f4; --dim:#94a3c0;
          --acc:#89b4fa; --ok:#a6e3a1; --warn:#f9e2af; --bad:#f38ba8; }
  * { box-sizing:border-box; }
  body { background:var(--bg); color:var(--text); margin:0; padding:20px;
         font:14px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace; }
  h1 { font-size:17px; margin:0; color:var(--acc); }
  .top { display:flex; align-items:center; gap:10px; margin-bottom:16px; flex-wrap:wrap; }
  .chip { background:var(--panel); border:1px solid var(--line); border-radius:99px;
          padding:3px 12px; font-size:12px; color:var(--dim); }
  .chip b { color:var(--text); font-weight:600; }
  #devchip.on { border-color:var(--ok); color:var(--ok); }
  #devchip.off { border-color:var(--bad); color:var(--bad); }
  .row { display:flex; gap:18px; flex-wrap:wrap; align-items:flex-start; }
  .feedwrap { flex:2; min-width:420px; max-width:900px; }
  img#feed { width:100%; border:1px solid var(--line); border-radius:10px; background:#000;
             display:block; }
  .col { display:flex; flex-direction:column; gap:14px; flex:1; min-width:340px; }
  .panel { background:var(--panel); border:1px solid var(--line); border-radius:10px;
           padding:13px 16px; }
  .panel h2 { font-size:11px; letter-spacing:.08em; margin:0 0 10px; color:var(--dim);
              text-transform:uppercase; }
  pre { margin:0; white-space:pre-wrap; font-size:12px; }
  .card { font-size:15px; } .card b { color:var(--ok); }
  .toolbar { margin-top:10px; display:flex; gap:8px; flex-wrap:wrap; align-items:center; }
  button, select { background:#1e2433; color:var(--text); border:1px solid #45475a;
                   border-radius:6px; padding:6px 12px; font:inherit; cursor:pointer; }
  button:hover { background:#2a3145; }
  button.on { background:#2b3a55; border-color:var(--acc); color:var(--acc); }
  input[type=range] { accent-color:var(--acc); vertical-align:middle; }
  .stat { display:flex; justify-content:space-between; align-items:baseline;
          font-size:12px; color:var(--dim); margin:8px 0 2px; }
  .stat:first-child { margin-top:0; }
  .stat b { color:var(--text); font-size:15px; }
  canvas { width:100%; height:48px; display:block; }
  .grid2 { display:grid; grid-template-columns:1fr 1fr; gap:14px; }
  .muted { color:var(--dim); font-style:italic; }
  .dev { font-size:12px; line-height:1.8; }
  .dev b { color:var(--acc); }
  .kv { color:var(--dim); }
</style></head>
<body>
<div class="top">
  <h1>__NAME__ hub</h1>
  <span class="chip off" id="devchip">no device</span>
  <span class="chip">display <b id="dispchip">idle</b></span>
  <span class="chip" id="backends">backends —</span>
</div>
<div class="row">
  <div class="feedwrap">
    <img id="feed" src="/stream" alt="camera feed">
    <div class="toolbar">
      <button id="flipH">flip ↔</button>
      <button id="flipV">flip ↕</button>
      <button onclick="window.open('/frame.jpg','_blank')">snapshot</button>
      <span style="flex:1"></span>
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
      <button id="apply">apply</button>
      <span id="applyMsg"></span>
    </div>
    <div class="grid2" style="margin-top:14px;">
      <div class="panel">
        <h2>display now</h2>
        <div class="card" id="card"><span class="muted">idle — nothing to show</span></div>
      </div>
      <div class="panel">
        <h2>recent display cards</h2>
        <pre id="actions" class="muted">none yet — cards appear when a task fires</pre>
      </div>
    </div>
    <div class="panel" style="margin-top:14px;">
      <h2>live transcript</h2>
      <pre id="transcript" class="muted">no speech yet — needs a mic device and non-mock STT</pre>
    </div>
  </div>
  <div class="col">
    <div class="panel">
      <h2>throughput — last 3 min</h2>
      <div class="stat"><span>frames / s</span><b id="v_fps">—</b></div>
      <canvas id="c_fps"></canvas>
      <div class="stat"><span>lag (staleness)</span><b id="v_lag">—</b></div>
      <canvas id="c_lag"></canvas>
      <div class="stat"><span>bitrate</span><b id="v_mbps">—</b></div>
      <canvas id="c_mbps"></canvas>
      <div class="stat"><span>frame size</span><b id="v_kb">—</b></div>
      <canvas id="c_kb"></canvas>
    </div>
    <div class="panel"><h2>devices</h2>
      <div id="devices" class="muted">none connected</div></div>
    <div class="panel"><h2>gate decisions (jev)</h2>
      <pre id="gates" class="muted">none yet — fires on speech finals and world changes</pre></div>
  </div>
</div>
<script>
// ---- view flips (per-browser; for a physically rotated rig use rpi_device --hflip/--vflip)
const feed = document.getElementById('feed');
let fx = +(localStorage.fx || 0), fy = +(localStorage.fy || 0);
function applyFlip() {
  feed.style.transform = `scale(${fx ? -1 : 1}, ${fy ? -1 : 1})`;
  document.getElementById('flipH').classList.toggle('on', !!fx);
  document.getElementById('flipV').classList.toggle('on', !!fy);
}
document.getElementById('flipH').onclick = () => { fx ^= 1; localStorage.fx = fx; applyFlip(); };
document.getElementById('flipV').onclick = () => { fy ^= 1; localStorage.fy = fy; applyFlip(); };
applyFlip();

// ---- device control
document.getElementById('apply').onclick = async () => {
  const [w, h] = document.getElementById('res').value.split('x');
  const fps = document.getElementById('fps').value;
  const q = document.getElementById('q').value;
  const msg = document.getElementById('applyMsg');
  msg.textContent = '…';
  try {
    const r = await (await fetch(`/control?w=${w}&h=${h}&fps=${fps}&quality=${q}`)).json();
    msg.textContent = r.ok ? `pushed to ${r.pushed.join(', ')}` : 'no device connected';
  } catch (e) { msg.textContent = 'failed'; }
  setTimeout(() => { msg.textContent = ''; }, 4000);
};

// ---- sparkline history (client-side ring buffers over /stats.json polls)
const CAP = 180;  // 3 min at 1 Hz
const hist = { fps: [], lag: [], mbps: [], kb: [] };
function push(key, value) {
  hist[key].push(value);
  if (hist[key].length > CAP) hist[key].shift();
}
function spark(id, data, color) {
  const c = document.getElementById(id);
  const dpr = window.devicePixelRatio || 1;
  const w = c.clientWidth, h = c.clientHeight;
  if (!w) return;
  c.width = w * dpr; c.height = h * dpr;
  const x = c.getContext('2d');
  x.scale(dpr, dpr);
  x.clearRect(0, 0, w, h);
  if (data.length < 2) return;
  const max = Math.max(...data, 1e-6);
  const px = i => (i + (CAP - data.length)) / (CAP - 1) * w;   // right-aligned scroll
  const py = v => h - 2 - (v / max) * (h - 8);
  x.beginPath();
  data.forEach((v, i) => i ? x.lineTo(px(i), py(v)) : x.moveTo(px(i), py(v)));
  x.strokeStyle = color; x.lineWidth = 1.5; x.stroke();
  x.lineTo(px(data.length - 1), h); x.lineTo(px(0), h); x.closePath();
  x.fillStyle = color + '22'; x.fill();
  x.fillStyle = '#94a3c0'; x.font = '9px ui-monospace';
  x.fillText(max.toFixed(max < 10 ? 1 : 0), 4, 10);           // y-axis max marker
}
const css = v => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
const fmtUp = s => s < 90 ? `${s}s` : s < 5400 ? `${Math.round(s / 60)}m` : `${(s / 3600).toFixed(1)}h`;

// Sync controls to the device's ACTUAL config once — but never fight the user.
let controlsTouched = false, controlsSynced = false;
for (const id of ['res', 'fps', 'q'])
  document.getElementById(id).addEventListener('input', () => { controlsTouched = true; });

async function poll() {
  try {
    const s = await (await fetch('/stats.json')).json();
    const d = s.devices[0];
    const chip = document.getElementById('devchip');
    if (d) {
      chip.textContent = `${d.id} · ${d.wh ? d.wh.join('×') : '?'} · up ${fmtUp(d.connected_s)}`;
      chip.className = 'chip on';
      push('fps', d.fps); push('lag', d.lag_ms ?? 0);
      push('mbps', d.mbps); push('kb', d.kb);
      document.getElementById('v_fps').textContent = d.fps.toFixed(1);
      const lagEl = document.getElementById('v_lag');
      lagEl.textContent = (d.lag_ms ?? 0) + ' ms';
      lagEl.style.color = d.lag_ms > 300 ? css('--bad') : d.lag_ms > 100 ? css('--warn') : css('--ok');
      document.getElementById('v_mbps').textContent = d.mbps.toFixed(1) + ' Mbit/s';
      document.getElementById('v_kb').textContent = d.kb + ' KB';
      spark('c_fps', hist.fps, css('--acc'));
      spark('c_lag', hist.lag, css('--warn'));
      spark('c_mbps', hist.mbps, css('--ok'));
      spark('c_kb', hist.kb, css('--dim'));
      if (d.cfg && !controlsSynced && !controlsTouched) {
        controlsSynced = true;
        const res = document.getElementById('res');
        const want = `${d.cfg.w}x${d.cfg.h}`;
        if ([...res.options].some(o => o.value === want)) res.value = want;
        document.getElementById('fps').value = String(d.cfg.fps);
        document.getElementById('q').value = d.cfg.quality;
        document.getElementById('qv').textContent = d.cfg.quality;
      }
    } else {
      chip.textContent = 'no device';
      chip.className = 'chip off';
    }
    const devEl = document.getElementById('devices');
    if (s.devices.length) {
      devEl.className = '';
      devEl.innerHTML = s.devices.map(x => `<div class="dev">
        <b>${x.id}</b> <span class="kv">(${x.cls}) · connected ${fmtUp(x.connected_s)}</span><br>
        ${x.wh ? x.wh.join('×') : '?'} @ ${x.fps.toFixed(1)} fps · ${x.kb} KB · ${x.mbps.toFixed(1)} Mbit/s · lag ${x.lag_ms ?? '-'} ms<br>
        <span class="kv">cfg ${x.cfg ? `${x.cfg.w}×${x.cfg.h}@${x.cfg.fps} q${x.cfg.quality}` : '?'}
        · frames ${x.frames_rx.toLocaleString()} · audio ${x.audio_rx.toLocaleString()}</span></div>`).join('');
    }
    const c = s.display;
    document.getElementById('dispchip').textContent = c.template;
    if (c.template !== 'idle') {
      document.getElementById('card').innerHTML =
        `<b>[${c.template}]</b> ${c.title} — ${c.body} <small class="kv">(${c.age_s.toFixed(0)}s ago)</small>`;
    } else {
      document.getElementById('card').innerHTML = '<span class="muted">idle — nothing to show</span>';
    }
    const put = (id, rows, fmt) => {
      if (!rows.length) return;
      const el = document.getElementById(id);
      el.className = '';
      el.textContent = rows.map(fmt).join('\n');
    };
    put('actions', s.actions, a => `${a.t}  [${a.template}] ${a.title} — ${a.body}`);
    put('gates', s.gates, g =>
      `${g.t}  ${g.intent}${g.target ? ' → ' + g.target : ''}  (${g.source}, ${g.conf})`);
    put('transcript', s.transcript, t => `${t.t}  [${t.speaker}] ${t.text}`);
    document.getElementById('backends').textContent =
      'backends ' + Object.entries(s.backends).map(([k, v]) => `${k}:${v}`).join(' ');
  } catch (e) {}
  setTimeout(poll, 1000);
}
poll();
</script>
</body></html>
"""


class Dashboard:
    def __init__(
        self,
        bus: EventBus,
        link: DeviceLinkServer,
        compositor: Compositor,
        cfg: DashboardCfg,
        backends: dict[str, str] | None = None,
    ) -> None:
        self.link = link
        self.compositor = compositor
        self.cfg = cfg
        self.backends = backends or {}
        self._server: asyncio.Server | None = None
        self._actions: deque[dict] = deque(maxlen=8)
        self._gates: deque[dict] = deque(maxlen=8)
        self._finals: deque[dict] = deque(maxlen=6)
        self._fps: dict[str, tuple[float, int, float]] = {}  # id -> (t, frames_rx, fps)
        bus.subscribe("display.action", self._on_action)
        bus.subscribe("gate.result", self._on_gate)
        bus.subscribe("percepts.stt", self._on_stt)

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

    async def _on_gate(self, result: GateResult) -> None:
        self._gates.appendleft(
            {
                "t": time.strftime("%H:%M:%S"),
                "intent": result.intent.value,
                "source": result.source_question,
                "target": result.target_label or result.person_track or "",
                "conf": round(result.confidence, 2),
            }
        )

    async def _on_stt(self, seg: TranscriptSegment) -> None:
        if seg.is_final:
            self._finals.appendleft(
                {"t": time.strftime("%H:%M:%S"), "text": seg.text, "speaker": seg.speaker}
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
                body = _PAGE.replace("__NAME__", PRODUCT_NAME).encode()
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
            kb = round(len(lf.jpeg) / 1024) if lf else 0
            devices.append(
                {
                    "id": device_id,
                    "cls": session.cls,
                    "frames_rx": session.frames_rx,
                    "audio_rx": session.audio_rx,
                    "fps": round(max(fps, 0.0), 1),
                    "wh": list(lf.wh) if lf else None,
                    "kb": kb,
                    "mbps": round(max(fps, 0.0) * kb * 8 / 1000, 2),
                    "lag_ms": round(lag) if lag is not None else None,
                    "cfg": session.config.get("video"),
                    "connected_s": round(now - session.connected_at),
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
            "gates": list(self._gates),
            "transcript": list(self._finals),
            "backends": self.backends,
        }
