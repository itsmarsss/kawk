import {
  wsUrl, fmtMs, setStatus, setError, fillDeviceSelect, describeMediaError, onPageLeave, stopTracks, setupBackendSelector,
} from '/static/common.js';

const $ = (id) => document.getElementById(id);
const el = {
  camera: $('camera'), refresh: $('refresh'), start: $('start'), stop: $('stop'), status: $('status'), error: $('error'),
  stage: $('stage'), video: $('video'), overlay: $('overlay'), objects: $('objects'),
  request: $('request'), inference: $('inference'), roundtrip: $('roundtrip'), model: $('model'), load: $('load'),
  fps: $('fps'), size: $('size'), generation: $('generation'), tracking: $('tracking'), skipped: $('skipped'),
  backend: $('backend'), backendDetail: $('backend-detail'), recheck: $('recheck'),
  vocabulary: $('vocabulary'), vocabCount: $('vocab-count'),
};

const MAX_FPS = 10;
const MAX_SIDE = 1280;
const JPEG_QUALITY = 0.7;
const MAX_VOCAB = 20;
const READY_TIMEOUT_MS = 15000;  // model init may take this long
const DEFAULT_RESPONSE_TIMEOUT_MS = 5000; // used until ready.response_timeout_ms arrives
const MIN_RESPONSE_TIMEOUT_MS = 5000;
const MAX_RESPONSE_TIMEOUT_MS = 15000;

// Per-session frame reply timeout: ready.response_timeout_ms clamped to [5 s, 15 s].
function responseTimeoutMs(s) {
  const raw = Number(s.ready?.response_timeout_ms);
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_RESPONSE_TIMEOUT_MS;
  return Math.min(MAX_RESPONSE_TIMEOUT_MS, Math.max(MIN_RESPONSE_TIMEOUT_MS, Math.round(raw)));
}
const capable = Boolean(navigator.mediaDevices?.getUserMedia);

const capture = document.createElement('canvas');
const captureCtx = capture.getContext('2d', { alpha: false });
const overlayCtx = el.overlay.getContext('2d');

// ---- session (same guards as faces.js) ----------------------------------------
let session = null;
let sessionSeq = 0;

function newSession() {
  return {
    id: ++sessionSeq, phase: 'starting', ended: false, ws: null, stream: null, ready: null,
    inFlight: false, frameId: 0, captureAt: 0, sentAt: 0, lastSendAt: 0,
    loopTimer: null, responseTimer: null, readyTimer: null, replyTimes: [], busyCount: 0,
  };
}
const isCurrent = (s) => s !== null && s === session && !s.ended;

// ---- vocabulary ---------------------------------------------------------------
function parseVocabulary() {
  const seen = new Set();
  const words = [];
  for (const raw of el.vocabulary.value.split(',')) {
    const word = raw.trim().replace(/\s+/g, ' ');
    if (word && !seen.has(word.toLowerCase())) { seen.add(word.toLowerCase()); words.push(word); }
  }
  return words;
}

function updateVocabCount() {
  const words = parseVocabulary();
  el.vocabCount.textContent = words.length > MAX_VOCAB
    ? `${words.length} terms; only ${MAX_VOCAB} allowed.`
    : `${words.length} term${words.length === 1 ? '' : 's'}.`;
  el.vocabCount.className = words.length > MAX_VOCAB || words.length === 0 ? 'error-text' : '';
  return words;
}

// ---- backend ------------------------------------------------------------------
const backendUi = setupBackendSelector({
  select: el.backend, detail: el.backendDetail, recheck: el.recheck, kind: 'objects', defaultBackend: 'local',
  onChange: (value, reason) => {
    if (reason !== 'refreshed') {
      if (session) endSession(session, { status: 'Backend changed; session stopped. Click Start to use the selected backend.' });
      clearResults();
    }
    setButtons();
  },
});

function clearResults() {
  overlayCtx.clearRect(0, 0, el.overlay.width, el.overlay.height);
  el.objects.replaceChildren(Object.assign(document.createElement('li'), { className: 'muted', textContent: 'Nothing yet.' }));
  for (const key of ['request', 'inference', 'roundtrip', 'model', 'load', 'fps', 'size', 'generation', 'skipped']) el[key].textContent = '–';
  el.tracking.textContent = '';
}

function setButtons() {
  const s = session;
  const words = parseVocabulary();
  el.start.disabled = !capable || s !== null || !backendUi.configured || words.length === 0 || words.length > MAX_VOCAB;
  el.stop.disabled = s === null;
  el.backend.disabled = s !== null;
  el.vocabulary.disabled = s !== null;
}

