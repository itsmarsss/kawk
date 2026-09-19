import {
  wsUrl, fmtMs, fmtSeconds, setStatus, setError, fillDeviceSelect, describeMediaError, onPageLeave, stopTracks, setupBackendSelector,
} from '/static/common.js';

const $ = (id) => document.getElementById(id);
const el = {
  mic: $('mic'), refresh: $('refresh'), start: $('start'), stop: $('stop'), clear: $('clear'),
  status: $('status'), error: $('error'), meter: $('meter'), meterFill: $('meter-fill'), level: $('level'),
  speaking: $('speaking'), model: $('model'), connect: $('connect'), elapsed: $('elapsed'), ctxrate: $('ctxrate'),
  chunks: $('chunks'), buffered: $('buffered'), lagFirst: $('lag-first'), lagFinal: $('lag-final'),
  transcript: $('transcript'),
  backend: $('backend'), backendDetail: $('backend-detail'), recheck: $('recheck'),
};

const MAX_ROWS = 100;
const MAX_BUFFERED_BYTES = 16384; // 512 ms of 16 kHz PCM16
const CLOSE_GRACE_MS = 3000;      // after {type:"stop"}: server waits up to 2 s for a final, then closes

// Capability is decided once at load; setButtons() respects it forever.
const capable = Boolean(navigator.mediaDevices?.getUserMedia) && Boolean(window.AudioWorklet);

// ---- session ---------------------------------------------------------------
// Exactly one session may exist. Every awaited step re-checks `s.ended` afterwards so a Stop
// (or page leave) during getUserMedia / addModule cannot leave a live stream or context behind.
let session = null;
let sessionSeq = 0;
let maxSessionS = 600;

function newSession() {
  return {
    id: ++sessionSeq, phase: 'connecting', ended: false,
    ws: null, stream: null, ctx: null, source: null, node: null, ready: null,
    startAt: performance.now(), readyAt: 0, chunksSent: 0,
    elapsedTimer: null, flushTimer: null, closeTimer: null,
  };
}
const isCurrent = (s) => s !== null && s === session && !s.ended;

// transcript rows: segment_id -> { li, text, time, final, firstSeen, utterance, onsetChecked }
const rows = new Map();

// Local sound-boundary tracking for delay estimates (noise-sensitive, page-side only).
// utterance: bumped at every sound onset, so a final is only paired with the end of the same
// sound that the row's first partial was paired with.
const gate = {
  speaking: false, quietSince: 0, floor: 0.005, utterance: 0,
  pendingOnset: null, lastEnd: null, lastEndUtt: -1, endSealed: false, lastEndUsed: false,
};
function resetGate() {
  Object.assign(gate, { speaking: false, quietSince: 0, utterance: 0, pendingOnset: null, lastEnd: null, lastEndUtt: -1, endSealed: false, lastEndUsed: false });
}

// Backend choice. Changing it stops any session and clears results; Start is required again.
const backendUi = setupBackendSelector({
  select: el.backend, detail: el.backendDetail, recheck: el.recheck, kind: 'speech', defaultBackend: 'baseten',
  onChange: (value, reason) => {
    if (reason !== 'refreshed') {
      if (session) endSession(session, { status: 'Backend changed; session stopped. Click Start to use the selected backend.' });
      clearResults();
    }
    setButtons();
  },
});

function clearResults() {
  clearTranscript();
  for (const key of ['model', 'connect', 'elapsed', 'ctxrate', 'chunks', 'buffered']) el[key].textContent = '–';
}

// ---- UI helpers ------------------------------------------------------------
function setButtons() {
  const s = session;
  el.start.disabled = !capable || s !== null || !backendUi.configured;
  el.backend.disabled = s !== null;
  el.stop.disabled = s === null || s.phase === 'stopping';
  el.mic.disabled = s !== null && (s.phase === 'connecting' || s.phase === 'stopping');
}

function nowRel(s) { return (performance.now() - s.startAt) / 1000; }

function updateElapsed(s) {
  if (!s.readyAt) { el.elapsed.textContent = '–'; return; }
  el.elapsed.textContent = `${fmtSeconds((performance.now() - s.readyAt) / 1000)} of ${fmtSeconds(maxSessionS)} max`;
  if (s.ws) el.buffered.textContent = `${s.ws.bufferedAmount} bytes`;
}

function resetMeter() {
  el.meterFill.style.width = '0%';
  el.meter.setAttribute('aria-valuenow', '-60');
  el.level.textContent = '–';
  el.speaking.textContent = '';
}

