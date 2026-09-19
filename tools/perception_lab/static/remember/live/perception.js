// Perception stream clients for the Remember product UI. They speak the lab protocols exactly
// (/ws/faces, /ws/objects, /ws/speech; see tools/perception_lab/server.py and experiments.py) and
// take frames/chunks from a single shared capture (./capture.js).
//
// Shared rules:
//   - Every start() creates a new unique streamId; a reconnect never reuses one.
//   - Every callback (socket handler, timer, grab promise) is guarded by a per-start run token.
//   - stop() detaches handlers, closes the socket in any state, clears all timers, and reports
//     onStatus({phase:'stopped'}) exactly once (or 'error' with a message when stopping after a failure).
//   - Frame streams keep at most ONE frame in flight; a second frame is never sent on a socket
//     with an unanswered request (a late reply could not be attributed to the right frame).
import { wsUrl } from '../../common.js';

const WS_CONNECTING = 0;
const WS_OPEN = 1;

export const FACES_READY_TIMEOUT_MS = 15000;
export const FACES_RESPONSE_TIMEOUT_MS = 5000;
export const OBJECTS_READY_TIMEOUT_MS = 15000;
export const OBJECTS_DEFAULT_RESPONSE_TIMEOUT_MS = 5000;
export const OBJECTS_MIN_RESPONSE_TIMEOUT_MS = 5000;
export const OBJECTS_MAX_RESPONSE_TIMEOUT_MS = 15000;
export const SPEECH_READY_TIMEOUT_MS = 20000;
export const SPEECH_MAX_BUFFERED_BYTES = 16384; // 512 ms of 16 kHz PCM16
export const SPEECH_CHUNK_BYTES = 1024;
export const SPEECH_FLUSH_CHUNKS = 16;          // 500 ms of zero PCM
export const SPEECH_FLUSH_STEP_MS = 32;
export const SPEECH_CLOSE_GRACE_MS = 3000;

const realClock = {
  nowMs: () => Math.floor(globalThis.performance?.now?.() ?? Date.now()),
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (id) => globalThis.clearTimeout(id),
};

let streamCounter = 0;
function newStreamId(kind) {
  streamCounter += 1;
  return `${kind}_${Date.now().toString(36)}_${streamCounter.toString(36)}`;
}

/** Objects reply timeout: ready.response_timeout_ms clamped to [5 s, 15 s]; 5 s if missing/invalid. */
export function clampResponseTimeoutMs(raw) {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return OBJECTS_DEFAULT_RESPONSE_TIMEOUT_MS;
  return Math.min(OBJECTS_MAX_RESPONSE_TIMEOUT_MS, Math.max(OBJECTS_MIN_RESPONSE_TIMEOUT_MS, Math.round(value)));
}