// ---- camera --------------------------------------------------------------------
async function startCamera(s) {
  const deviceId = el.camera.value;
  const video = { width: { ideal: 1280 }, height: { ideal: 720 }, ...(deviceId ? { deviceId: { exact: deviceId } } : {}) };
  const stream = await navigator.mediaDevices.getUserMedia({ video, audio: false });
  s.stream = stream;
  if (!isCurrent(s)) { releaseCamera(s); return false; }
  el.video.srcObject = stream;
  await refreshDevices();
  if (!isCurrent(s)) { releaseCamera(s); return false; }
  const track = stream.getVideoTracks()[0];
  const settings = track?.getSettings?.();
  if (settings?.deviceId) el.camera.value = settings.deviceId;
  track?.addEventListener('ended', () => {
    if (isCurrent(s)) endSession(s, { error: 'Camera disconnected (track ended). Click Refresh devices, choose another camera, and Start again.' });
  });
  await new Promise((resolve, reject) => {
    if (el.video.readyState >= 2) return resolve();
    el.video.onloadedmetadata = () => resolve();
    el.video.onerror = () => reject(new Error('Video element failed to load the camera stream'));
  });
  if (!isCurrent(s)) { releaseCamera(s); return false; }
  try { await el.video.play(); } catch { /* muted autoplay; ignore */ }
  if (!isCurrent(s)) { releaseCamera(s); return false; }
  el.stage.classList.remove('idle');
  return true;
}

function releaseCamera(s) {
  const stream = s.stream;
  s.stream = null;
  stopTracks(stream);
  if (stream && el.video.srcObject === stream) el.video.srcObject = null;
}

// ---- frame loop ------------------------------------------------------------------
function scheduleLoop(s) {
  if (!isCurrent(s)) return;
  clearTimeout(s.loopTimer);
  const wait = Math.max(0, s.lastSendAt + 1000 / MAX_FPS - performance.now());
  s.loopTimer = setTimeout(() => tick(s), wait);
}

function tick(s) {
  if (!isCurrent(s) || s.phase !== 'running' || !s.ws || s.ws.readyState !== WebSocket.OPEN) return;
  if (s.inFlight || el.video.readyState < 2 || !el.video.videoWidth) { s.loopTimer = setTimeout(() => tick(s), 20); return; }
  const vw = el.video.videoWidth, vh = el.video.videoHeight;
  const scale = Math.min(1, MAX_SIDE / Math.max(vw, vh));
  const w = Math.max(1, Math.round(vw * scale)), h = Math.max(1, Math.round(vh * scale));
  if (capture.width !== w || capture.height !== h) { capture.width = w; capture.height = h; }
  s.inFlight = true;
  s.lastSendAt = performance.now();
  s.captureAt = s.lastSendAt;
  captureCtx.drawImage(el.video, 0, 0, w, h);
  capture.toBlob((blob) => {
    if (!isCurrent(s)) return;
    if (!blob || !s.ws || s.ws.readyState !== WebSocket.OPEN) { s.inFlight = false; scheduleLoop(s); return; }
    blob.arrayBuffer().then((buffer) => {
      if (!isCurrent(s)) return;
      if (!s.ws || s.ws.readyState !== WebSocket.OPEN) { s.inFlight = false; return; }
      s.frameId += 1;
      s.sentAt = performance.now();
      s.ws.send(buffer);
      el.size.textContent = `${w}×${h}, ${(buffer.byteLength / 1024).toFixed(0)} KB`;
      clearTimeout(s.responseTimer);
      const timeoutMs = responseTimeoutMs(s);
      s.responseTimer = setTimeout(() => {
        if (!isCurrent(s) || !s.inFlight) return;
        endSession(s, { error: `No reply from the server within ${timeoutMs / 1000} s for a frame. The ${backendUi.label} backend may be stalled or the connection lost. Click Recheck status, then Start again; try the other backend if it keeps happening.` });
      }, timeoutMs);
    });
  }, 'image/jpeg', JPEG_QUALITY);
}

function releaseSlot(s) {
  clearTimeout(s.responseTimer);
  s.responseTimer = null;
  s.inFlight = false;
}

