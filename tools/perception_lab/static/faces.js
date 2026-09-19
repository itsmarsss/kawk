import {
  fetchJson, wsUrl, fmtMs, setStatus, setError, fillDeviceSelect, describeMediaError, onPageLeave, stopTracks, setupBackendSelector,
} from '/static/common.js';

const $ = (id) => document.getElementById(id);
const el = {
  camera: $('camera'), refresh: $('refresh'), start: $('start'), stop: $('stop'), status: $('status'), error: $('error'),
  stage: $('stage'), video: $('video'), overlay: $('overlay'), hint: $('hint'), faces: $('faces'),
  model: $('model'), load: $('load'), inference: $('inference'), breakdown: $('breakdown'), roundtrip: $('roundtrip'),
  fps: $('fps'), size: $('size'), name: $('name'), enroll: $('enroll'), cancel: $('cancel'), enrollStatus: $('enroll-status'),
  gallery: $('gallery'), galleryError: $('gallery-error'),
  backend: $('backend'), backendDetail: $('backend-detail'), recheck: $('recheck'), skipped: $('skipped'),
};

const RESPONSE_TIMEOUT_MS = 5000; // no reply in this time ends the session (at most one in flight per socket)
const capable = Boolean(navigator.mediaDevices?.getUserMedia);

const capture = document.createElement('canvas');
const captureCtx = capture.getContext('2d', { alpha: false });
const overlayCtx = el.overlay.getContext('2d');

// ---- session -----------------------------------------------------------------
// One session at a time. Every awaited step re-checks `s.ended` so a Stop during getUserMedia
// cannot leave a live camera track, and pending JPEG callbacks are scoped to their session.
let session = null;
let sessionSeq = 0;

function newSession() {
  return {
    id: ++sessionSeq, phase: 'starting', ended: false, ws: null, stream: null, ready: null,
    inFlight: false, frameId: 0, captureAt: 0, sentAt: 0, lastSendAt: 0,
    loopTimer: null, responseTimer: null, replyTimes: [], enrolling: false, skipped: 0,
  };
}
const isCurrent = (s) => s !== null && s === session && !s.ended;

// Backend choice. Changing it stops any session and clears results; Start is required again.
const backendUi = setupBackendSelector({
  select: el.backend, detail: el.backendDetail, recheck: el.recheck, kind: 'face', defaultBackend: 'local',
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
  el.faces.replaceChildren(Object.assign(document.createElement('li'), { className: 'muted', textContent: 'Nothing yet.' }));
  for (const key of ['model', 'load', 'inference', 'breakdown', 'roundtrip', 'fps', 'size', 'skipped']) el[key].textContent = '–';
  setStatus(el.hint, '', '');
}

function setButtons() {
  const s = session;
  const running = s !== null && s.phase === 'running';
  el.start.disabled = !capable || s !== null || !backendUi.configured;
  el.backend.disabled = s !== null;
  el.stop.disabled = s === null;
  el.enroll.disabled = !running || s.enrolling;
  el.cancel.disabled = !running || !s.enrolling;
  el.name.disabled = running && s.enrolling;
}

// ---- gallery -------------------------------------------------------------------
async function loadGallery() {
  try {
    const data = await fetchJson('/api/gallery');
    setError(el.galleryError, '');
    if (!data.people.length) {
      el.gallery.replaceChildren(Object.assign(document.createElement('li'), { className: 'muted', textContent: 'No one enrolled yet.' }));
      return;
    }
    el.gallery.replaceChildren(...data.people.map((person) => {
      const li = document.createElement('li');
      const name = document.createElement('span'); name.className = 'grow'; name.textContent = person.name;
      const button = document.createElement('button'); button.type = 'button'; button.textContent = 'Delete';
      button.setAttribute('aria-label', `Delete ${person.name}`);
      button.addEventListener('click', async () => {
        button.disabled = true;
        try {
          await fetchJson(`/api/gallery/${encodeURIComponent(person.id)}`, { method: 'DELETE' });
          await loadGallery();
        } catch (e) { setError(el.galleryError, e.message); button.disabled = false; }
      });
      li.append(name, button);
      return li;
    }));
  } catch (e) {
    setError(el.galleryError, `Could not load gallery: ${e.message}`);
  }
}

// ---- camera --------------------------------------------------------------------
// Returns false if the session ended while a step was pending (the track is stopped again).
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
  const interval = 1000 / (s.ready?.max_fps || 5);
  const wait = Math.max(0, s.lastSendAt + interval - performance.now());
  s.loopTimer = setTimeout(() => tick(s), wait);
}