function onLevel(rms) {
  const db = rms > 0 ? Math.max(-60, Math.min(0, 20 * Math.log10(rms))) : -60;
  el.meterFill.style.width = `${((db + 60) / 60) * 100}%`;
  el.meter.setAttribute('aria-valuenow', String(Math.round(db)));
  el.level.textContent = `${db.toFixed(0)} dBFS`;

  // Adaptive gate: floor follows quiet levels slowly; "sound" when well above floor.
  const threshold = Math.max(0.015, gate.floor * 3);
  const loud = rms > threshold;
  if (!loud) gate.floor = gate.floor * 0.98 + rms * 0.02;
  const t = performance.now();
  if (loud && !gate.speaking) {
    gate.speaking = true;
    gate.utterance += 1;
    gate.pendingOnset = t;
    gate.endSealed = false;
  } else if (!loud && gate.speaking) {
    gate.speaking = false;
    gate.quietSince = t;
  } else if (!loud && !gate.speaking && gate.quietSince && !gate.endSealed && t - gate.quietSince >= 300) {
    gate.lastEnd = gate.quietSince;
    gate.lastEndUtt = gate.utterance;
    gate.endSealed = true;
    gate.lastEndUsed = false; // the onset stays pairable: short words end before their first partial arrives
  }
  el.speaking.textContent = loud ? 'sound detected' : 'quiet';
}

// ---- transcript ------------------------------------------------------------
function onTranscript(s, msg) {
  const id = String(msg.segment_id);
  let row = rows.get(id);
  const t = performance.now();
  if (row && row.final) return; // finalized once; ignore late snapshots
  if (!row) {
    while (rows.size >= MAX_ROWS) {
      const [oldestId, oldest] = rows.entries().next().value;
      oldest.li.remove();
      rows.delete(oldestId);
    }
    const li = document.createElement('li');
    const tag = document.createElement('span'); tag.className = 'tag';
    const text = document.createElement('span'); text.className = 'text';
    const time = document.createElement('span'); time.className = 'time';
    li.append(tag, text, time);
    el.transcript.append(li);
    row = { li, tag, text, time, final: false, firstSeen: t, utterance: -1, onsetChecked: false };
    rows.set(id, row);
    el.transcript.scrollTop = el.transcript.scrollHeight;
  }
  // "Sound start → first partial": only the first NON-EMPTY PARTIAL of a row counts. A row that
  // arrives already final, or an empty partial, never updates this estimate.
  if (!msg.is_final && msg.text && !row.onsetChecked) {
    row.onsetChecked = true;
    if (gate.pendingOnset !== null && t - gate.pendingOnset < 6000) {
      el.lagFirst.textContent = `${fmtMs(t - gate.pendingOnset)} (estimate)`;
      row.utterance = gate.utterance;
      gate.pendingOnset = null;
    } else {
      el.lagFirst.textContent = 'n/a';
    }
  }
  row.text.textContent = msg.text || (msg.is_final ? '(empty)' : '…');
  row.time.textContent = `+${nowRel(s).toFixed(1)}s`;
  if (msg.is_final) {
    row.final = true;
    row.li.className = 'final';
    row.tag.textContent = 'final';
    // "Sound end → final": pair only with the sealed end of the same sound, while quiet, once.
    if (row.utterance >= 0 && gate.endSealed && !gate.lastEndUsed && !gate.speaking
        && gate.lastEndUtt === row.utterance && t - gate.lastEnd < 8000) {
      el.lagFinal.textContent = `${fmtMs(t - gate.lastEnd)} (estimate)`;
      gate.lastEndUsed = true;
    } else {
      el.lagFinal.textContent = 'n/a';
    }
  } else {
    row.li.className = 'partial';
    row.tag.textContent = 'partial';
  }
}

function clearTranscript() {
  rows.clear();
  el.transcript.replaceChildren();
  el.lagFirst.textContent = 'n/a';
  el.lagFinal.textContent = 'n/a';
}

