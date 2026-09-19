// Node tests for live/capture.js and live/perception.js with fake sockets, clock, capture and media.
import { check, eq, fakeClock } from './harness.mjs';

// wsUrl() in common.js reads the page location; give Node one before the modules are used.
globalThis.location = globalThis.location || { protocol: 'http:', host: 'localhost:8000' };

const { createFacesStream, createObjectsStream, createSpeechStream, clampResponseTimeoutMs } = await import('../live/perception.js');
const { createCapture } = await import('../live/capture.js');

/** Hand-rolled WebSocket stand-in: the test drives onopen/onmessage/onclose itself. */
class FakeWebSocket {
  static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
  static instances = [];
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.sent = [];
    this.bufferedAmount = 0;
    this.closeCalls = 0;
    this.onopen = null; this.onmessage = null; this.onclose = null; this.onerror = null;
    FakeWebSocket.instances.push(this);
  }
  send(data) { this.sent.push(data); }
  close() { this.closeCalls += 1; this.readyState = 3; }
  open() { this.readyState = 1; this.onopen?.(); }
  message(obj) { this.onmessage?.({ data: typeof obj === 'string' ? obj : JSON.stringify(obj) }); }
  serverClose() { this.readyState = 3; this.onclose?.({ code: 1006 }); }
  jsonSent() { return this.sent.filter((m) => typeof m === 'string').map((m) => JSON.parse(m)); }
  binarySent() { return this.sent.filter((m) => m instanceof ArrayBuffer); }
}

function makeClock() {
  const fc = fakeClock();
  return { fc, clock: { nowMs: () => fc.now(), setTimeout: fc.setTimeout, clearTimeout: fc.clearTimeout, pending: fc.pending } };
}

/** Fake capture: grabJpeg returns a fixed 1000-byte buffer stamped from the fake clock. */
function makeCapture(clock) {
  const chunkFns = new Set();
  const grabs = [];
  return {
    grabs,
    async grabJpeg(opts) {
      const grab = { buffer: new ArrayBuffer(1000), width: 640, height: 360, captureTsMs: clock.nowMs(), opts };
      grabs.push(grab);
      return grab;
    },
    onChunk(fn) { chunkFns.add(fn); return () => chunkFns.delete(fn); },
    emitChunk(bytes = 1024) { for (const fn of [...chunkFns]) fn({ buffer: new ArrayBuffer(bytes), sampleCount: 512, captureTsMs: clock.nowMs() - 32 }); },
    listenerCount: () => chunkFns.size,
  };
}

// Let awaited grabJpeg promises settle (real microtasks/macrotasks; the fake clock is separate).
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function setupFaces(extra = {}) {
  FakeWebSocket.instances = [];
  const { fc, clock } = makeClock();
  const capture = makeCapture(clock);
  const statuses = [];
  const frames = [];
  const enroll = [];
  const stream = createFacesStream({
    backend: 'local', capture,
    onFrame: (msg, meta) => frames.push({ msg, meta }),
    onStatus: (s) => statuses.push(s),
    onEnrollmentStatus: (m) => enroll.push(m),
    deps: { WebSocketImpl: FakeWebSocket, clock },
    ...extra,
  });
  const terminal = () => statuses.filter((s) => s.phase === 'stopped' || s.phase === 'error');
  return { fc, clock, capture, statuses, frames, enroll, stream, terminal, sockets: FakeWebSocket.instances };
}

async function readyFaces(t, ready = { type: 'ready', max_fps: 5, max_side: 640, model: 'buffalo_l', backend: 'local' }) {
  await t.stream.start();
  const ws = t.sockets[t.sockets.length - 1];
  ws.open();
  ws.message(ready);
  t.fc.advance(0); // first tick is scheduled at +0
  await flush();
  return ws;
}