// ---- shared run core -------------------------------------------------------------
// One "run" per start(). The core owns the socket, the timers and the single terminal status.
function createCore({ kind, deps, onStatus }) {
  const WS = deps?.WebSocketImpl ?? globalThis.WebSocket;
  const clock = deps?.clock ?? realClock;
  let run = null;

  const isCurrent = (r) => r !== null && r === run && !r.ended;

  function begin() {
    if (run) end(run, { message: 'Restarted' });
    run = {
      streamId: newStreamId(kind), phase: 'connecting', ended: false, ws: null, ready: null,
      timers: new Set(), lastError: null, extra: {},
    };
    return run;
  }

  function status(r, obj) {
    if (!isCurrent(r)) return;
    try { onStatus?.(obj); } catch (e) { console.error(e); }
  }

  function setTimer(r, fn, ms) {
    const holder = {};
    holder.id = clock.setTimeout(() => {
      r.timers.delete(holder);
      if (!isCurrent(r)) return;
      fn();
    }, ms);
    r.timers.add(holder);
    return holder;
  }
  function clearTimer(r, holder) {
    if (!holder) return;
    clock.clearTimeout(holder.id);
    r.timers.delete(holder);
  }

  function detach(ws) {
    if (!ws) return;
    ws.onopen = null; ws.onmessage = null; ws.onerror = null; ws.onclose = null;
  }

  function open(r, url, handlers) {
    const ws = new WS(url);
    try { ws.binaryType = 'arraybuffer'; } catch { /* fakes may not allow it */ }
    r.ws = ws;
    ws.onopen = () => { if (isCurrent(r) && r.ws === ws) handlers.onOpen?.(); };
    ws.onmessage = (event) => {
      if (!isCurrent(r) || r.ws !== ws) return;
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }
      if (!msg || typeof msg !== 'object') return;
      handlers.onMessage(msg);
    };
    ws.onerror = () => { if (isCurrent(r) && r.ws === ws) handlers.onError?.(); };
    ws.onclose = (event) => { if (isCurrent(r) && r.ws === ws) handlers.onClose?.(event || {}); };
    return ws;
  }

  const isOpen = (r) => Boolean(r?.ws) && r.ws.readyState === WS_OPEN;

  // Terminal: idempotent per run. error → phase 'error'; otherwise 'stopped'.
  function end(r, { error = null, message = null } = {}) {
    if (!r || r.ended) return;
    r.ended = true;
    for (const holder of r.timers) clock.clearTimeout(holder.id);
    r.timers.clear();
    const ws = r.ws;
    r.ws = null;
    detach(ws);
    if (ws) { try { ws.close(); } catch { /* ignore */ } }
    r.phase = error ? 'error' : 'stopped';
    if (run === r) run = null;
    try {
      onStatus?.(error ? { phase: 'error', message: error } : { phase: 'stopped', ...(message ? { message } : {}) });
    } catch (e) { console.error(e); }
  }

  return {
    clock, WS, begin, isCurrent, status, setTimer, clearTimer, open, isOpen, end,
    get run() { return run; },
  };
}

// ---- frame loop shared by faces and objects -----------------------------------------
function attachFrameLoop(core, r, { capture, grabOptions, intervalMs, responseTimeoutMs, timeoutMessage, onFrame }) {
  r.extra.inFlight = null;  // { captureTsMs, sentAt } while a request is unanswered
  r.extra.lastSendAt = 0;
  r.extra.loopTimer = null;
  r.extra.responseTimer = null;

  function schedule(delayMs) {
    if (!core.isCurrent(r) || r.phase !== 'running') return;
    core.clearTimer(r, r.extra.loopTimer);
    const wait = delayMs !== undefined ? delayMs : Math.max(0, r.extra.lastSendAt + intervalMs() - core.clock.nowMs());
    r.extra.loopTimer = core.setTimer(r, tick, wait);
  }

  async function tick() {
    if (!core.isCurrent(r) || r.phase !== 'running' || !core.isOpen(r)) return;
    if (r.extra.inFlight) return; // the reply (or busy/error) reschedules
    let grab = null;
    try { grab = await capture.grabJpeg(grabOptions()); } catch { grab = null; }
    if (!core.isCurrent(r) || r.phase !== 'running') return;
    if (!grab || !grab.buffer) { schedule(100); return; }
    if (r.extra.inFlight || !core.isOpen(r)) { schedule(); return; }
    const now = core.clock.nowMs();
    r.extra.inFlight = { captureTsMs: grab.captureTsMs, sentAt: now, width: grab.width, height: grab.height };
    r.extra.lastSendAt = now;
    r.ws.send(grab.buffer);
    core.clearTimer(r, r.extra.responseTimer);
    r.extra.responseTimer = core.setTimer(r, () => {
      if (!r.extra.inFlight) return;
      core.end(r, { error: timeoutMessage() });
    }, responseTimeoutMs());
  }

  function releaseSlot() {
    core.clearTimer(r, r.extra.responseTimer);
    r.extra.responseTimer = null;
    const flight = r.extra.inFlight;
    r.extra.inFlight = null;
    return flight;
  }

  function handleFrame(msg, { ignoreWhenIdle }) {
    if (ignoreWhenIdle && !r.extra.inFlight) return; // nothing outstanding: do not mis-attribute
    const flight = releaseSlot();
    const meta = {
      streamId: r.streamId,
      captureTsMs: flight ? flight.captureTsMs : null,
      sentAtMs: flight ? flight.sentAt : null,
      receivedAtMs: core.clock.nowMs(),
      sentWidth: flight ? flight.width : null,
      sentHeight: flight ? flight.height : null,
    };
    try { onFrame?.(msg, meta); } catch (e) { console.error(e); }
    schedule();
  }

  return { schedule, releaseSlot, handleFrame };
}

