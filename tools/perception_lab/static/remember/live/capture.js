// One browser media acquisition (camera and/or microphone) that fans out to perception sockets
// and to a clip buffer. Reuses /static/speech-worklet.js and the 512-sample PCM16 chunk contract.
//
// Rules:
//   - No media is acquired anywhere except inside start().
//   - Every awaited step is guarded by a per-start session token, so a stop() during
//     getUserMedia / addModule / play() cannot leave a live track or AudioContext behind.
//   - stop() is idempotent and releases tracks, nodes, the AudioContext and the video element.
//   - Dependencies (getUserMedia, AudioContext, AudioWorkletNode, canvas) are injectable for Node tests.
import { describeMediaError } from '../../common.js';

const CHUNK_SAMPLES = 512;
const OUT_RATE = 16000;
const CHUNK_MS = (CHUNK_SAMPLES / OUT_RATE) * 1000; // 32 ms: the chunk timestamp is its FIRST sample
const WORKLET_URL = '/static/speech-worklet.js';
const WORKLET_NAME = 'pcm-chunker';
const MACOS_HINT = 'On macOS the camera and microphone permission belongs to the browser app: System Settings > Privacy & Security > Camera / Microphone.';

const defaultClock = { nowMs: () => Math.floor(globalThis.performance?.now?.() ?? Date.now()) };

/** getUserMedia and AudioWorklet are both available (secure context: localhost or trusted HTTPS). */
export function captureSupported() {
  return Boolean(globalThis.navigator?.mediaDevices?.getUserMedia) && Boolean(globalThis.AudioWorklet);
}

/** enumerateDevices only; never calls getUserMedia. Blank labels become "Camera 1" / "Microphone 1". */
export async function listDevices() {
  const media = globalThis.navigator?.mediaDevices;
  if (!media?.enumerateDevices) return { cameras: [], microphones: [] };
  const devices = await media.enumerateDevices();
  const pick = (kind, placeholder) => devices
    .filter((d) => d.kind === kind)
    .map((d, index) => ({ deviceId: d.deviceId, label: d.label || `${placeholder} ${index + 1}` }));
  return { cameras: pick('videoinput', 'Camera'), microphones: pick('audioinput', 'Microphone') };
}

function friendlyError(error, what) {
  const base = describeMediaError(error, what);
  const name = error?.name || '';
  const permissionLike = name === 'NotAllowedError' || name === 'SecurityError' || name === 'NotReadableError' || name === 'AbortError';
  return permissionLike ? `${base} ${MACOS_HINT}` : base;
}

function stopTracks(stream) {
  if (!stream?.getTracks) return;
  for (const track of stream.getTracks()) {
    try { track.stop(); } catch { /* ignore */ }
  }
}

function emitter() {
  const fns = new Set();
  return {
    on(fn) { fns.add(fn); return () => { fns.delete(fn); }; },
    emit(...args) { for (const fn of [...fns]) { try { fn(...args); } catch (e) { console.error(e); } } },
  };
}

/**
 * @param {{ videoEl?: HTMLVideoElement|null, clock?: {nowMs: () => number},
 *   deps?: { getUserMedia?: Function, AudioContextImpl?: Function, AudioWorkletNodeImpl?: Function, canvasFactory?: Function } }} opts
 */