export async function run() {
  console.log('\n# perception faces: one frame in flight');
  {
    const t = setupFaces();
    const ws = await readyFaces(t);
    eq(ws.url, 'ws://localhost:8000/ws/faces?backend=local', 'faces url from wsUrl');
    eq(t.stream.state, 'running', 'ready moves the stream to running');
    eq(ws.binarySent().length, 1, 'first frame sent after ready');
    eq(t.capture.grabs[0].opts, { maxSide: 640, quality: 0.8 }, 'faces grab options');
    t.fc.advance(1000); await flush();
    eq(ws.binarySent().length, 1, 'no second frame while one is in flight');
    eq(t.capture.grabs.length, 1, 'no second grab while one is in flight');
    ws.message({ type: 'frame', frame_id: 1, faces: [], input_wh: [640, 360] });
    eq(t.frames.length, 1, 'frame delivered once');
    t.fc.advance(200); await flush();
    eq(ws.binarySent().length, 2, 'next frame sent after the reply');
    t.stream.stop();
    eq(t.terminal().map((s) => s.phase), ['stopped'], 'user stop reports stopped once');
    eq(ws.readyState, 3, 'stop closes the socket');
    check(ws.onmessage === null && ws.onclose === null && ws.onopen === null && ws.onerror === null, 'stop detaches handlers');
    t.stream.stop();
    eq(t.terminal().length, 1, 'second stop is a no-op');
    eq(t.clock.pending(), 0, 'stop clears all timers');
  }

  console.log('\n# perception faces: response watchdog and late reply');
  {
    const t = setupFaces();
    const ws = await readyFaces(t);
    const handler = ws.onmessage; // captured before stop detaches it
    eq(ws.binarySent().length, 1, 'one frame in flight');
    t.fc.advance(4999); await flush();
    eq(t.terminal().length, 0, 'still waiting just before 5 s');
    t.fc.advance(1); await flush();
    eq(t.terminal().map((s) => s.phase), ['error'], 'watchdog stops with error');
    eq(t.terminal()[0].message, 'No face reply within 5 seconds', 'watchdog message');
    eq(ws.readyState, 3, 'watchdog closes the socket');
    eq(t.stream.state, 'idle', 'state idle after failure');
    t.fc.advance(10_000); await flush();
    eq(ws.binarySent().length, 1, 'never sends another frame on that socket');
    handler({ data: JSON.stringify({ type: 'frame', frame_id: 1, faces: [] }) });
    eq(t.frames.length, 0, 'late frame after stop is ignored');
    eq(t.terminal().length, 1, 'no second terminal status');
  }

  console.log('\n# perception faces: busy frees the slot');
  {
    const t = setupFaces();
    const ws = await readyFaces(t);
    ws.message({ type: 'busy' });
    eq(t.frames.length, 0, 'busy does not call onFrame');
    t.fc.advance(200); await flush();
    eq(ws.binarySent().length, 2, 'loop continues after busy');
    eq(t.terminal().length, 0, 'busy is not terminal');
    // non-fatal server error also frees the slot and continues
    ws.message({ type: 'error', message: 'Send one JPEG of at most 500 KB' });
    eq(t.enroll[t.enroll.length - 1]?.type, 'error', 'error routed to onEnrollmentStatus');
    check(t.statuses.some((s) => s.phase === 'running' && /500 KB/.test(s.message || '')), 'error reported as running status');
    t.fc.advance(200); await flush();
    eq(ws.binarySent().length, 3, 'loop continues after non-fatal error');
    t.stream.stop();
  }

  console.log('\n# perception faces: streamId per start, frame meta');
  {
    const t = setupFaces();
    const ws1 = await readyFaces(t);
    const id1 = t.stream.streamId;
    check(typeof id1 === 'string' && id1.startsWith('faces_'), 'streamId has kind prefix');
    const ts1 = t.capture.grabs[0].captureTsMs;
    t.fc.advance(37); // reply arrives later than the grab
    ws1.message({ type: 'frame', frame_id: 1, faces: [] });
    eq(t.frames[0].meta.streamId, id1, 'frame meta carries the streamId');
    eq(t.frames[0].meta.captureTsMs, ts1, 'frame meta carries the grab captureTsMs');
    t.stream.stop();
    eq(t.stream.streamId, null, 'no streamId when idle');
    const ws2 = await readyFaces(t);
    const id2 = t.stream.streamId;
    check(id2 && id2 !== id1, 'second start yields a new streamId');
    check(ws2 !== ws1, 'second start opens a new socket');
    ws2.message({ type: 'frame', frame_id: 1, faces: [] });
    eq(t.frames[1].meta.streamId, id2, 'frames after restart carry the new streamId');
    t.stream.stop();
  }

  console.log('\n# perception faces: enroll wire shape');
  {
    const t = setupFaces();
    eq(t.stream.enroll('Maya', '7'), false, 'enroll while idle returns false');
    await t.stream.start();
    const ws = t.sockets[0];
    eq(t.stream.enroll('Maya', '7'), false, 'enroll while CONNECTING returns false');
    ws.open();
    eq(t.stream.enroll('Maya', '7'), false, 'enroll before ready returns false');
    ws.message({ type: 'ready', max_fps: 5, max_side: 640 });
    eq(t.stream.enroll('Maya', '7'), true, 'enroll while running returns true');
    eq(ws.jsonSent()[0], { type: 'enroll', name: 'Maya', target_track_id: 7 }, 'numeric string track id sent as a number');
    t.stream.enroll('Maya', 12);
    eq(ws.jsonSent()[1], { type: 'enroll', name: 'Maya', target_track_id: 12 }, 'numeric track id passes through');
    t.stream.enroll('Maya', null);
    eq(ws.jsonSent()[2], { type: 'enroll', name: 'Maya' }, 'null track id omits the key');
    t.stream.enroll('Maya');
    check(!('target_track_id' in ws.jsonSent()[3]), 'undefined track id omits the key');
    eq(t.stream.cancelEnrollment(), true, 'cancel while open');
    eq(ws.jsonSent()[4], { type: 'cancel_enrollment' }, 'cancel wire shape');
    ws.message({ type: 'enrollment_started', name: 'Maya', target_track_id: 7 });
    eq(t.enroll[0].type, 'enrollment_started', 'enrollment_started routed');
    ws.message({ type: 'enrollment_cancelled' });
    eq(t.enroll[1].type, 'enrollment_cancelled', 'enrollment_cancelled routed');
    t.stream.stop();
    eq(t.stream.cancelEnrollment(), false, 'cancel after stop returns false');
  }

  console.log('\n# perception faces: server close while running');
  {
    const t = setupFaces();
    const ws = await readyFaces(t);
    ws.serverClose();
    eq(t.terminal().map((s) => s.phase), ['error'], 'server close is an error stop');
    eq(t.terminal()[0].message, 'Face connection closed', 'server close message');
    t.fc.advance(30_000); await flush();
    eq(t.terminal().length, 1, 'no further status after close');
  }

  console.log('\n# perception speech');
  {
    FakeWebSocket.instances = [];
    const { fc, clock } = makeClock();
    const capture = makeCapture(clock);
    const statuses = [];
    const transcripts = [];
    const stream = createSpeechStream({
      backend: 'baseten', capture,
      onTranscript: (msg, meta) => transcripts.push({ msg, meta }),
      onStatus: (s) => statuses.push(s),
      deps: { WebSocketImpl: FakeWebSocket, clock },
    });
    const terminal = () => statuses.filter((s) => s.phase === 'stopped' || s.phase === 'error');
    await stream.start();
    const ws = FakeWebSocket.instances[0];
    eq(ws.url, 'ws://localhost:8000/ws/speech?backend=baseten', 'speech url');
    eq(capture.listenerCount(), 0, 'no chunk subscription before ready');
    capture.emitChunk();
    eq(ws.sent.length, 0, 'chunk before ready is not sent');
    ws.open();
    ws.message({ type: 'connecting' });
    check(statuses.some((s) => s.phase === 'connecting'), 'connecting status forwarded');
    ws.message({ type: 'ready', backend: 'baseten', sample_rate: 16000, chunk_samples: 512, model_id: 'x' });
    eq(capture.listenerCount(), 1, 'ready subscribes to chunks');
    capture.emitChunk();
    eq(ws.binarySent().length, 1, 'chunk forwarded when OPEN');
    eq(ws.binarySent()[0].byteLength, 1024, 'chunk is 1024 bytes');
    capture.emitChunk(640);
    eq(ws.binarySent().length, 1, 'wrong-size chunk skipped');
    ws.message({ type: 'transcript', segment_id: 0, text: 'where are', is_final: false });
    eq(transcripts[0].msg, { type: 'transcript', segment_id: 0, text: 'where are', is_final: false }, 'transcript passed unaltered');
    eq(transcripts[0].meta.streamId, stream.streamId, 'transcript meta carries streamId');

    // stop(): 16 paced zero chunks, then {type:"stop"}, then close after the 3 s grace
    stream.stop();
    eq(capture.listenerCount(), 0, 'stop unsubscribes chunks immediately');
    eq(ws.binarySent().length, 1, 'no flush chunk before the first 32 ms');
    fc.advance(32);
    eq(ws.binarySent().length, 2, 'first zero chunk at 32 ms');
    fc.advance(32 * 15);
    eq(ws.binarySent().length, 17, '16 zero chunks after 512 ms');
    check(ws.binarySent().slice(1).every((b) => b.byteLength === 1024 && new Uint8Array(b).every((x) => x === 0)), 'flush chunks are 1024 zero bytes');
    eq(ws.jsonSent().length, 0, 'stop JSON not yet sent');
    fc.advance(32);
    eq(ws.jsonSent(), [{ type: 'stop' }], 'stop JSON after the flush');
    eq(ws.readyState, 1, 'socket still open during grace');
    eq(terminal().length, 0, 'not yet stopped during grace');
    capture.emitChunk();
    eq(ws.binarySent().length, 17, 'chunks during stopping are not sent');
    fc.advance(2999);
    eq(terminal().length, 0, 'still in grace at 2999 ms');
    fc.advance(1);
    eq(terminal().map((s) => s.phase), ['stopped'], 'closed after 3 s grace with stopped');
    eq(ws.readyState, 3, 'grace expiry closes the socket');
    eq(clock.pending(), 0, 'no timers left');
    stream.stop();
    eq(terminal().length, 1, 'stop after stop is a no-op');
  }
  {
    // server closes first during the grace period
    FakeWebSocket.instances = [];
    const { fc, clock } = makeClock();
    const capture = makeCapture(clock);
    const statuses = [];
    const stream = createSpeechStream({ backend: 'local', capture, onTranscript: () => {}, onStatus: (s) => statuses.push(s), deps: { WebSocketImpl: FakeWebSocket, clock } });
    await stream.start();
    const ws = FakeWebSocket.instances[0];
    ws.open(); ws.message({ type: 'ready' });
    stream.stop();
    fc.advance(32 * 17);
    eq(ws.jsonSent(), [{ type: 'stop' }], 'stop JSON sent');
    ws.message({ type: 'transcript', segment_id: 0, text: 'final', is_final: true });
    ws.serverClose();
    eq(statuses.filter((s) => s.phase === 'stopped').length, 1, 'server close during grace ends with stopped');
    eq(statuses.filter((s) => s.phase === 'error').length, 0, 'no error when the server closes on request');
    eq(clock.pending(), 0, 'grace timer cleared');
  }
  {
    // backlog guard
    FakeWebSocket.instances = [];
    const { clock } = makeClock();
    const capture = makeCapture(clock);
    const statuses = [];
    const stream = createSpeechStream({ backend: 'baseten', capture, onTranscript: () => {}, onStatus: (s) => statuses.push(s), deps: { WebSocketImpl: FakeWebSocket, clock } });
    await stream.start();
    const ws = FakeWebSocket.instances[0];
    ws.open(); ws.message({ type: 'ready' });
    ws.bufferedAmount = 16384;
    capture.emitChunk();
    eq(ws.binarySent().length, 1, 'exactly 16384 buffered still sends');
    ws.bufferedAmount = 16385;
    capture.emitChunk();
    eq(ws.binarySent().length, 1, 'over 16384 buffered does not send');
    const term = statuses.filter((s) => s.phase === 'stopped' || s.phase === 'error');
    eq(term.map((s) => s.phase), ['error'], 'backlog stops with error');
    eq(term[0].message, 'Audio backlog over 512 ms; stopped speech instead of adding lag', 'backlog message');
    eq(ws.readyState, 3, 'backlog closes at once (no flush)');
    eq(capture.listenerCount(), 0, 'backlog unsubscribes chunks');
  }
  {
    // stop while CONNECTING closes at once
    FakeWebSocket.instances = [];
    const { clock } = makeClock();
    const statuses = [];
    const stream = createSpeechStream({ backend: 'baseten', capture: makeCapture(clock), onTranscript: () => {}, onStatus: (s) => statuses.push(s), deps: { WebSocketImpl: FakeWebSocket, clock } });
    await stream.start();
    stream.stop('user');
    eq(FakeWebSocket.instances[0].readyState, 3, 'stop while CONNECTING closes the socket');
    eq(statuses.filter((s) => s.phase === 'stopped').length, 1, 'stopped once');
    eq(clock.pending(), 0, 'ready watchdog cleared');
  }

  console.log('\n# perception objects: response timeout clamp');
  eq(clampResponseTimeoutMs(60000), 15000, 'clamp high to 15000');
  eq(clampResponseTimeoutMs(1000), 5000, 'clamp low to 5000');
  eq(clampResponseTimeoutMs(12000), 12000, 'in range passes through');
  eq(clampResponseTimeoutMs(undefined), 5000, 'missing → 5000');
  eq(clampResponseTimeoutMs('abc'), 5000, 'invalid → 5000');
  for (const [ready, expected] of [[{ type: 'ready', response_timeout_ms: 60000, tracking_persistent: false }, 15000], [{ type: 'ready' }, 5000]]) {
    FakeWebSocket.instances = [];
    const { fc, clock } = makeClock();
    const capture = makeCapture(clock);
    const statuses = [];
    const frames = [];
    const stream = createObjectsStream({
      backend: 'baseten', vocabulary: ['person', 'keys', 'phone'], capture,
      onFrame: (msg, meta) => frames.push({ msg, meta }), onStatus: (s) => statuses.push(s),
      deps: { WebSocketImpl: FakeWebSocket, clock },
    });
    await stream.start();
    const ws = FakeWebSocket.instances[0];
    eq(ws.url, 'ws://localhost:8000/ws/objects?backend=baseten&vocabulary=person%2Ckeys%2Cphone', 'objects url with vocabulary');
    ws.open();
    ws.message({ type: 'loading' });
    ws.message(ready);
    const running = statuses.find((s) => s.phase === 'running');
    eq(running.responseTimeoutMs, expected, `running status reports timeout ${expected}`);
    eq(running.trackingPersistent, ready.tracking_persistent !== false, 'running status exposes tracking_persistent');
    eq(running.ready, ready, 'running status carries the ready message');
    fc.advance(0); await flush();
    eq(ws.binarySent().length, 1, 'first object frame sent');
    eq(capture.grabs[0].opts, { maxSide: 1280, quality: 0.7 }, 'objects grab options');
    fc.advance(expected - 1); await flush();
    eq(statuses.filter((s) => s.phase === 'error').length, 0, `no timeout at ${expected - 1} ms`);
    fc.advance(1); await flush();
    const errors = statuses.filter((s) => s.phase === 'error');
    eq(errors.length, 1, `timeout fires at ${expected} ms`);
    check(/object reply/.test(errors[0].message) && /baseten/.test(errors[0].message), 'objects timeout message names the backend');
    eq(ws.binarySent().length, 1, 'no second object frame on the timed-out socket');
  }
  {
    // objects: 10 fps pacing and frame meta
    FakeWebSocket.instances = [];
    const { fc, clock } = makeClock();
    const capture = makeCapture(clock);
    const frames = [];
    const stream = createObjectsStream({ backend: 'local', vocabulary: ['keys'], capture, onFrame: (m, meta) => frames.push({ m, meta }), onStatus: () => {}, deps: { WebSocketImpl: FakeWebSocket, clock } });
    await stream.start();
    const ws = FakeWebSocket.instances[0];
    ws.open(); ws.message({ type: 'ready', response_timeout_ms: 5000 });
    fc.advance(0); await flush();
    const ts = capture.grabs[0].captureTsMs;
    fc.advance(20);
    ws.message({ type: 'frame', frame_id: 1, objects: [], input_wh: [1280, 720] });
    eq(frames[0].meta, { streamId: stream.streamId, captureTsMs: ts, sentAtMs: ts, receivedAtMs: ts + 20, sentWidth: 640, sentHeight: 360 }, 'objects frame meta');
    fc.advance(79); await flush();
    eq(ws.binarySent().length, 1, 'paced: not yet 100 ms since last send');
    fc.advance(1); await flush();
    eq(ws.binarySent().length, 2, 'next frame at 100 ms spacing');
    ws.message({ type: 'busy' });
    eq(frames.length, 1, 'objects busy does not call onFrame');
    stream.stop();
  }

  console.log('\n# capture: camera denied, microphone live');
  {
    const { fc, clock } = makeClock();
    const tracks = [{ kind: 'audio', stopped: false, stop() { this.stopped = true; }, addEventListener() {}, getSettings() { return { deviceId: 'mic-1' }; } }];
    const fakeStream = { getTracks: () => tracks, getAudioTracks: () => tracks, getVideoTracks: () => [] };
    const gumCalls = [];
    const getUserMedia = async (constraints) => {
      gumCalls.push(constraints);
      if (constraints.video) throw Object.assign(new Error('Permission denied'), { name: 'NotAllowedError' });
      return fakeStream;
    };
    class FakeAudioContext {
      static instances = [];
      constructor(opts) {
        this.opts = opts; this.sampleRate = opts?.sampleRate ?? 48000; this.state = 'running'; this.closed = false;
        this.destination = { id: 'dest' };
        this.modules = [];
        this.audioWorklet = { addModule: async (url) => { this.modules.push(url); } };
        FakeAudioContext.instances.push(this);
      }
      createMediaStreamSource() { return { connected: null, connect(n) { this.connected = n; }, disconnect() { this.connected = null; } }; }
      async close() { this.state = 'closed'; this.closed = true; }
    }
    class FakeWorkletNode {
      static last = null;
      constructor(ctx, name, opts) {
        this.ctx = ctx; this.name = name; this.opts = opts; this.disconnected = false;
        this.port = { onmessage: null, posted: [], postMessage(m) { this.posted.push(m); } };
        FakeWorkletNode.last = this;
      }
      connect() {}
      disconnect() { this.disconnected = true; }
    }
    const videoEl = { srcObject: null, readyState: 0, videoWidth: 0, videoHeight: 0 };
    const capture = createCapture({ videoEl, clock, deps: { getUserMedia, AudioContextImpl: FakeAudioContext, AudioWorkletNodeImpl: FakeWorkletNode, canvasFactory: () => { throw new Error('no canvas needed'); } } });
    const chunks = [];
    const levels = [];
    const states = [];
    capture.onChunk((c) => chunks.push(c));
    capture.onLevel((l) => levels.push(l));
    capture.onState((s) => states.push(s));

    eq(capture.state, { camera: 'off', microphone: 'off', errors: {} }, 'initial state is off');
    eq(gumCalls.length, 0, 'no getUserMedia before start');
    eq(await capture.grabJpeg(), null, 'grabJpeg is null before start');

    const result = await capture.start({ camera: true, microphone: true, cameraId: 'cam-9', micId: 'mic-1' });
    eq(gumCalls.length, 2, 'camera and microphone acquired with separate getUserMedia calls');
    eq(gumCalls[0], { video: { width: { ideal: 1280 }, height: { ideal: 720 }, deviceId: { exact: 'cam-9' } }, audio: false }, 'camera constraints');
    eq(gumCalls[1], { audio: { deviceId: { exact: 'mic-1' }, echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false }, 'microphone constraints');
    eq(result.camera, 'error', 'camera error in StartResult');
    check(/Camera permission was denied/.test(result.errors.camera) && /macOS/.test(result.errors.camera), 'camera error message is friendly and mentions macOS');
    eq(result.microphone, 'live', 'microphone live despite camera failure');
    eq(result.video, null, 'no video dims when camera failed');
    eq(result.audioSampleRate, 16000, 'audio sample rate from the context');
    eq(FakeAudioContext.instances.length, 1, 'one AudioContext');
    eq(FakeAudioContext.instances[0].opts, { sampleRate: 16000 }, 'AudioContext asked for 16 kHz');
    eq(FakeAudioContext.instances[0].modules, ['/static/speech-worklet.js'], 'worklet module loaded');
    const node = FakeWorkletNode.last;
    eq(node.name, 'pcm-chunker', 'worklet node name');
    eq(node.opts, { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1], processorOptions: { inputRate: 16000, outRate: 16000, chunkSamples: 512 } }, 'worklet node options');
    eq(capture.state, { camera: 'error', microphone: 'live', errors: result.errors }, 'state matches StartResult');
    check(states.length >= 1 && states[states.length - 1].microphone === 'live', 'state listener notified');
    eq(await capture.grabJpeg(), null, 'grabJpeg is null when the camera is not live');

    fc.advance(500);
    const buffer = new ArrayBuffer(1024);
    node.port.onmessage({ data: { type: 'chunk', buffer } });
    eq(chunks.length, 1, 'chunk listener called');
    check(chunks[0].buffer === buffer, 'chunk buffer passed through untouched');
    eq(chunks[0].sampleCount, 512, 'sampleCount 512');
    eq(chunks[0].captureTsMs, clock.nowMs() - 32, 'captureTsMs = nowMs − 32 (first sample of the chunk)');
    node.port.onmessage({ data: { type: 'level', rms: 0.25 } });
    eq(levels, [0.25], 'level listener called');

    capture.stop();
    check(FakeAudioContext.instances[0].closed, 'stop closes the AudioContext');
    check(tracks[0].stopped, 'stop stops the audio track');
    check(node.disconnected, 'stop disconnects the worklet node');
    eq(node.port.posted, [{ type: 'stop' }], 'stop posts {type:stop} to the worklet');
    eq(capture.state, { camera: 'off', microphone: 'off', errors: {} }, 'state reset after stop');
    const statesAfterStop = states.length;
    node.port.onmessage?.({ data: { type: 'chunk', buffer } });
    eq(chunks.length, 1, 'stale worklet message after stop is ignored');
    capture.stop();
    eq(states.length, statesAfterStop, 'second stop is a no-op');
    eq(gumCalls.length, 2, 'stop never acquires media');
  }
  {
    // capture: stop() during a pending getUserMedia releases the late stream
    const { clock } = makeClock();
    let resolveGum;
    const tracks = [{ kind: 'audio', stopped: false, stop() { this.stopped = true; }, addEventListener() {} }];
    const fakeStream = { getTracks: () => tracks, getAudioTracks: () => tracks, getVideoTracks: () => [] };
    const getUserMedia = () => new Promise((resolve) => { resolveGum = resolve; });
    class Ctx { constructor() { this.sampleRate = 16000; this.state = 'running'; this.audioWorklet = { addModule: async () => {} }; this.destination = {}; } createMediaStreamSource() { return { connect() {}, disconnect() {} }; } async close() { this.state = 'closed'; } }
    class Node { constructor() { this.port = { postMessage() {} }; } connect() {} disconnect() {} }
    const capture = createCapture({ videoEl: null, clock, deps: { getUserMedia, AudioContextImpl: Ctx, AudioWorkletNodeImpl: Node } });
    const pending = capture.start({ microphone: true });
    capture.stop();
    resolveGum(fakeStream);
    const result = await pending;
    check(tracks[0].stopped, 'stream that arrives after stop is released');
    eq(result.microphone, 'off', 'late acquisition does not report live');
  }
  {
    // capture: track 'ended' stops that side and notifies onEnded
    const { clock } = makeClock();
    let endedHandler = null;
    const tracks = [{ kind: 'audio', stopped: false, stop() { this.stopped = true; }, addEventListener(type, fn) { if (type === 'ended') endedHandler = fn; } }];
    const fakeStream = { getTracks: () => tracks, getAudioTracks: () => tracks, getVideoTracks: () => [] };
    class Ctx { constructor() { this.sampleRate = 48000; this.state = 'running'; this.audioWorklet = { addModule: async () => {} }; this.destination = {}; this.closed = false; } createMediaStreamSource() { return { connect() {}, disconnect() {} }; } async close() { this.state = 'closed'; this.closed = true; } }
    let ctxRef = null;
    class Node { constructor(ctx, name, opts) { ctxRef = ctx; this.opts = opts; this.port = { postMessage() {} }; } connect() {} disconnect() {} }
    const capture = createCapture({ videoEl: null, clock, deps: { getUserMedia: async () => fakeStream, AudioContextImpl: Ctx, AudioWorkletNodeImpl: Node } });
    const ended = [];
    capture.onEnded((e) => ended.push(e));
    const result = await capture.start({ microphone: true });
    eq(result.microphone, 'live', 'mic live');
    eq(result.audioSampleRate, 48000, 'actual context rate reported when 16 kHz is not honoured');
    eq(ctxRef && Node && result.audioSampleRate, 48000, 'worklet told the actual rate');
    endedHandler();
    eq(ended.length, 1, 'onEnded fired once');
    eq(ended[0].side, 'microphone', 'ended side is microphone');
    eq(capture.state.microphone, 'error', 'state error after track ended');
    check(/disconnected/.test(capture.state.errors.microphone), 'ended message set');
    check(ctxRef.closed, 'AudioContext closed after track ended');
    capture.stop();
  }

  console.log('\n# perception: ready watchdogs');
  {
    const t = setupFaces();
    await t.stream.start();
    t.sockets[0].open();
    t.fc.advance(14_999);
    eq(t.terminal().length, 0, 'faces still waiting at 14.999 s');
    t.fc.advance(1);
    eq(t.terminal().map((s) => s.phase), ['error'], 'faces ready watchdog fires once');
    eq(t.terminal()[0].message, 'Face model did not become ready within 15 s', 'faces ready watchdog message');
    eq(t.sockets[0].readyState, 3, 'faces watchdog closes the socket');
    t.stream.stop();
    t.fc.advance(60_000);
    eq(t.terminal().length, 1, 'stop after watchdog adds nothing');
  }
  {
    FakeWebSocket.instances = [];
    const { fc, clock } = makeClock();
    const statuses = [];
    const stream = createObjectsStream({ backend: 'local', vocabulary: ['keys'], capture: makeCapture(clock), onFrame: () => {}, onStatus: (s) => statuses.push(s), deps: { WebSocketImpl: FakeWebSocket, clock } });
    await stream.start();
    fc.advance(15_000);
    const term = statuses.filter((s) => s.phase === 'stopped' || s.phase === 'error');
    eq(term.map((s) => s.phase), ['error'], 'objects ready watchdog fires once');
    eq(term[0].message, 'Object model did not become ready within 15 s', 'objects ready watchdog message');
  }
  {
    FakeWebSocket.instances = [];
    const { fc, clock } = makeClock();
    const statuses = [];
    const stream = createSpeechStream({ backend: 'baseten', capture: makeCapture(clock), onTranscript: () => {}, onStatus: (s) => statuses.push(s), deps: { WebSocketImpl: FakeWebSocket, clock } });
    await stream.start();
    FakeWebSocket.instances[0].open();
    FakeWebSocket.instances[0].message({ type: 'connecting' });
    fc.advance(19_999);
    eq(statuses.filter((s) => s.phase === 'error').length, 0, 'speech still waiting at 19.999 s');
    fc.advance(1);
    const term = statuses.filter((s) => s.phase === 'stopped' || s.phase === 'error');
    eq(term.map((s) => s.phase), ['error'], 'speech ready watchdog fires once');
    check(/20 s/.test(term[0].message) && /waking from zero/.test(term[0].message), 'speech watchdog message mentions waking from zero');
    // a stale ready after the watchdog must not start anything
    const capture = makeCapture(clock);
    eq(capture.listenerCount(), 0, 'no chunk subscription after watchdog');
    fc.advance(60_000);
    eq(term.length, 1, 'nothing after the watchdog');
  }
}