// ---- microphone / audio graph ------------------------------------------------
// Returns false if the session ended while a step was pending (everything acquired is released).
async function startMic(s) {
  const deviceId = el.mic.value;
  const constraints = { audio: deviceId ? { deviceId: { exact: deviceId } } : true, video: false };
  const stream = await navigator.mediaDevices.getUserMedia(constraints);
  s.stream = stream;
  if (!isCurrent(s)) { teardownMic(s); return false; }
  await refreshDevices(); // labels become available after access
  if (!isCurrent(s)) { teardownMic(s); return false; }

  const track = stream.getAudioTracks()[0];
  if (track) {
    track.addEventListener('ended', () => {
      if (isCurrent(s) && s.phase === 'capturing') {
        endSession(s, { error: 'Microphone disconnected (track ended). Click Refresh devices, choose another microphone, and Start again.' });
      }
    });
    const settings = track.getSettings?.();
    if (settings?.deviceId) el.mic.value = settings.deviceId;
  }

  const wantRate = s.ready.sample_rate || 16000;
  let ctx;
  try { ctx = new AudioContext({ sampleRate: wantRate }); } catch { ctx = new AudioContext(); }
  s.ctx = ctx;
  // Do not trust the requested rate: Safari may ignore it. The worklet resamples from the actual rate.
  const actualRate = ctx.sampleRate;
  el.ctxrate.textContent = actualRate === wantRate ? `${actualRate} Hz (no resampling)` : `${actualRate} Hz → resampled to ${wantRate} Hz`;
  await ctx.audioWorklet.addModule('/static/speech-worklet.js');
  if (!isCurrent(s)) { teardownMic(s); return false; }

  s.source = ctx.createMediaStreamSource(stream);
  s.node = new AudioWorkletNode(ctx, 'pcm-chunker', {
    numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1],
    processorOptions: { inputRate: actualRate, outRate: wantRate, chunkSamples: s.ready.chunk_samples || 512 },
  });
  s.node.port.onmessage = (event) => {
    if (!isCurrent(s)) return;
    const data = event.data;
    if (data.type === 'level') { onLevel(data.rms); return; }
    if (data.type === 'chunk' && s.phase === 'capturing' && s.ws && s.ws.readyState === WebSocket.OPEN) {
      if (s.ws.bufferedAmount > MAX_BUFFERED_BYTES) {
        endSession(s, { error: `Stopped: the browser had ${s.ws.bufferedAmount} bytes (over 512 ms of audio) waiting to send. The link to the server is too slow to keep up in real time, so the page stopped instead of adding lag.` });
        return;
      }
      s.ws.send(data.buffer);
      s.chunksSent += 1;
      if (s.chunksSent % 10 === 0) el.chunks.textContent = `${s.chunksSent} × ${data.buffer.byteLength} bytes`;
    }
  };
  s.source.connect(s.node);
  s.node.connect(ctx.destination); // worklet output is silent; keeps the graph running
  if (ctx.state !== 'running') await ctx.resume();
  if (!isCurrent(s)) { teardownMic(s); return false; }
  return true;
}

// Idempotent: releases whatever the session has acquired so far.
function teardownMic(s) {
  try { s.node?.port.postMessage({ type: 'stop' }); } catch { /* ignore */ }
  try { s.source?.disconnect(); } catch { /* ignore */ }
  try { s.node?.disconnect(); } catch { /* ignore */ }
  stopTracks(s.stream);
  const ctx = s.ctx;
  s.ctx = null; s.node = null; s.source = null; s.stream = null;
  if (ctx && ctx.state !== 'closed') ctx.close().catch(() => {});
  if (s === session) resetMeter();
}

// Closes the socket in any state (including CONNECTING) and detaches its callbacks.
function closeSocket(s) {
  const ws = s.ws;
  s.ws = null;
  if (!ws) return;
  ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null;
  if (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN) {
    try { ws.close(); } catch { /* ignore */ }
  }
}

// ---- websocket ---------------------------------------------------------------
function openSocket(s) {
  const ws = new WebSocket(wsUrl('/ws/speech', { backend: backendUi.value }));
  ws.binaryType = 'arraybuffer';
  s.ws = ws;
  ws.onopen = () => { if (isCurrent(s)) setStatus(el.status, 'Connected to server. Waiting for Whisper…', 'warn'); };
  ws.onmessage = async (event) => {
    if (!isCurrent(s)) return;
    let msg;
    try { msg = JSON.parse(event.data); } catch { return; }
    switch (msg.type) {
      case 'connecting':
        setStatus(el.status, 'Server is connecting to Whisper…', 'warn');
        break;
      case 'ready':
        if (s.phase !== 'connecting') break;
        s.ready = msg;
        s.readyAt = performance.now();
        maxSessionS = msg.max_session_s || 600;
        el.model.textContent = `${msg.model_id || msg.model || '–'} via ${msg.backend || backendUi.value}`;
        el.connect.textContent = `${fmtMs(msg.connect_ms)} (server to speech backend, measured on server)`;
        s.phase = 'ready';
        setButtons();
        setStatus(el.status, 'Whisper ready. Starting microphone…', 'warn');
        try {
          const ok = await startMic(s);
          if (!ok || !isCurrent(s)) return; // session ended meanwhile; resources already released
          s.phase = 'capturing';
          setStatus(el.status, 'Listening. Speak; partial rows update live.', 'ok');
          setButtons();
        } catch (e) {
          if (!isCurrent(s)) return; // a stale failure must not tear down a newer session
          endSession(s, { error: describeMediaError(e, 'Microphone') });
        }
        break;
      case 'transcript':
        onTranscript(s, msg);
        break;
      case 'error':
        setError(el.error, `Server error: ${msg.message}`);
        break;
      default:
        break;
    }
  };
  ws.onerror = () => { if (isCurrent(s)) setError(el.error, 'WebSocket error. Is the server running?'); };
  ws.onclose = (event) => {
    if (s.ended) return;
    if (s.phase === 'stopping') { endSession(s, { status: 'Stopped.' }); return; }
    const detail = `Connection closed by server (code ${event.code}${event.reason ? ': ' + event.reason : ''}).`;
    endSession(s, { error: el.error.textContent ? null : detail, status: 'Stopped: connection closed.' });
  };
}