export function createCapture({ videoEl = null, clock = defaultClock, deps = {} } = {}) {
  const getUserMedia = deps.getUserMedia
    ?? ((constraints) => globalThis.navigator.mediaDevices.getUserMedia(constraints));
  const AudioContextImpl = deps.AudioContextImpl ?? globalThis.AudioContext;
  const AudioWorkletNodeImpl = deps.AudioWorkletNodeImpl ?? globalThis.AudioWorkletNode;
  const canvasFactory = deps.canvasFactory ?? (() => globalThis.document.createElement('canvas'));

  const chunkListeners = emitter();
  const levelListeners = emitter();
  const stateListeners = emitter();
  const endedListeners = emitter();

  const state = { camera: 'off', microphone: 'off', errors: {} };
  let session = null; // { id, ended, cameraStream, micStream, ctx, source, node, resolveEnded, endedPromise }
  let sessionSeq = 0;
  let canvas = null;
  let canvasCtx = null;

  const isCurrent = (s) => s !== null && s === session && !s.ended;
  const snapshot = () => ({ camera: state.camera, microphone: state.microphone, errors: { ...state.errors } });
  const notifyState = () => stateListeners.emit(snapshot());

  function newSession() {
    let resolveEnded;
    const endedPromise = new Promise((resolve) => { resolveEnded = resolve; });
    return {
      id: ++sessionSeq, ended: false, cameraStream: null, micStream: null,
      ctx: null, source: null, node: null, resolveEnded, endedPromise, video: null, audioSampleRate: null,
    };
  }

  // ---- camera ------------------------------------------------------------------
  function waitForMetadata(s) {
    if (!videoEl) return Promise.resolve();
    if (videoEl.readyState >= 1) return Promise.resolve();
    return Promise.race([
      new Promise((resolve, reject) => {
        const onLoaded = () => { cleanup(); resolve(); };
        const onError = () => { cleanup(); reject(new Error('Video element failed to load the camera stream')); };
        const cleanup = () => {
          videoEl.removeEventListener?.('loadedmetadata', onLoaded);
          videoEl.removeEventListener?.('error', onError);
        };
        videoEl.addEventListener?.('loadedmetadata', onLoaded);
        videoEl.addEventListener?.('error', onError);
      }),
      s.endedPromise,
    ]);
  }

  async function startCamera(s, cameraId) {
    const video = { width: { ideal: 1280 }, height: { ideal: 720 }, ...(cameraId ? { deviceId: { exact: cameraId } } : {}) };
    const stream = await getUserMedia({ video, audio: false });
    if (!isCurrent(s)) { stopTracks(stream); return; }
    s.cameraStream = stream;
    const track = stream.getVideoTracks?.()[0];
    track?.addEventListener?.('ended', () => { if (isCurrent(s)) onTrackEnded(s, 'camera'); });
    if (videoEl) {
      videoEl.srcObject = stream;
      videoEl.muted = true;
      videoEl.playsInline = true;
      videoEl.setAttribute?.('playsinline', '');
      await waitForMetadata(s);
      if (!isCurrent(s)) { releaseCamera(s); return; }
      try { await videoEl.play?.(); } catch { /* muted autoplay; ignore */ }
      if (!isCurrent(s)) { releaseCamera(s); return; }
    }
    const settings = track?.getSettings?.() || {};
    const width = videoEl?.videoWidth || settings.width || 0;
    const height = videoEl?.videoHeight || settings.height || 0;
    s.video = width && height ? { width, height } : null;
    state.camera = 'live';
    delete state.errors.camera;
  }

  function releaseCamera(s) {
    const stream = s.cameraStream;
    s.cameraStream = null;
    stopTracks(stream);
    if (videoEl && stream && videoEl.srcObject === stream) videoEl.srcObject = null;
  }

  // ---- microphone --------------------------------------------------------------
  async function startMic(s, micId) {
    const audio = {
      ...(micId ? { deviceId: { exact: micId } } : {}),
      echoCancellation: true, noiseSuppression: true, autoGainControl: true,
    };
    const stream = await getUserMedia({ audio, video: false });
    if (!isCurrent(s)) { stopTracks(stream); return; }
    s.micStream = stream;
    const track = stream.getAudioTracks?.()[0];
    track?.addEventListener?.('ended', () => { if (isCurrent(s)) onTrackEnded(s, 'microphone'); });

    let ctx;
    try { ctx = new AudioContextImpl({ sampleRate: OUT_RATE }); } catch { ctx = new AudioContextImpl(); }
    s.ctx = ctx;
    await ctx.audioWorklet.addModule(WORKLET_URL);
    if (!isCurrent(s)) { teardownMic(s); return; }

    s.source = ctx.createMediaStreamSource(stream);
    s.node = new AudioWorkletNodeImpl(ctx, WORKLET_NAME, {
      numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1],
      processorOptions: { inputRate: ctx.sampleRate, outRate: OUT_RATE, chunkSamples: CHUNK_SAMPLES },
    });
    s.node.port.onmessage = (event) => {
      if (!isCurrent(s)) return;
      const data = event?.data;
      if (!data) return;
      if (data.type === 'chunk' && data.buffer) {
        // APPROXIMATE timing: the worklet posts chunks after resampling; we stamp main-thread receipt
        // minus one chunk (32 ms) as the first-sample time. Worklet buffering and message latency add
        // tens of ms of jitter, so A/V alignment in clips is approximate, not sample-accurate.
        chunkListeners.emit({ buffer: data.buffer, sampleCount: CHUNK_SAMPLES, captureTsMs: clock.nowMs() - CHUNK_MS, timing: 'approximate' });
      } else if (data.type === 'level') {
        levelListeners.emit(data.rms);
      }
    };
    s.source.connect(s.node);
    s.node.connect(ctx.destination); // worklet output is silent; keeps the graph running
    if (ctx.state !== 'running' && ctx.resume) await ctx.resume();
    if (!isCurrent(s)) { teardownMic(s); return; }
    s.audioSampleRate = ctx.sampleRate;
    state.microphone = 'live';
    delete state.errors.microphone;
  }

  function teardownMic(s) {
    try { s.node?.port?.postMessage({ type: 'stop' }); } catch { /* ignore */ }
    if (s.node?.port) s.node.port.onmessage = null;
    try { s.source?.disconnect(); } catch { /* ignore */ }
    try { s.node?.disconnect(); } catch { /* ignore */ }
    stopTracks(s.micStream);
    const ctx = s.ctx;
    s.ctx = null; s.node = null; s.source = null; s.micStream = null;
    if (ctx && ctx.state !== 'closed') {
      try { Promise.resolve(ctx.close()).catch(() => {}); } catch { /* ignore */ }
    }
  }

  // A track ended on its own (device unplugged, permission revoked): stop that side only.
  function onTrackEnded(s, side) {
    const message = side === 'camera'
      ? 'Camera disconnected (track ended). Choose another camera and start again.'
      : 'Microphone disconnected (track ended). Choose another microphone and start again.';
    if (side === 'camera') releaseCamera(s); else teardownMic(s);
    state[side] = 'error';
    state.errors[side] = message;
    notifyState();
    endedListeners.emit({ side, message, state: snapshot() });
  }

  // ---- public ------------------------------------------------------------------
  async function start({ camera = false, microphone = false, cameraId = null, micId = null } = {}) {
    if (session) stop();
    const s = newSession();
    session = s;
    state.camera = 'off'; state.microphone = 'off'; state.errors = {};
    notifyState();

    const jobs = [];
    if (camera) {
      jobs.push(startCamera(s, cameraId).catch((e) => {
        if (!isCurrent(s)) return;
        state.camera = 'error';
        state.errors.camera = friendlyError(e, 'Camera');
      }));
    }
    if (microphone) {
      jobs.push(startMic(s, micId).catch((e) => {
        if (!isCurrent(s)) return;
        teardownMic(s);
        state.microphone = 'error';
        state.errors.microphone = friendlyError(e, 'Microphone');
      }));
    }
    await Promise.all(jobs);
    if (isCurrent(s)) notifyState();
    return { ...snapshot(), video: s.video, audioSampleRate: s.audioSampleRate };
  }

  function stop() {
    const s = session;
    if (!s) return;
    s.ended = true;
    session = null;
    s.resolveEnded();
    releaseCamera(s);
    teardownMic(s);
    if (videoEl && videoEl.srcObject) videoEl.srcObject = null;
    state.camera = 'off'; state.microphone = 'off'; state.errors = {};
    notifyState();
  }

  async function grabJpeg({ maxSide = 640, quality = 0.8 } = {}) {
    if (state.camera !== 'live' || !videoEl) return null;
    if ((videoEl.readyState ?? 0) < 2 || !videoEl.videoWidth || !videoEl.videoHeight) return null;
    const vw = videoEl.videoWidth, vh = videoEl.videoHeight;
    const scale = Math.min(1, maxSide / Math.max(vw, vh));
    const w = Math.max(1, Math.round(vw * scale)), h = Math.max(1, Math.round(vh * scale));
    if (!canvas) { canvas = canvasFactory(); canvasCtx = canvas.getContext('2d', { alpha: false }); }
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    const captureTsMs = clock.nowMs(); // before drawImage + JPEG encode
    canvasCtx.drawImage(videoEl, 0, 0, w, h);
    let blob;
    if (typeof canvas.toBlob === 'function') {
      blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
    } else if (typeof canvas.convertToBlob === 'function') {
      blob = await canvas.convertToBlob({ type: 'image/jpeg', quality });
    }
    if (!blob) return null;
    const buffer = await blob.arrayBuffer();
    return { buffer, width: w, height: h, captureTsMs };
  }

  return {
    start,
    stop,
    grabJpeg,
    onChunk: chunkListeners.on,
    onLevel: levelListeners.on,
    onState: stateListeners.on,
    onEnded: endedListeners.on,
    get state() { return snapshot(); },
    nowMs: () => clock.nowMs(),
  };
}
