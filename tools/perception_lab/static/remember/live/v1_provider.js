// Live V1 provider: the browser side of tools/perception_lab/product_routes.py.
//
// It owns the temporary session (POST/GET/DELETE /api/v1/sessions), the control WebSocket
// (/ws/v1/{id}: hello → commands/acks/errors/control, perception forwarding, media ring), and
// the capture lifecycle (one camera/mic acquisition fanned out to the existing /ws/faces,
// /ws/objects, /ws/speech streams plus the clip buffer). It makes NO product decisions: every
// state change arrives as a versioned envelope from the server and goes through the same store.
// There is no agent or durable memory behind it; the server's small V1 rule grammar is labelled as such.
import { SCHEMA_VERSION } from '../contracts/envelope.js';
import { createEmitter } from '../providers/provider.js';

export const SESSION_KEY = 'remember.ui.v1.live.session';
export const MEDIA_JPEG = 0x01;
export const MEDIA_PCM = 0x02;
const PING_MS = 20_000;
const FRAME_INTERVAL_MS = 200;        // 5 fps into the clip ring (server bound)
const FRAME_ACK_TIMEOUT_MS = 2_000;   // free the one-in-flight slot if no frame_ack arrives
const MAX_CONTROL_BACKLOG = 64 * 1024;
const RECONNECT_MS = [500, 1000, 2000, 5000, 10000];

/** Eight-byte little-endian header (AGENTS §5): u8 type, u8 flags, u16 seq, u32 capture ts ms. */
export function encodeMedia(type, seq, captureTsMs, payload) {
  const out = new Uint8Array(8 + payload.byteLength);
  const view = new DataView(out.buffer);
  view.setUint8(0, type);
  view.setUint8(1, 0);
  view.setUint16(2, seq & 0xffff, true);
  view.setUint32(4, Math.floor(captureTsMs) % 2 ** 32 >>> 0, true);
  out.set(new Uint8Array(payload), 8);
  return out.buffer;
}

const defaultClock = {
  nowMs: () => Math.floor(performance.now()),
  now: () => Date.now(),
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (id) => globalThis.clearTimeout(id),
};

/**
 * @param {{ getState: () => any, capture: any, streams: {faces: Function, objects: Function, speech: Function},
 *   deps?: {fetchImpl?, WebSocketImpl?, clock?, sessionStorage?, location?} }} opts
 */