// ---- faces -----------------------------------------------------------------------------
export function createFacesStream({ backend = 'local', capture, onFrame, onStatus, onEnrollmentStatus, deps } = {}) {
  const core = createCore({ kind: 'faces', deps, onStatus });

  async function start() {
    const r = core.begin();
    core.status(r, { phase: 'connecting', message: 'Connecting to the face service…' });
    const loop = attachFrameLoop(core, r, {
      capture,
      grabOptions: () => ({ maxSide: Math.min(640, Number(r.ready?.max_side) || 640), quality: 0.8 }),
      intervalMs: () => 1000 / (Number(r.ready?.max_fps) || 5),
      responseTimeoutMs: () => FACES_RESPONSE_TIMEOUT_MS,
      timeoutMessage: () => `No face reply within ${FACES_RESPONSE_TIMEOUT_MS / 1000} seconds`,
      onFrame,
    });
    r.extra.readyTimer = core.setTimer(r, () => {
      core.end(r, { error: `Face model did not become ready within ${FACES_READY_TIMEOUT_MS / 1000} s` });
    }, FACES_READY_TIMEOUT_MS);

    core.open(r, wsUrl('/ws/faces', { backend }), {
      onOpen: () => core.status(r, { phase: 'connecting', message: 'Connected. Waiting for the face model…' }),
      onMessage: (msg) => {
        switch (msg.type) {
          case 'ready':
            core.clearTimer(r, r.extra.readyTimer);
            r.ready = msg;
            if (r.phase === 'connecting') {
              r.phase = 'running';
              core.status(r, { phase: 'running', ready: msg, message: `Running ${msg.model || 'face model'} via ${msg.backend || backend}` });
              r.extra.lastSendAt = 0;
              loop.schedule(0);
            }
            break;
          case 'frame':
            loop.handleFrame(msg, { ignoreWhenIdle: true });
            break;
          case 'busy':
            loop.releaseSlot();
            loop.schedule();
            break;
          case 'enrollment_started':
          case 'enrollment_cancelled':
            try { onEnrollmentStatus?.(msg); } catch (e) { console.error(e); }
            break;
          case 'error':
            r.lastError = msg.message || 'Server error';
            core.status(r, { phase: r.phase, message: r.lastError });
            try { onEnrollmentStatus?.(msg); } catch (e) { console.error(e); }
            loop.releaseSlot();
            loop.schedule();
            break;
          default:
            break;
        }
      },
      onError: () => core.status(r, { phase: r.phase, message: 'WebSocket error. Is the server running?' }),
      onClose: () => core.end(r, { error: r.lastError ? `Face connection closed: ${r.lastError}` : 'Face connection closed' }),
    });
  }

  function stop(reason) {
    const r = core.run;
    if (!r) return;
    core.end(r, { message: reason || null });
  }

  function enroll(name, targetTrackId) {
    const r = core.run;
    if (!r || r.phase !== 'running' || !core.isOpen(r)) return false;
    const payload = { type: 'enroll', name: String(name ?? '').trim() };
    if (targetTrackId !== null && targetTrackId !== undefined) {
      payload.target_track_id = typeof targetTrackId === 'string' && /^\d+$/.test(targetTrackId.trim())
        ? Number(targetTrackId.trim()) : targetTrackId;
    }
    r.ws.send(JSON.stringify(payload));
    return true;
  }

  function cancelEnrollment() {
    const r = core.run;
    if (!r || !core.isOpen(r)) return false;
    r.ws.send(JSON.stringify({ type: 'cancel_enrollment' }));
    return true;
  }

  return {
    start, stop, enroll, cancelEnrollment,
    get streamId() { return core.run?.streamId ?? null; },
    get state() { return core.run?.phase ?? 'idle'; },
    get ready() { return core.run?.ready ?? null; },
  };
}