function tick(s) {
  if (!isCurrent(s) || s.phase !== 'running' || !s.ws || s.ws.readyState !== WebSocket.OPEN) return;
  if (s.inFlight || el.video.readyState < 2 || !el.video.videoWidth) { s.loopTimer = setTimeout(() => tick(s), 20); return; }
  const maxSide = Math.min(640, s.ready?.max_side || 640);
  const vw = el.video.videoWidth, vh = el.video.videoHeight;
  const scale = Math.min(1, maxSide / Math.max(vw, vh));
  const w = Math.max(1, Math.round(vw * scale)), h = Math.max(1, Math.round(vh * scale));
  if (capture.width !== w || capture.height !== h) { capture.width = w; capture.height = h; }
  s.inFlight = true;
  s.lastSendAt = performance.now();
  s.captureAt = s.lastSendAt; // before drawImage + JPEG encode
  captureCtx.drawImage(el.video, 0, 0, w, h);
  capture.toBlob((blob) => {
    if (!isCurrent(s)) return; // stale callback from an ended session
    if (!blob || !s.ws || s.ws.readyState !== WebSocket.OPEN) { s.inFlight = false; scheduleLoop(s); return; }
    blob.arrayBuffer().then((buffer) => {
      if (!isCurrent(s)) return;
      if (!s.ws || s.ws.readyState !== WebSocket.OPEN) { s.inFlight = false; return; }
      s.frameId += 1;
      s.sentAt = performance.now();
      s.ws.send(buffer);
      el.size.textContent = `${w}×${h}, ${(buffer.byteLength / 1024).toFixed(0)} KB`;
      clearTimeout(s.responseTimer);
      // At most one request in flight per socket. If the reply never comes we must not send
      // another frame on the same socket (a late first reply would be attributed to the second
      // request and show a wrong latency), so the session ends and the user reconnects with Start.
      s.responseTimer = setTimeout(() => {
        if (!isCurrent(s) || !s.inFlight) return;
        endSession(s, { error: `No face reply within ${RESPONSE_TIMEOUT_MS / 1000} seconds. Start again to reconnect.` });
      }, RESPONSE_TIMEOUT_MS);
    });
  }, 'image/jpeg', 0.8);
}

function releaseSlot(s) {
  clearTimeout(s.responseTimer);
  s.responseTimer = null;
  s.inFlight = false;
}

function onFrame(s, msg) {
  if (!isCurrent(s) || !s.inFlight) return; // no request outstanding: ignore rather than mis-attribute latency
  const now = performance.now();
  releaseSlot(s);
  s.replyTimes.push(now);
  while (s.replyTimes.length && now - s.replyTimes[0] > 2000) s.replyTimes.shift();
  el.fps.textContent = s.replyTimes.length > 1 ? `${((s.replyTimes.length - 1) / ((now - s.replyTimes[0]) / 1000)).toFixed(1)} /s` : '–';
  const t = msg.timings_ms || {};
  el.inference.textContent = fmtMs(t.inference);
  el.breakdown.textContent = `decode ${fmtMs(t.decode)}, detection ${fmtMs(t.detection)}, embedding+alignment ${fmtMs(t.embedding_and_alignment)}, server total ${fmtMs(t.server_total)}`;
  el.roundtrip.textContent = `${fmtMs(now - s.sentAt)} send → reply (${fmtMs(now - s.captureAt)} incl. capture + JPEG encode)`;
  drawOverlay(msg);
  listFaces(msg);
  if (msg.detected_count > msg.accepted_count) {
    setStatus(el.hint, `${msg.detected_count - msg.accepted_count} face(s) too small (under 80 px). Move closer to the camera.`, 'warn');
  } else if (msg.detected_count === 0) {
    setStatus(el.hint, 'No face detected.', '');
  } else {
    setStatus(el.hint, '', '');
  }
  if (msg.enrollment) onEnrollment(s, msg.enrollment);
  scheduleLoop(s);
}