export function createV1Provider({ getState, capture, streams, deps = {} }) {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch?.bind(globalThis);
  const WS = deps.WebSocketImpl ?? globalThis.WebSocket;
  const clock = deps.clock ?? defaultClock;
  const storage = deps.sessionStorage ?? safeSessionStorage();
  const loc = deps.location ?? globalThis.location;
  const emitter = createEmitter();
  const notices = createEmitter();
  const statusListeners = createEmitter();
  const snapshots = createEmitter();   // authoritative snapshot delivered with each hello ack (reconnects drop queued envelopes)

  let sessionId = storage?.getItem(SESSION_KEY) || null;
  let limits = { jpeg_max_bytes: 256 * 1024, clip_fps: 5, audio_sample_rate: 16000 };
  let websocketUrl = null;
  let ws = null;
  let wsGen = 0;
  let wanted = false;              // control connection desired
  let reconnectAttempt = 0;
  let reconnectTimer = null;
  let pingTimer = null;
  let helloAcked = false;
  let decision = null;             // last v1.decision_status for the CURRENT socket; runtime state, never stored
  let requestSeq = 0;
  const pending = new Map();      // request_id → {resolve, reject, timer}

  // capture + media
  let capturing = false;
  let starting = false;
  let captureGen = 0;              // bumped by every stop/cancel; a pending start that sees a newer gen aborts
  let settings = null;
  let frameSeq = 0;
  let audioSeq = 0;
  let frameInFlight = null;        // {seq, timer}
  let frameTimer = null;
  let jpegQuality = 0.8;
  let unsubChunk = null;
  const live = {
    session: 'disconnected', sessionMessage: '',
    streams: { faces: { phase: 'idle' }, objects: { phase: 'idle' }, speech: { phase: 'idle' } },
    media: { frames_sent: 0, frames_dropped: 0, frames_rejected: 0, audio_chunks: 0, last_error: null },
    capture: capture?.state ?? { camera: 'off', microphone: 'off', errors: {} },
  };
  const active = { faces: null, objects: null, speech: null };

  function setLive(patch) { Object.assign(live, patch); statusListeners.emit(snapshotLive()); }
  function setStream(kind, patch) { live.streams[kind] = { ...live.streams[kind], ...patch }; statusListeners.emit(snapshotLive()); }
  function snapshotLive() { return { ...live, streams: { ...live.streams }, media: { ...live.media }, capture: capture?.state ?? live.capture, capturing, starting, sessionId, limits, decision }; }
  function notice(level, message, extra = {}) { notices.emit({ level, message, at: new Date(clock.now()).toISOString(), ...extra }); }

  /* ------------------------------------------------------------- session */

  async function ensureSession() {
    if (!fetchImpl) throw new Error('fetch is not available');
    if (sessionId) {
      const res = await fetchImpl(`/api/v1/sessions/${encodeURIComponent(sessionId)}`, { headers: { accept: 'application/json' } });
      if (res.ok) { const snap = await res.json(); websocketUrl = `/ws/v1/${sessionId}`; return snap; }
      if (res.status !== 404) throw new Error(`Could not resume the V1 session (${res.status})`);
      sessionId = null; storage?.removeItem(SESSION_KEY);
    }
    const res = await fetchImpl('/api/v1/sessions', { method: 'POST', headers: { accept: 'application/json' } });
    if (!res.ok) {
      let detail = `${res.status}`;
      try { detail = (await res.json()).detail ?? detail; } catch { /* keep status */ }
      throw new Error(`Could not create a V1 session: ${detail}`);
    }
    const body = await res.json();
    sessionId = body.session_id;
    websocketUrl = body.websocket_url ?? `/ws/v1/${sessionId}`;
    if (body.limits) limits = { ...limits, ...body.limits };
    storage?.setItem(SESSION_KEY, sessionId);
    return body.snapshot;
  }

  /* ------------------------------------------------------------- control ws */

  function wsUrlFor(path) {
    const scheme = loc?.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${scheme}//${loc?.host ?? 'localhost'}${path}`;
  }

  function connect() {
    if (!wanted || !sessionId || !WS) return;
    const gen = ++wsGen;
    const socket = new WS(wsUrlFor(websocketUrl ?? `/ws/v1/${sessionId}`));
    socket.binaryType = 'arraybuffer';
    ws = socket;
    helloAcked = false;
    decision = null;                 // a replaced socket must not show the old socket's decision status
    setLive({ session: 'connecting', sessionMessage: '' });
    const mine = () => wanted && gen === wsGen && ws === socket;
    socket.onopen = () => {
      if (!mine()) return;
      reconnectAttempt = 0;
      socket.send(JSON.stringify({ type: 'hello', device_ts_ms: clock.nowMs() % 2 ** 32 }));
      schedulePing();
    };
    socket.onmessage = (ev) => { if (mine()) onControlMessage(ev.data); };
    socket.onclose = (ev) => {
      if (!mine()) return;
      ws = null;
      clock.clearTimeout(pingTimer);
      rejectAllPending(new Error('Session connection closed'));
      if (capturing) stopCapture('Session connection lost; capture stopped. Start again when reconnected.');
      setLive({ session: 'disconnected', sessionMessage: ev?.reason || 'Disconnected' });
      if (!wanted) return;
      const delay = RECONNECT_MS[Math.min(reconnectAttempt, RECONNECT_MS.length - 1)];
      reconnectAttempt += 1;
      reconnectTimer = clock.setTimeout(connect, delay);
    };
    socket.onerror = () => { /* onclose follows */ };
  }

  function schedulePing() {
    clock.clearTimeout(pingTimer);
    pingTimer = clock.setTimeout(() => {
      if (ws?.readyState === 1) { try { ws.send(JSON.stringify({ type: 'ping' })); } catch { /* ignore */ } }
      schedulePing();
    }, PING_MS);
  }

  function onControlMessage(raw) {
    let msg;
    try { msg = typeof raw === 'string' ? JSON.parse(raw) : null; } catch { return; }
    if (!msg || typeof msg !== 'object') return;
    switch (msg.type) {
      case 'v1.ack': {
        if (msg.receipt?.hello) {
          // Authoritative state first (listeners hydrate synchronously), THEN ready. Envelopes queued
          // on the server while we were disconnected are gone; this snapshot replaces them.
          if (msg.snapshot && typeof msg.snapshot === 'object') snapshots.emit(msg.snapshot);
          helloAcked = true;
          setLive({ session: 'connected', sessionMessage: '' });
        }
        const p = msg.request_id ? pending.get(msg.request_id) : null;
        if (p) { pending.delete(msg.request_id); clock.clearTimeout(p.timer); p.resolve(msg.receipt ?? {}); }
        return;
      }
      case 'v1.error': {
        const p = msg.request_id ? pending.get(msg.request_id) : null;
        if (p) { pending.delete(msg.request_id); clock.clearTimeout(p.timer); p.reject(new Error(msg.message ?? 'V1 error')); }
        else notice('error', msg.message ?? 'V1 error');
        return;
      }
      case 'v1.frame_ack':
        if (frameInFlight && msg.seq === frameInFlight.seq) {
          clock.clearTimeout(frameInFlight.timer);
          frameInFlight = null;
          if (msg.accepted) live.media.frames_sent += 1; else live.media.frames_rejected += 1;
          statusListeners.emit(snapshotLive());
        }
        return;
      case 'v1.control':
        onControl(msg.control ?? {});
        return;
      case 'v1.pong':
        return;
      case 'v1.decision_status': {
        const st = normalizeDecisionStatus(msg.status);
        if (st) { decision = st; statusListeners.emit(snapshotLive()); }
        return; // malformed or unknown → ignored
      }
      default:
        // Versioned state envelopes: validated and applied by the store, not here.
        if (typeof msg.schema_version === 'string' && msg.event_id) emitter.emit(msg);
    }
  }

  function onControl(control) {
    const faces = active.faces;
    const streamId = faces?.streamId ?? null;
    if (control.type === 'enroll') {
      const ok = faces && live.streams.faces.phase === 'running' && faces.enroll(control.name, control.target_track_id);
      if (!ok) sendJson({ type: 'enrollment.status', stream_id: streamId, data: { type: 'error', message: 'Face stream is not running; introduction could not be forwarded' } });
    } else if (control.type === 'cancel_enrollment') {
      faces?.cancelEnrollment?.();
    }
  }

  function sendJson(obj) {
    if (ws?.readyState !== 1) return false;
    try { ws.send(JSON.stringify(obj)); return true; } catch { return false; }
  }

  function sendCommand(command) {
    return new Promise((resolve, reject) => {
      if (ws?.readyState !== 1 || !helloAcked) { reject(new Error('Not connected to the V1 session yet')); return; }
      const request_id = `req_${++requestSeq}`;
      const timer = clock.setTimeout(() => { pending.delete(request_id); reject(new Error('No reply from the V1 session')); }, 10_000);
      pending.set(request_id, { resolve, reject, timer });
      if (!sendJson({ type: 'command', request_id, command })) { pending.delete(request_id); clock.clearTimeout(timer); reject(new Error('Could not send the command')); }
    });
  }
  function rejectAllPending(err) { for (const [, p] of pending) { clock.clearTimeout(p.timer); p.reject(err); } pending.clear(); }

  /* ------------------------------------------------------------- capture */

  /**
   * Start capture. Every await re-checks the generation token: Stop/Cancel, reset, connection loss
   * or a newer start all bump `captureGen`, so a late getUserMedia or capture.status ack cannot
   * bring capture back. Throws CancelledError-style Error('cancelled') when aborted.
   */
  async function startCapture(next) {
    if (capturing || starting) return snapshotLive();
    if (!capture) throw new Error('Capture is not available in this browser');
    if (ws?.readyState !== 1 || !helloAcked) throw new Error('Connect to the V1 session before starting capture');
    const gen = ++captureGen;
    const stale = () => gen !== captureGen;
    starting = true;
    settings = next;
    live.media = { frames_sent: 0, frames_dropped: 0, frames_rejected: 0, audio_chunks: 0, last_error: null };
    statusListeners.emit(snapshotLive());
    let result;
    try {
      result = await capture.start({ camera: Boolean(next.camera), microphone: Boolean(next.microphone), cameraId: next.cameraId ?? null, micId: next.micId ?? null });
    } catch (err) {
      // Only the current generation owns the shared capture; a superseded start's failure must not
      // stop a newer capture (capture.js releases its own obsolete acquisition).
      if (gen === captureGen) { starting = false; capture.stop(); statusListeners.emit(snapshotLive()); }
      throw err;
    }
    if (stale()) throw new Error('cancelled'); // capture.js already released this start's tracks
    const camera = result.camera === 'live' ? 'live' : 'off';
    const microphone = result.microphone === 'live' ? 'live' : 'off';
    if (camera === 'off' && microphone === 'off') {
      starting = false;
      capture.stop();
      statusListeners.emit(snapshotLive());
      throw new Error(result.errors?.camera || result.errors?.microphone || 'Nothing was enabled');
    }
    try { await sendCommand({ type: 'capture.status', payload: { camera, microphone } }); }
    catch (err) {
      if (gen === captureGen) { starting = false; capture.stop(); statusListeners.emit(snapshotLive()); }
      throw err;
    }
    if (stale()) throw new Error('cancelled'); // a newer generation owns capture and server state now
    starting = false;
    capturing = true;
    if (camera === 'live') {
      frameSeq = 0; jpegQuality = 0.8;
      scheduleFrame(0);
      if (next.faces?.enabled) startStream('faces', gen, (self) => streams.faces({
        backend: next.faces.backend, capture,
        onFrame: (frame, meta) => { if (!stale()) sendJson({ type: 'perception.faces', stream_id: meta.streamId, capture_ts_ms: meta.captureTsMs % 2 ** 32, data: frame }); },
        onStatus: (st) => onStreamStatus('faces', st, gen, self),
        onEnrollmentStatus: (data) => { if (!stale()) sendJson({ type: 'enrollment.status', stream_id: active.faces?.streamId ?? null, data }); },
      }));
      if (next.objects?.enabled) startStream('objects', gen, (self) => streams.objects({
        backend: next.objects.backend, vocabulary: next.objects.vocabulary ?? ['person', 'keys', 'phone'], capture,
        onFrame: (frame, meta) => { if (!stale()) sendJson({ type: 'perception.objects', stream_id: meta.streamId, capture_ts_ms: meta.captureTsMs % 2 ** 32, data: frame }); },
        onStatus: (st) => onStreamStatus('objects', st, gen, self),
      }));
    }
    if (microphone === 'live') {
      audioSeq = 0;
      unsubChunk = capture.onChunk((chunk) => { if (!stale()) onChunk(chunk); });
      if (next.speech?.enabled) startStream('speech', gen, (self) => streams.speech({
        backend: next.speech.backend, capture,
        onTranscript: (segment, meta) => { if (!stale()) sendJson({ type: 'perception.speech', stream_id: meta.streamId, data: segment }); },
        onStatus: (st) => onStreamStatus('speech', st, gen, self),
      }));
    }
    statusListeners.emit(snapshotLive());
    return snapshotLive();
  }
  /** `factory(self)` receives a handle whose `.stream` is filled in once created, so callbacks are bound to that instance. */
  function startStream(kind, gen, factory) {
    if (gen !== captureGen) return;
    const self = { stream: null };
    const stream = factory(self);
    self.stream = stream;
    active[kind] = stream;
    setStream(kind, { phase: 'connecting', message: '', streamId: null });
    stream.start().catch((err) => onStreamStatus(kind, { phase: 'error', message: err?.message ?? String(err) }, gen, self));
  }

  /**
   * Status from ONE stream instance. A stream that is no longer the active one for its kind (older
   * generation, or replaced) may only report its own shutdown with its own stream id; it never
   * touches UI state, `active[kind]` or the server's view of the current stream.
   */
  function onStreamStatus(kind, st, gen, self) {
    const stream = self?.stream ?? null;
    const owns = gen === captureGen && (stream === null || active[kind] === stream);
    if (!owns) {
      if ((st.phase === 'stopped' || st.phase === 'error') && stream?.streamId) sendJson({ type: 'stream.state', kind, available: false, stream_id: stream.streamId });
      return;
    }
    const streamId = stream?.streamId ?? live.streams[kind].streamId ?? null;
    setStream(kind, { phase: st.phase, message: st.message ?? '', streamId, ready: st.ready ?? live.streams[kind].ready });
    if (st.phase === 'running') sendJson({ type: 'stream.state', kind, available: true, stream_id: streamId });
    if (st.phase === 'stopped' || st.phase === 'error') {
      sendJson({ type: 'stream.state', kind, available: false, stream_id: streamId });
      if (st.phase === 'error' && st.message) notice('warn', `${labelFor(kind)}: ${st.message}`, { component: kind });
      if (active[kind] === stream) active[kind] = null;
    }
  }
  const labelFor = (k) => ({ faces: 'Faces', objects: 'Objects', speech: 'Speech' })[k] ?? k;

  function scheduleFrame(delay) {
    clock.clearTimeout(frameTimer);
    const gen = captureGen;
    frameTimer = clock.setTimeout(() => { if (gen === captureGen) sendFrame(gen); }, delay);
  }
  async function sendFrame(gen) {
    if (!capturing || gen !== captureGen) return;
    if (frameInFlight || ws?.readyState !== 1) { scheduleFrame(FRAME_INTERVAL_MS / 2); return; }
    const grab = await capture.grabJpeg({ maxSide: 640, quality: jpegQuality });
    if (!capturing || gen !== captureGen) return;
    if (!grab) { scheduleFrame(FRAME_INTERVAL_MS); return; }
    if (grab.buffer.byteLength + 8 > (limits.jpeg_max_bytes ?? 256 * 1024)) {
      jpegQuality = Math.max(0.4, jpegQuality - 0.15);
      live.media.frames_dropped += 1;
      scheduleFrame(FRAME_INTERVAL_MS);
      return;
    }
    if (ws.bufferedAmount > MAX_CONTROL_BACKLOG) { live.media.frames_dropped += 1; scheduleFrame(FRAME_INTERVAL_MS); return; }
    const seq = frameSeq = (frameSeq + 1) & 0xffff;
    frameInFlight = { seq, timer: clock.setTimeout(() => { if (frameInFlight?.seq === seq) { frameInFlight = null; live.media.frames_dropped += 1; } }, FRAME_ACK_TIMEOUT_MS) };
    try { ws.send(encodeMedia(MEDIA_JPEG, seq, grab.captureTsMs, grab.buffer)); }
    catch { clock.clearTimeout(frameInFlight.timer); frameInFlight = null; }
    scheduleFrame(FRAME_INTERVAL_MS);
  }

  function onChunk(chunk) {
    if (!capturing || ws?.readyState !== 1) return;
    if (chunk.buffer.byteLength !== 1024) return;
    if (ws.bufferedAmount > MAX_CONTROL_BACKLOG) {
      stopCapture('The V1 link fell behind on audio (over 64 KB queued); capture stopped instead of adding lag.');
      return;
    }
    audioSeq = (audioSeq + 1) & 0xffff;
    try { ws.send(encodeMedia(MEDIA_PCM, audioSeq, chunk.captureTsMs, chunk.buffer)); live.media.audio_chunks += 1; } catch { /* socket closing */ }
  }

  /** Stop or cancel. Bumps the generation so any pending start/timer/stream callback becomes a no-op. */
  function stopCapture(errorMessage) {
    const wasActive = capturing || starting;
    if (!wasActive && !errorMessage) return;
    captureGen += 1;
    capturing = false;
    starting = false;
    clock.clearTimeout(frameTimer);
    if (frameInFlight) { clock.clearTimeout(frameInFlight.timer); frameInFlight = null; }
    unsubChunk?.(); unsubChunk = null;
    for (const kind of ['faces', 'objects', 'speech']) {
      const s = active[kind];
      active[kind] = null;
      // stream.stop() reports 'stopped' exactly once → onStreamStatus sends stream.state false.
      if (s) { try { s.stop(); } catch { sendJson({ type: 'stream.state', kind, available: false, stream_id: live.streams[kind].streamId ?? null }); } }
      live.streams[kind] = { phase: 'idle', streamId: null, message: '' };
    }
    capture?.stop();
    if (ws?.readyState === 1 && helloAcked) sendCommand({ type: 'capture.status', payload: { camera: 'off', microphone: 'off' } }).catch(() => {});
    if (errorMessage) { live.media.last_error = errorMessage; notice('error', errorMessage); }
    statusListeners.emit(snapshotLive());
  }

  // A real track ending (device unplugged, permission revoked) is a bounded fallback: stop everything,
  // release devices/streams/timers and tell the server both sides are off. Start works again afterwards.
  capture?.onEnded?.((info) => { if (capturing || starting) stopCapture(info?.message ?? 'A capture device ended; capture stopped.'); });
  capture?.onState?.(() => statusListeners.emit(snapshotLive()));

  /* ------------------------------------------------------------- provider */

  return {
    kind: 'live',
    get sessionId() { return sessionId ?? 'live_unbound'; },
    get limits() { return limits; },
    subscribe: emitter.subscribe,
    onNotice: notices.subscribe,
    onLiveStatus: statusListeners.subscribe,
    /** Fires with the server's current Snapshot on every hello ack; the app re-hydrates from it. */
    onSnapshot: snapshots.subscribe,
    getLiveStatus: snapshotLive,
    async getSnapshot() { return ensureSession(); },
    /** Open the control connection (CRUD/recall work without capture). */
    async start() {
      if (wanted) return;
      if (!sessionId) await ensureSession();
      wanted = true;
      connect();
    },
    /** Stop capture and close the control connection. The temporary session stays on the server. */
    async stop() {
      stopCapture();
      wanted = false;
      clock.clearTimeout(reconnectTimer);
      clock.clearTimeout(pingTimer);
      rejectAllPending(new Error('Provider stopped'));
      const socket = ws; ws = null; wsGen += 1;
      if (socket) { socket.onopen = socket.onmessage = socket.onclose = socket.onerror = null; try { socket.close(); } catch { /* ignore */ } }
      decision = null;
      setLive({ session: 'disconnected', sessionMessage: 'Stopped' });
    },
    /** Explicit reset: delete the temporary session (and its clips) on the server. The face gallery is untouched. */
    async destroySession() {
      await this.stop();
      const sid = sessionId;
      sessionId = null; storage?.removeItem(SESSION_KEY);
      if (sid && fetchImpl) { try { await fetchImpl(`/api/v1/sessions/${encodeURIComponent(sid)}`, { method: 'DELETE' }); } catch { /* server may already have expired it */ } }
    },
    startCapture,
    stopCapture: () => stopCapture(),
    get capturing() { return capturing; },
    get starting() { return starting; },
    get settings() { return settings; },
    async dispatch(command) {
      if (!command?.type) throw new Error('Missing command type');
      if (command.type.startsWith('demo.')) throw new Error('Demo scenes are not available in Live mode');
      return sendCommand({ type: command.type, payload: command.payload ?? {} });
    },
  };
}