// ---- objects ---------------------------------------------------------------------------
export function createObjectsStream({ backend = 'local', vocabulary = [], capture, onFrame, onStatus, deps } = {}) {
  const core = createCore({ kind: 'objects', deps, onStatus });

  async function start() {
    const r = core.begin();
    core.status(r, { phase: 'connecting', message: 'Connecting to the object service…' });
    const loop = attachFrameLoop(core, r, {
      capture,
      grabOptions: () => ({ maxSide: 1280, quality: 0.7 }),
      intervalMs: () => 100, // ≤ 10 fps
      responseTimeoutMs: () => clampResponseTimeoutMs(r.ready?.response_timeout_ms),
      timeoutMessage: () => `No object reply within ${clampResponseTimeoutMs(r.ready?.response_timeout_ms) / 1000} s from the ${backend} backend`,
      onFrame,
    });
    r.extra.readyTimer = core.setTimer(r, () => {
      core.end(r, { error: `Object model did not become ready within ${OBJECTS_READY_TIMEOUT_MS / 1000} s` });
    }, OBJECTS_READY_TIMEOUT_MS);

    const words = (Array.isArray(vocabulary) ? vocabulary : []).map((w) => String(w).trim()).filter(Boolean);
    core.open(r, wsUrl('/ws/objects', { backend, vocabulary: words.join(',') }), {
      onOpen: () => core.status(r, { phase: 'connecting', message: 'Connected. Waiting for the object model…' }),
      onMessage: (msg) => {
        switch (msg.type) {
          case 'loading':
            core.status(r, { phase: 'connecting', message: 'Loading the object model…' });
            break;
          case 'ready':
            core.clearTimer(r, r.extra.readyTimer);
            r.ready = msg;
            if (r.phase === 'connecting') {
              r.phase = 'running';
              core.status(r, {
                phase: 'running', ready: msg,
                trackingPersistent: msg.tracking_persistent !== false,
                responseTimeoutMs: clampResponseTimeoutMs(msg.response_timeout_ms),
                message: `Running ${msg.model || 'object model'} via ${msg.backend || backend}`,
              });
              r.extra.lastSendAt = 0;
              loop.schedule(0);
            }
            break;
          case 'frame':
            loop.handleFrame(msg, { ignoreWhenIdle: false });
            break;
          case 'busy':
            loop.releaseSlot();
            loop.schedule();
            break;
          case 'error':
            r.lastError = msg.message || 'Server error';
            core.status(r, { phase: r.phase, message: r.lastError });
            loop.releaseSlot();
            loop.schedule();
            break;
          default:
            break;
        }
      },
      onError: () => core.status(r, { phase: r.phase, message: 'WebSocket error. Is the server running?' }),
      onClose: () => core.end(r, { error: r.lastError ? `Object connection closed: ${r.lastError}` : 'Object connection closed' }),
    });
  }

  function stop(reason) {
    const r = core.run;
    if (!r) return;
    core.end(r, { message: reason || null });
  }

  return {
    start, stop,
    get streamId() { return core.run?.streamId ?? null; },
    get state() { return core.run?.phase ?? 'idle'; },
    get ready() { return core.run?.ready ?? null; },
  };
}