function drawOverlay(msg) {
  const [w, h] = msg.input_wh || [capture.width, capture.height];
  // The overlay uses the sent frame's pixel size; CSS stretches it over the video, which has the same aspect ratio.
  if (el.overlay.width !== w || el.overlay.height !== h) { el.overlay.width = w; el.overlay.height = h; }
  const c = overlayCtx;
  c.clearRect(0, 0, w, h);
  c.lineWidth = 2;
  c.font = `${Math.max(12, Math.round(w / 40))}px -apple-system, Helvetica, Arial, sans-serif`;
  c.textBaseline = 'top';
  for (const face of msg.faces || []) {
    const [x1, y1, x2, y2] = face.box;
    const known = Boolean(face.stable_name);
    c.strokeStyle = known ? '#2ecc71' : '#f1c40f';
    c.strokeRect(x1, y1, x2 - x1, y2 - y1);
    const label = known ? face.stable_name : 'Unknown';
    const pad = 3;
    const metrics = c.measureText(label);
    const lh = parseInt(c.font, 10) + pad * 2;
    const ly = y1 - lh >= 0 ? y1 - lh : y2;
    c.fillStyle = 'rgba(0,0,0,0.65)';
    c.fillRect(x1, ly, metrics.width + pad * 2, lh);
    c.fillStyle = '#fff';
    c.fillText(label, x1 + pad, ly + pad);
  }
}

function listFaces(msg) {
  const faces = msg.faces || [];
  if (!faces.length) {
    el.faces.replaceChildren(Object.assign(document.createElement('li'), { className: 'muted', textContent: msg.detected_count ? 'Faces detected but none accepted (too small).' : 'No faces.' }));
    return;
  }
  el.faces.replaceChildren(...faces.map((face) => {
    const li = document.createElement('li');
    const main = document.createElement('span'); main.className = 'grow';
    main.textContent = `Track ${face.track_id}: ${face.stable_name || 'Unknown'}`;
    const detail = document.createElement('span'); detail.className = 'small muted';
    const m = face.match || {};
    const raw = m.name ? `raw match ${m.name} (${m.similarity.toFixed(2)})` : (m.similarity != null ? `best similarity ${m.similarity.toFixed(2)}, below threshold` : 'gallery empty');
    detail.textContent = `${raw}; detection ${face.detection_score.toFixed(2)}${face.stable_name ? '' : '; stable name needs 2 agreeing matches in the last 3 frames'}`;
    li.append(main, detail);
    return li;
  }));
}

// ---- enrollment ------------------------------------------------------------------
function onEnrollment(s, e) {
  if (e.status === 'collecting') {
    s.enrolling = true;
    setStatus(el.enrollStatus, `Enrolling ${e.name}: ${e.collected} of ${e.required} frames.${e.message ? ' ' + e.message : ''}`, 'warn');
  } else if (e.status === 'complete') {
    s.enrolling = false;
    setStatus(el.enrollStatus, `Enrolled ${e.person?.name || e.name}.`, 'ok');
    el.name.value = '';
    loadGallery();
  } else if (e.status === 'error') {
    s.enrolling = false;
    setStatus(el.enrollStatus, `Enrollment failed: ${e.message || 'unknown error'}`, 'err');
  }
  setButtons();
}

function enroll() {
  const s = session;
  if (!s || s.phase !== 'running' || !s.ws || s.ws.readyState !== WebSocket.OPEN) return;
  const name = el.name.value.trim();
  if (!name) { setStatus(el.enrollStatus, 'Enter a name first.', 'err'); el.name.focus(); return; }
  s.ws.send(JSON.stringify({ type: 'enroll', name }));
  s.enrolling = true;
  setStatus(el.enrollStatus, `Requesting enrollment for ${name}…`, 'warn');
  setButtons();
}