// ---- lifecycle ---------------------------------------------------------------
function start() {
  if (session || !capable) return;
  const s = newSession();
  session = s;
  setError(el.error, '');
  // Whisper numbers segments from 0 on every new connection, so the previous test's rows
  // would collide with the new ones. A new Start therefore clears the transcript.
  clearTranscript();
  resetGate();
  el.chunks.textContent = '0';
  el.connect.textContent = '–';
  el.buffered.textContent = '–';
  setButtons();
  setStatus(el.status, 'Connecting to server…', 'warn');
  s.elapsedTimer = setInterval(() => updateElapsed(s), 250);
  openSocket(s);
}

// User Stop. While capturing: mic off immediately, then 500 ms of paced zero PCM so the server
// VAD closes the utterance, then {type:"stop"}; the server sends the last final and closes.
// In any other phase: end immediately, closing even a still-CONNECTING socket.
function stop() {
  const s = session;
  if (!s || s.phase === 'stopping') return;
  if (s.phase !== 'capturing' || !s.ws || s.ws.readyState !== WebSocket.OPEN) {
    endSession(s, { status: 'Stopped.' });
    return;
  }
  s.phase = 'stopping';
  setButtons();
  teardownMic(s);
  setStatus(el.status, 'Microphone off. Flushing and waiting for the final transcript…', 'warn');
  const chunkSamples = s.ready?.chunk_samples || 512;
  const chunkMs = (chunkSamples / (s.ready?.sample_rate || 16000)) * 1000;
  const total = Math.ceil(500 / chunkMs);
  let sent = 0;
  const ws = s.ws;
  s.flushTimer = setInterval(() => {
    if (s.ended || ws.readyState !== WebSocket.OPEN) { clearInterval(s.flushTimer); return; }
    if (sent < total) { ws.send(new ArrayBuffer(chunkSamples * 2)); sent += 1; return; }
    clearInterval(s.flushTimer);
    ws.send(JSON.stringify({ type: 'stop' }));
    s.closeTimer = setTimeout(() => { if (!s.ended) endSession(s, { status: 'Stopped (server did not close in time).' }); }, CLOSE_GRACE_MS);
  }, chunkMs);
}

// Final teardown for a session: idempotent, releases media, closes the socket, frees Start.
function endSession(s, { error = null, status = null } = {}) {
  if (s.ended) return;
  s.ended = true;
  clearInterval(s.flushTimer);
  clearInterval(s.elapsedTimer);
  clearTimeout(s.closeTimer);
  teardownMic(s);
  closeSocket(s);
  if (session === s) {
    session = null;
    resetMeter();
    el.buffered.textContent = '–';
    if (error) { setError(el.error, error); setStatus(el.status, 'Stopped after an error. You can Start again.', 'err'); }
    else setStatus(el.status, status || 'Stopped.', status && status.startsWith('Stopped:') ? 'err' : '');
    setButtons();
  }
}

async function refreshDevices() {
  try {
    const result = await fillDeviceSelect(el.mic, 'audioinput', 'Microphone');
    if (result.unlabeled && !session) setStatus(el.status, 'Microphone names appear after you grant access with Start.', '');
  } catch (e) {
    setError(el.error, `Could not list devices: ${e.message}`);
  }
}

el.start.addEventListener('click', start);
el.stop.addEventListener('click', stop);
el.clear.addEventListener('click', clearTranscript);
el.refresh.addEventListener('click', refreshDevices);
// Switching microphones is a full stop; the user then clicks Start for the new device.
el.mic.addEventListener('change', () => {
  const s = session;
  if (!s) return;
  endSession(s, { status: 'Microphone changed; session stopped. Click Start to use the selected microphone.' });
});
navigator.mediaDevices?.addEventListener?.('devicechange', refreshDevices);

onPageLeave(() => { if (session) endSession(session, { status: 'Stopped.' }); });

if (!navigator.mediaDevices?.getUserMedia) {
  setError(el.error, 'This browser cannot access the microphone here. Use localhost or a trusted HTTPS address.');
} else if (!window.AudioWorklet) {
  setError(el.error, 'This browser does not support AudioWorklet, which this page needs.');
}
setButtons();
refreshDevices();
backendUi.refresh().then(setButtons);