function onFrame(s, msg) {
  const now = performance.now();
  const late = !s.inFlight;
  releaseSlot(s);
  s.replyTimes.push(now);
  while (s.replyTimes.length && now - s.replyTimes[0] > 2000) s.replyTimes.shift();
  el.fps.textContent = s.replyTimes.length > 1 ? `${((s.replyTimes.length - 1) / ((now - s.replyTimes[0]) / 1000)).toFixed(1)} /s` : '–';
  const t = msg.timings_ms || {};
  el.request.textContent = fmtMs(t.request);
  el.inference.textContent = t.inference === undefined ? 'n/a' : fmtMs(t.inference);
  el.roundtrip.textContent = late ? 'n/a (late reply)' : `${fmtMs(now - s.sentAt)} send → reply (${fmtMs(now - s.captureAt)} incl. capture + JPEG encode)`;
  if (msg.session_generation !== undefined) el.generation.textContent = String(msg.session_generation);
  drawOverlay(msg);
  listObjects(msg);
  scheduleLoop(s);
}

// Colour per track id, from a small fixed set. Boxes are absolute in the sent frame; the overlay
// canvas takes the frame's size and CSS stretches it over the video (same aspect ratio).
const COLOURS = ['#2ecc71', '#f1c40f', '#3498db', '#e67e22', '#9b59b6', '#1abc9c', '#e74c3c', '#95a5a6'];
function drawOverlay(msg) {
  const [w, h] = msg.input_wh || [capture.width, capture.height];
  if (el.overlay.width !== w || el.overlay.height !== h) { el.overlay.width = w; el.overlay.height = h; }
  const c = overlayCtx;
  c.clearRect(0, 0, w, h);
  c.lineWidth = Math.max(2, Math.round(w / 400));
  c.font = `${Math.max(12, Math.round(w / 45))}px -apple-system, Helvetica, Arial, sans-serif`;
  c.textBaseline = 'top';
  for (const obj of msg.objects || []) {
    const [x1, y1, x2, y2] = obj.box_xyxy;
    const colour = COLOURS[Math.abs(Number(obj.track_id) || 0) % COLOURS.length];
    c.strokeStyle = colour;
    c.strokeRect(x1, y1, x2 - x1, y2 - y1);
    const label = `${obj.label} #${obj.track_id} ${obj.score !== undefined ? obj.score.toFixed(2) : ''}`.trim();
    const pad = 3;
    const lh = parseInt(c.font, 10) + pad * 2;
    const ly = y1 - lh >= 0 ? y1 - lh : y2;
    c.fillStyle = 'rgba(0,0,0,0.65)';
    c.fillRect(x1, ly, c.measureText(label).width + pad * 2, lh);
    c.fillStyle = '#fff';
    c.fillText(label, x1 + pad, ly + pad);
  }
}

function listObjects(msg) {
  const objects = msg.objects || [];
  if (!objects.length) {
    el.objects.replaceChildren(Object.assign(document.createElement('li'), { className: 'muted', textContent: 'No objects from the vocabulary in view.' }));
    return;
  }
  el.objects.replaceChildren(...objects.map((obj) => {
    const li = document.createElement('li');
    const main = document.createElement('span'); main.className = 'grow';
    main.textContent = `${obj.label} (track ${obj.track_id})`;
    const detail = document.createElement('span'); detail.className = 'small muted';
    const [x1, y1, x2, y2] = obj.box_xyxy;
    detail.textContent = `score ${obj.score !== undefined ? obj.score.toFixed(2) : 'n/a'}; box ${Math.round(x2 - x1)}×${Math.round(y2 - y1)} px`;
    li.append(main, detail);
    return li;
  }));
}

// ---- websocket ----------------------------------------------------------------------
function closeSocket(s) {
  const ws = s.ws;
  s.ws = null;
  if (!ws) return;
  ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null;
  if (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN) {
    try { ws.close(); } catch { /* ignore */ }
  }
}