function cancelEnrollment() {
  const s = session;
  if (s && s.ws && s.ws.readyState === WebSocket.OPEN) s.ws.send(JSON.stringify({ type: 'cancel_enrollment' }));
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

function openSocket(s) {
  const ws = new WebSocket(wsUrl('/ws/faces', { backend: backendUi.value }));
  ws.binaryType = 'arraybuffer';
  s.ws = ws;
  ws.onopen = () => { if (isCurrent(s)) setStatus(el.status, 'Connected. Waiting for the face model…', 'warn'); };
  ws.onmessage = (event) => {
    if (!isCurrent(s)) return;
    let msg;
    try { msg = JSON.parse(event.data); } catch { return; }
    switch (msg.type) {
      case 'ready':
        s.ready = msg;
        el.model.textContent = `${msg.model || '–'} via ${msg.backend || backendUi.value}${msg.provider ? ` (${msg.provider})` : ''}`;
        el.load.textContent = fmtMs(msg.load_ms);
        if (s.phase === 'starting') {
          s.phase = 'running';
          setStatus(el.status, `Running. Sending up to ${msg.max_fps} frames per second.`, 'ok');
          setButtons();
          s.lastSendAt = 0;
          scheduleLoop(s);
        }
        break;
      case 'frame': onFrame(s, msg); break;
      case 'busy':
        // The server skipped this frame (worker busy, or the cloud face request timed out). Free the
        // slot, keep the last boxes on screen, count it, and continue with the latest frame.
        s.skipped += 1;
        el.skipped.textContent = String(s.skipped);
        if (msg.reason === 'cloud_timeout') setStatus(el.hint, 'Cloud frame timed out; trying the latest frame.', 'warn');
        releaseSlot(s);
        scheduleLoop(s);
        break;
      case 'enrollment_started':
        s.enrolling = true;
        setStatus(el.enrollStatus, `Enrolling ${msg.name}: 0 of 5 frames. Look at the camera.`, 'warn');
        setButtons();
        break;
      case 'enrollment_cancelled':
        s.enrolling = false;
        setStatus(el.enrollStatus, 'Enrollment cancelled.', '');
        setButtons();
        break;
      case 'error':
        setError(el.error, `Server error: ${msg.message}`);
        if (s.enrolling) { s.enrolling = false; setStatus(el.enrollStatus, `Enrollment stopped: ${msg.message}`, 'err'); setButtons(); }
        // A non-fatal error may leave the current request unanswered; free the slot and continue.
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
  const s = newSession();
  session = s;
  setError(el.error, '');
  clearResults(); // per-session metrics (incl. frames skipped) start fresh
  setStatus(el.enrollStatus, '', '');
  setButtons();
  try {
    setStatus(el.status, 'Requesting camera…', 'warn');
    const ok = await startCamera(s); // acquire first so device labels are available and the preview shows
    if (!ok || !isCurrent(s)) return; // Stop was clicked meanwhile; camera already released
    setStatus(el.status, 'Camera on. Connecting to server…', 'warn');
    openSocket(s);
  } catch (e) {
    if (!isCurrent(s)) return; // stale failure must not touch a newer session
    endSession(s, { error: describeMediaError(e, 'Camera') });
  }
}

// Final teardown: idempotent, releases camera, closes the socket (even CONNECTING), frees Start.
function endSession(s, { error = null, status = null } = {}) {
  if (s.ended) return;
  s.ended = true;
  clearTimeout(s.loopTimer);
  clearTimeout(s.responseTimer);
  s.inFlight = false;
  s.enrolling = false;
  closeSocket(s);
  releaseCamera(s);
  if (session === s) {
    session = null;
    el.video.srcObject = null;
    overlayCtx.clearRect(0, 0, el.overlay.width, el.overlay.height);
    el.stage.classList.add('idle');
    el.fps.textContent = '–';
    setStatus(el.enrollStatus, '', '');
    setStatus(el.hint, '', '');
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
el.enroll.addEventListener('click', enroll);
el.cancel.addEventListener('click', cancelEnrollment);
el.name.addEventListener('keydown', (event) => { if (event.key === 'Enter' && !el.enroll.disabled) enroll(); });
// Switching cameras is a full stop; the user then clicks Start for the new device.
el.camera.addEventListener('change', () => {
  if (session) endSession(session, { status: 'Camera changed; session stopped. Click Start to use the selected camera.' });
});
navigator.mediaDevices?.addEventListener?.('devicechange', refreshDevices);
onPageLeave(() => { if (session) endSession(session, { status: 'Stopped.' }); });

if (!capable) setError(el.error, 'This browser cannot access the camera here. Use localhost or a trusted HTTPS address.');
setButtons();
refreshDevices();
loadGallery();
backendUi.refresh().then(setButtons);