function safeSessionStorage() { try { return globalThis.sessionStorage ?? null; } catch { return null; } }

export const DECISION_BACKENDS = ['rules', 'typesafe'];
export const DECISION_PHASES = ['rules', 'idle', 'ready', 'deciding', 'dropped', 'backoff', 'error', 'stopped'];

/**
 * Validate a `v1.decision_status.status` object (sent outside envelopes). Returns a clean copy or
 * null. 'configured' or 'ready' never means live-verified; the UI only repeats the server's words.
 */
export function normalizeDecisionStatus(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (!DECISION_BACKENDS.includes(raw.backend) || !DECISION_PHASES.includes(raw.phase)) return null;
  if (typeof raw.message !== 'string') return null;
  if (raw.model !== null && raw.model !== undefined && typeof raw.model !== 'string') return null;
  const out = { backend: raw.backend, phase: raw.phase, model: raw.model ?? null, message: raw.message.slice(0, 400) };
  if (Number.isFinite(raw.retry_after_s) && raw.retry_after_s >= 0) out.retry_after_s = raw.retry_after_s;
  if (typeof raw.requires_reconfiguration === 'boolean') out.requires_reconfiguration = raw.requires_reconfiguration;
  if (typeof raw.reason === 'string') out.reason = raw.reason.slice(0, 400);
  if (typeof raw.event_id === 'string') out.event_id = raw.event_id;
  if (raw.timings_ms && typeof raw.timings_ms === 'object') out.timings_ms = Object.fromEntries(Object.entries(raw.timings_ms).filter(([, v]) => Number.isFinite(v)));
  return out;
}
export { SCHEMA_VERSION };