// ---- speech ----------------------------------------------------------------------------
export function createSpeechStream({ backend = 'baseten', capture, onTranscript, onStatus, deps } = {}) {
  const core = createCore({ kind: 'speech', deps, onStatus });

  function unsubscribeChunks(r) {
    const off = r.extra.unsubChunk;
    r.extra.unsubChunk = null;
    if (off) { try { off(); } catch { /* ignore */ } }
  }

  async function start() {
    const r = core.begin();
    r.extra.unsubChunk = null;
    r.extra.chunksSent = 0;
    r.extra.chunksSkipped = 0;
    core.status(r, { phase: 'connecting', message: 'Connecting to the speech service…' });
    r.extra.readyTimer = core.setTimer(r, () => {
      core.end(r, { error: `Speech backend did not become ready within ${SPEECH_READY_TIMEOUT_MS / 1000} s. The cloud model may be waking from zero; retry in a moment.` });
    }, SPEECH_READY_TIMEOUT_MS);

    const onChunk = (chunk) => {
      if (!core.isCurrent(r) || r.phase !== 'running' || !core.isOpen(r)) return;
      const buffer = chunk?.buffer;
      if (!buffer || buffer.byteLength !== SPEECH_CHUNK_BYTES) { r.extra.chunksSkipped += 1; return; }
      if (r.ws.bufferedAmount > SPEECH_MAX_BUFFERED_BYTES) {
        unsubscribeChunks(r);
        core.end(r, { error: 'Audio backlog over 512 ms; stopped speech instead of adding lag' });
        return;
      }
      r.ws.send(buffer);
      r.extra.chunksSent += 1;
    };

    core.open(r, wsUrl('/ws/speech', { backend }), {
      onOpen: () => core.status(r, { phase: 'connecting', message: 'Connected. Waiting for the speech backend…' }),
      onMessage: (msg) => {
        switch (msg.type) {
          case 'connecting':
            core.status(r, { phase: 'connecting', message: 'Server is connecting to the speech backend…' });
            break;
          case 'ready':
            core.clearTimer(r, r.extra.readyTimer);
            r.ready = msg;
            if (r.phase === 'connecting') {
              r.phase = 'running';
              r.extra.unsubChunk = capture.onChunk(onChunk);
              core.status(r, { phase: 'running', ready: msg, message: `Listening via ${msg.model_id || msg.model || 'speech backend'} (${msg.backend || backend})` });
            }
            break;
          case 'transcript':
            try { onTranscript?.(msg, { streamId: r.streamId }); } catch (e) { console.error(e); }
            break;
          case 'error':
            r.lastError = msg.message || 'Server error';
            core.status(r, { phase: r.phase, message: r.lastError });
            break;
          default:
            core.status(r, { phase: r.phase, message: msg.message || String(msg.type || ''), raw: msg });
            break;
        }
      },
      onError: () => core.status(r, { phase: r.phase, message: 'WebSocket error. Is the server running?' }),
      onClose: () => {
        unsubscribeChunks(r);
        if (r.phase === 'stopping') { core.end(r, {}); return; }
        core.end(r, { error: r.lastError ? `Speech connection closed: ${r.lastError}` : 'Speech connection closed' });
      },
    });
  }

  // While running with an open socket: 500 ms of paced zero PCM so the server VAD closes the
  // utterance, then {type:"stop"}; the server sends the last final and closes (3 s grace here).
  function stop(reason) {
    const r = core.run;
    if (!r) return;
    if (r.phase === 'stopping') return;
    unsubscribeChunks(r);
    if (r.phase !== 'running' || !core.isOpen(r)) { core.end(r, { message: reason || null }); return; }
    r.phase = 'stopping';
    r.extra.stopReason = reason || null;
    core.status(r, { phase: 'running', message: 'Microphone off. Flushing and waiting for the final transcript…' });
    let sent = 0;
    const step = () => {
      if (!core.isOpen(r)) { core.end(r, { message: r.extra.stopReason }); return; }
      if (sent < SPEECH_FLUSH_CHUNKS) {
        r.ws.send(new ArrayBuffer(SPEECH_CHUNK_BYTES));
        sent += 1;
        r.extra.flushTimer = core.setTimer(r, step, SPEECH_FLUSH_STEP_MS);
        return;
      }
      r.ws.send(JSON.stringify({ type: 'stop' }));
      r.extra.closeTimer = core.setTimer(r, () => {
        core.end(r, { message: r.extra.stopReason || 'Stopped (server did not close in time)' });
      }, SPEECH_CLOSE_GRACE_MS);
    };
    r.extra.flushTimer = core.setTimer(r, step, SPEECH_FLUSH_STEP_MS);
  }

  return {
    start, stop,
    get streamId() { return core.run?.streamId ?? null; },
    get state() { return core.run?.phase ?? 'idle'; },
    get ready() { return core.run?.ready ?? null; },
  };
}