function openSocket(s, words) {
  const ws = new WebSocket(wsUrl('/ws/objects', { backend: backendUi.value, vocabulary: words.join(',') }));
  ws.binaryType = 'arraybuffer';
  s.ws = ws;
  s.readyTimer = setTimeout(() => {
    if (isCurrent(s) && s.phase === 'starting') {
      endSession(s, { error: `The ${backendUi.label} backend did not become ready within ${READY_TIMEOUT_MS / 1000} s. Click Recheck status and Start again, or try the other backend.` });
    }
  }, READY_TIMEOUT_MS);
  ws.onopen = () => { if (isCurrent(s)) setStatus(el.status, 'Connected. Waiting for the object model…', 'warn'); };
  ws.onmessage = (event) => {
    if (!isCurrent(s)) return;
    let msg;
    try { msg = JSON.parse(event.data); } catch { return; }
    switch (msg.type) {
      case 'loading':
        setStatus(el.status, `Loading ${backendUi.label}… (up to ${READY_TIMEOUT_MS / 1000} s)`, 'warn');
        break;
      case 'ready': {
        clearTimeout(s.readyTimer);
        s.ready = msg;
        el.model.textContent = `${msg.model || '–'} via ${msg.backend || backendUi.value}`;
        el.load.textContent = fmtMs(msg.load_ms);
        const windowed = msg.tracking_persistent === false;
        el.tracking.textContent = windowed
          ? `Windowed mode: ${msg.model || 'this backend'} re-initializes on each window, so track IDs reset and this is not a continuous tracker. Judge it by the measured update speed below, not by ID stability.`
          : '';
        el.skipped.textContent = '0';
        if (s.phase === 'starting') {
          s.phase = 'running';
          setStatus(el.status, `Running ${msg.model || ''} via ${msg.backend || backendUi.value}. Up to ${MAX_FPS} frames per second; frame reply timeout ${responseTimeoutMs(s) / 1000} s.`, 'ok');
          setButtons();
          s.lastSendAt = 0;
          scheduleLoop(s);
        }
        break;
      }
      case 'frame': onFrame(s, msg); break;
      case 'busy':
        // Server skipped this frame. Keep the last boxes and list on screen: a skip is not an absence.
        s.busyCount += 1;
        el.skipped.textContent = String(s.busyCount);
        releaseSlot(s);
        scheduleLoop(s);
        break;
      case 'error':
        setError(el.error, `Server error: ${msg.message}`);
        releaseSlot(s);
        if (s.phase === 'running') scheduleLoop(s);
        break;
      default: break;
    }
  };
  ws.onerror = () => { if (isCurrent(s)) setError(el.error, 'WebSocket error. Is the server running?'); };
  ws.onclose = (event) => {
    if (s.ended) return;
    const detail = `Connection closed by server (code ${event.code}${event.reason ? ': ' + event.reason : ''}).`;
    endSession(s, { error: el.error.textContent ? null : detail, status: 'Stopped: connection closed.' });
  };
}

// ---- lifecycle ---------------------------------------------------------------------
async function start() {
  if (session || !capable) return;
  const words = updateVocabCount();
  if (words.length === 0 || words.length > MAX_VOCAB) { setError(el.error, `Enter 1 to ${MAX_VOCAB} comma-separated terms.`); return; }
  const s = newSession();
  session = s;
  setError(el.error, '');
  clearResults();
  setButtons();
  try {
    setStatus(el.status, 'Requesting camera…', 'warn');
    const ok = await startCamera(s);
    if (!ok || !isCurrent(s)) return;
    setStatus(el.status, 'Camera on. Connecting to server…', 'warn');
    openSocket(s, words);
  } catch (e) {
    if (!isCurrent(s)) return;
    endSession(s, { error: describeMediaError(e, 'Camera') });
  }
}

function endSession(s, { error = null, status = null } = {}) {
  if (s.ended) return;
  s.ended = true;
  clearTimeout(s.loopTimer);
  clearTimeout(s.responseTimer);
  clearTimeout(s.readyTimer);
  s.inFlight = false;
  closeSocket(s);
  releaseCamera(s);
  if (session === s) {
    session = null;
    el.video.srcObject = null;
    overlayCtx.clearRect(0, 0, el.overlay.width, el.overlay.height);
    el.stage.classList.add('idle');
    el.fps.textContent = '–';
    if (error) { setError(el.error, error); setStatus(el.status, 'Stopped after an error. You can Start again.', 'err'); }
    else setStatus(el.status, status || 'Stopped.', status && status.startsWith('Stopped:') ? 'err' : '');
    setButtons();
  }
}

async function refreshDevices() {
  try {
    const result = await fillDeviceSelect(el.camera, 'videoinput', 'Camera');
    if (result.unlabeled && !session) setStatus(el.status, 'Camera names appear after you grant access with Start.', '');
  } catch (e) {
    setError(el.error, `Could not list devices: ${e.message}`);
  }
}

el.start.addEventListener('click', start);
el.stop.addEventListener('click', () => { if (session) endSession(session, { status: 'Stopped.' }); });
el.refresh.addEventListener('click', refreshDevices);
el.vocabulary.addEventListener('input', () => { updateVocabCount(); setButtons(); });
el.camera.addEventListener('change', () => {
  if (session) endSession(session, { status: 'Camera changed; session stopped. Click Start to use the selected camera.' });
});
navigator.mediaDevices?.addEventListener?.('devicechange', refreshDevices);
onPageLeave(() => { if (session) endSession(session, { status: 'Stopped.' }); });

if (!capable) setError(el.error, 'This browser cannot access the camera here. Use localhost or a trusted HTTPS address.');
updateVocabCount();
setButtons();
refreshDevices();
backendUi.refresh().then(setButtons);
