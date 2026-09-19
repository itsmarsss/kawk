import { check, eq, fakeClock } from './harness.mjs';
import { createV1Provider, encodeMedia, MEDIA_JPEG, MEDIA_PCM, SESSION_KEY, normalizeDecisionStatus } from '../live/v1_provider.js';
import { validateEnvelope } from '../contracts/envelope.js';

class FakeWS {
  static instances = [];
  constructor(url) { this.url = url; this.readyState = 0; this.sent = []; this.bufferedAmount = 0; FakeWS.instances.push(this); }
  send(data) { if (this.readyState !== 1) throw new Error('not open'); this.sent.push(data); }
  close() { this.readyState = 3; this.onclose?.({ reason: 'client' }); }
  open() { this.readyState = 1; this.onopen?.(); }
  message(obj) { this.onmessage?.({ data: JSON.stringify(obj) }); }
  serverClose(reason) { this.readyState = 3; this.onclose?.({ reason }); }
  json() { return this.sent.filter((d) => typeof d === 'string').map((d) => JSON.parse(d)); }
  binary() { return this.sent.filter((d) => typeof d !== 'string'); }
}

function fakeFetch(behaviour) {
  const calls = [];
  const f = async (url, init = {}) => {
    calls.push({ url, method: init.method ?? 'GET' });
    return behaviour(url, init.method ?? 'GET');
  };
  f.calls = calls;
  return f;
}
const json = (status, body) => ({ ok: status < 300, status, json: async () => body });
const SNAP = (sid) => ({ schema_version: '1.0', session_id: sid, status: null, profiles: [], notes: [], encounters: [], reminders: [], moments: [], display: null });

function fakeCapture(clock) {
  const chunkListeners = new Set();
  let jpegBytes = 1000;
  const endedListeners = new Set();
  // Models capture.js ownership: each start() is a session; a superseded session releases only its own
  // tracks and leaves the current session untouched. `tracks` lists live track ids per session.
  let session = 0;
  const cap = {
    state: { camera: 'off', microphone: 'off', errors: {} },
    started: [], stopped: 0, deferStart: false, pendingStart: null, tracks: {}, selfReleased: 0, current: 0,
    async start(opts) {
      const mine = ++session; cap.current = mine;
      cap.started.push(opts);
      if (cap.deferStart) await new Promise((res) => { cap.pendingStart = res; });
      if (cap.current !== mine) { cap.selfReleased += 1; return { camera: 'off', microphone: 'off', errors: {}, video: null, audioSampleRate: null }; }
      cap.tracks[mine] = ['cam', 'mic'];
      cap.state = { camera: opts.camera ? 'live' : 'off', microphone: opts.microphone ? 'live' : 'off', errors: {} };
      return { ...cap.state, video: { width: 640, height: 480 }, audioSampleRate: 16000 };
    },
    liveTracks() { return Object.values(cap.tracks).flat().length; },
    endTrack(side) { for (const fn of endedListeners) fn({ side, message: `${side} disconnected (track ended).` }); },
    stop() { cap.stopped += 1; cap.current = 0; cap.tracks = {}; cap.state = { camera: 'off', microphone: 'off', errors: {} }; },
    async grabJpeg() { return cap.state.camera === 'live' ? { buffer: new ArrayBuffer(jpegBytes), width: 640, height: 480, captureTsMs: clock.nowMs() } : null; },
    onChunk(fn) { chunkListeners.add(fn); return () => chunkListeners.delete(fn); },
    onEnded(fn) { endedListeners.add(fn); return () => endedListeners.delete(fn); }, onState() { return () => {}; },
    emitChunk(tsMs) { for (const fn of chunkListeners) fn({ buffer: new ArrayBuffer(1024), sampleCount: 512, captureTsMs: tsMs }); },
    setJpegBytes(n) { jpegBytes = n; },
    nowMs: () => clock.nowMs(),
  };
  return cap;
}

function fakeStreams() {
  const made = { faces: [], objects: [], speech: [] };
  let n = 0;
  const factory = (kind) => (opts) => {
    const s = { kind, opts, started: false, stopped: false, enrolls: [], cancels: 0, streamId: `${kind}_${++n}`,
      async start() { s.started = true; }, stop() { s.stopped = true; opts.onStatus({ phase: 'stopped' }); },
      enroll(name, target) { s.enrolls.push([name, target]); return true; }, cancelEnrollment() { s.cancels += 1; },
      running() { opts.onStatus({ phase: 'running', ready: { max_fps: 5 } }); } };
    made[kind].push(s);
    return s;
  };
  return { made, streams: { faces: factory('faces'), objects: factory('objects'), speech: factory('speech') } };
}

function rig({ stored = null, fetchBehaviour } = {}) {
  FakeWS.instances = [];
  const base = fakeClock();
  const clock = { nowMs: () => base.now() - Date.parse('2026-09-19T14:00:00.000Z'), now: base.now, setTimeout: base.setTimeout, clearTimeout: base.clearTimeout, advance: base.advance, pending: base.pending };
  const storage = new Map([[SESSION_KEY, stored]].filter(([, v]) => v));
  const sessionStorage = { getItem: (k) => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, v), removeItem: (k) => storage.delete(k) };
  const fetchImpl = fakeFetch(fetchBehaviour ?? ((url, method) => {
    if (method === 'POST') return json(200, { session_id: 'sid_new', snapshot: SNAP('sid_new'), websocket_url: '/ws/v1/sid_new', limits: { jpeg_max_bytes: 5000, clip_fps: 5 } });
    if (method === 'DELETE') return json(200, { deleted: true });
    return url.endsWith('sid_old') ? json(200, SNAP('sid_old')) : json(404, { detail: 'expired' });
  }));
  const capture = fakeCapture(clock);
  const { made, streams } = fakeStreams();
  const provider = createV1Provider({ getState: () => ({}), capture, streams, deps: { fetchImpl, WebSocketImpl: FakeWS, clock, sessionStorage, location: { protocol: 'http:', host: 'h' } } });
  const events = []; provider.subscribe((e) => events.push(e));
  const notices = []; provider.onNotice((n) => notices.push(n));
  return { provider, clock, storage, fetchImpl, capture, made, events, notices, ws: () => FakeWS.instances.at(-1) };
}

async function connected(r) {
  await r.provider.getSnapshot();
  await r.provider.start();
  const w = r.ws(); w.open();
  w.message({ type: 'v1.ack', receipt: { hello: true } });
  return w;
}

const SETTINGS = { camera: true, microphone: true, faces: { enabled: true, backend: 'local' }, objects: { enabled: true, backend: 'local', vocabulary: ['keys'] }, speech: { enabled: true, backend: 'baseten' } };

export async function run() {
  console.log('\n# v1 provider: session mapping');
  {
    const r = rig();
    const snap = await r.provider.getSnapshot();
    eq(snap.session_id, 'sid_new', 'no stored id → POST creates a session');
    eq(r.storage.get(SESSION_KEY), 'sid_new', 'session id kept in sessionStorage');
    eq(r.provider.sessionId, 'sid_new', 'provider exposes the session id');
    eq(r.provider.limits.jpeg_max_bytes, 5000, 'limits taken from the server');
    const r2 = rig({ stored: 'sid_old' });
    const snap2 = await r2.provider.getSnapshot();
    eq(snap2.session_id, 'sid_old', 'stored id resumes via GET');
    eq(r2.fetchImpl.calls.map((c) => c.method), ['GET'], 'no POST when resume succeeds');
    const r3 = rig({ stored: 'sid_gone' });
    const snap3 = await r3.provider.getSnapshot();
    eq(snap3.session_id, 'sid_new', '404 on resume → new session');
    eq(r3.storage.get(SESSION_KEY), 'sid_new', 'stale id replaced');
  }

  console.log('\n# v1 provider: control connection, hello, ack/error, ping');
  {
    const r = rig();
    await r.provider.getSnapshot();
    await r.provider.start();
    const w = r.ws();
    check(w.url.endsWith('/ws/v1/sid_new'), 'control socket targets the session');
    await r.provider.dispatch({ type: 'ask', payload: { text: 'x' } }).then(() => check(false, 'should reject'), () => check(true, 'dispatch before connection rejects'));
    w.open();
    const first = w.json()[0];
    eq(first.type, 'hello', 'hello is the first message');
    eq(first.device_ts_ms, r.clock.nowMs() % 2 ** 32, 'hello carries the monotonic capture clock');
    eq(r.provider.getLiveStatus().session, 'connecting', 'not connected until the hello ack');
    const snaps = []; r.provider.onSnapshot((sn) => snaps.push(sn));
    w.message({ type: 'v1.ack', receipt: { hello: true }, snapshot: SNAP('sid_new') });
    eq(r.provider.getLiveStatus().session, 'connected', 'hello ack → connected');
    eq(snaps.length, 1, 'hello snapshot surfaced for re-hydration');
    eq(snaps[0].session_id, 'sid_new', 'snapshot is the session snapshot');
    const p = r.provider.dispatch({ type: 'ask', payload: { text: 'where are my keys' } });
    const cmd = w.json().at(-1);
    eq(cmd.type, 'command', 'commands wrapped');
    eq(cmd.command, { type: 'ask', payload: { text: 'where are my keys' } }, 'command body preserved');
    check(typeof cmd.request_id === 'string', 'request_id attached');
    w.message({ type: 'v1.ack', request_id: cmd.request_id, receipt: { ok: true, answer: { kind: 'unsupported' } } });
    eq((await p).ok, true, 'ack resolves the dispatch with the receipt');
    const p2 = r.provider.dispatch({ type: 'moment.mark', payload: {} });
    const cmd2 = w.json().at(-1);
    w.message({ type: 'v1.error', request_id: cmd2.request_id, message: 'Start the camera before marking a moment' });
    await p2.then(() => check(false, 'should reject'), (err) => check(/Start the camera/.test(err.message), 'v1.error with request_id rejects the dispatch'));
    w.message({ type: 'v1.error', message: 'UI fell behind' });
    eq(r.notices.at(-1)?.message, 'UI fell behind', 'unsolicited v1.error becomes a notice');
    w.message({ type: 'v1.pong' });
    const env = { schema_version: '1.0', event_id: 'sid_new:1', session_id: 'sid_new', seq: 1, occurred_at: '2026-09-19T14:00:01.000Z', type: 'scene.changed', payload: { scene: { kind: 'idle', caption: 'Nothing in view' } } };
    w.message(env);
    eq(r.events.length, 1, 'only envelopes reach subscribers (ack/error/pong do not)');
    check(validateEnvelope(r.events[0]).ok, 'forwarded envelope is unchanged and valid');
    r.clock.advance(20_000);
    check(w.json().some((m) => m.type === 'ping'), 'ping sent after 20 s idle');
    await r.provider.dispatch({ type: 'demo.run_scenario', payload: { scenario: 'x' } }).then(() => check(false, 'demo should be rejected'), () => check(true, 'demo commands rejected in live mode'));
  }

  console.log('\n# v1 provider: capture start, stream ids, perception + media forwarding');
  {
    const r = rig();
    const w = await connected(r);
    const started = r.provider.startCapture(SETTINGS);
    await Promise.resolve(); await Promise.resolve();
    const capCmd = w.json().find((m) => m.type === 'command' && m.command.type === 'capture.status');
    eq(capCmd.command.payload, { camera: 'live', microphone: 'live' }, 'capture.status live/live sent after acquisition');
    w.message({ type: 'v1.ack', request_id: capCmd.request_id, receipt: { ok: true } });
    await started;
    eq(r.capture.started[0].camera, true, 'capture.start asked for the camera');
    eq(r.made.faces.length + r.made.objects.length + r.made.speech.length, 3, 'three perception streams created');
    const faces = r.made.faces[0];
    faces.running();
    const st = w.json().find((m) => m.type === 'stream.state' && m.kind === 'faces');
    eq(st, { type: 'stream.state', kind: 'faces', available: true, stream_id: faces.streamId }, 'stream.state true with the stream id');
    faces.opts.onFrame({ type: 'frame', frame_id: 3, faces: [], detected_count: 0 }, { streamId: faces.streamId, captureTsMs: 1234 });
    const pf = w.json().find((m) => m.type === 'perception.faces');
    eq(pf.stream_id, faces.streamId, 'perception frame carries the stream id');
    eq(pf.capture_ts_ms, 1234, 'perception frame carries the capture timestamp');
    eq(pf.data.frame_id, 3, 'frame data forwarded untouched');
    r.made.speech[0].running();
    r.made.speech[0].opts.onTranscript({ type: 'transcript', segment_id: '0', text: 'hi', is_final: false }, { streamId: r.made.speech[0].streamId });
    eq(w.json().find((m) => m.type === 'perception.speech').data.segment_id, '0', 'transcript forwarded with segment identity');
    faces.opts.onEnrollmentStatus({ type: 'enrollment_started', name: 'Maya' });
    eq(w.json().find((m) => m.type === 'enrollment.status')?.stream_id, faces.streamId, 'enrollment status forwarded with stream id');
    // media
    r.clock.advance(1);
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    eq(w.binary().length, 1, 'first JPEG sent');
    const hdr = new DataView(w.binary()[0]);
    eq(hdr.getUint8(0), MEDIA_JPEG, 'type byte 0x01');
    eq(hdr.getUint16(2, true), 1, 'seq 1');
    eq(hdr.getUint32(4, true), 0, 'capture ts is the grab time (t=0), not the send time');
    eq(w.binary()[0].byteLength, 1008, 'header + payload');
    r.clock.advance(400); await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    eq(w.binary().length, 1, 'no second JPEG until frame_ack (one in flight)');
    w.message({ type: 'v1.frame_ack', seq: 1, accepted: true });
    r.clock.advance(200); await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    eq(w.binary().length, 2, 'next JPEG after frame_ack');
    eq(r.provider.getLiveStatus().media.frames_sent, 1, 'accepted frames counted');
    w.message({ type: 'v1.frame_ack', seq: 2, accepted: false });
    eq(r.provider.getLiveStatus().media.frames_rejected, 1, 'rejected frames counted, slot freed');
    r.capture.setJpegBytes(6000);
    r.clock.advance(200); await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    eq(w.binary().length, 2, 'oversized JPEG (over limits.jpeg_max_bytes) not sent');
    eq(r.provider.getLiveStatus().media.frames_dropped, 1, 'oversized counted as dropped');
    r.capture.setJpegBytes(1000);
    r.capture.emitChunk(777);
    const pcm = w.binary().at(-1); const ph = new DataView(pcm);
    eq(ph.getUint8(0), MEDIA_PCM, 'audio type 0x02');
    eq(ph.getUint32(4, true), 777, 'audio ts = first sample time from capture');
    eq(pcm.byteLength, 1032, '8 + 1024 bytes');
    // control forwarding
    w.message({ type: 'v1.control', control: { type: 'enroll', name: 'Maya', target_track_id: '7', session_id: 'sid_new' } });
    eq(faces.enrolls, [['Maya', '7']], 'enroll forwarded to the current faces stream');
    w.message({ type: 'v1.control', control: { type: 'cancel_enrollment', session_id: 'sid_new' } });
    eq(faces.cancels, 1, 'cancel forwarded');
    // stop capture keeps the session
    r.provider.stopCapture();
    check(faces.stopped && r.made.objects[0].stopped && r.made.speech[0].stopped, 'all streams stopped');
    eq(r.capture.stopped, 1, 'capture released');
    const offs = w.json().filter((m) => m.type === 'stream.state' && m.available === false).map((m) => m.kind).sort();
    eq(offs, ['faces', 'objects', 'speech'], 'stream.state false for every stream');
    const last = w.json().filter((m) => m.type === 'command').at(-1);
    eq(last.command.payload, { camera: 'off', microphone: 'off' }, 'capture.status off/off after stop');
    eq(w.readyState, 1, 'control socket stays open after Stop');
    eq(r.provider.getLiveStatus().session, 'connected', 'session still connected for CRUD');
    // enroll control with no faces stream → error status back
    w.message({ type: 'v1.control', control: { type: 'enroll', name: 'X', target_track_id: '1', session_id: 'sid_new' } });
    const es = w.json().filter((m) => m.type === 'enrollment.status').at(-1);
    eq(es.data.type, 'error', 'control failure reported as enrollment.status error');
  }

  console.log('\n# v1 provider: connection loss, stop, reset');
  {
    const r = rig();
    const w = await connected(r);
    const started = r.provider.startCapture({ ...SETTINGS, microphone: false, speech: { enabled: false } });
    await Promise.resolve(); await Promise.resolve();
    const capCmd = w.json().find((m) => m.type === 'command' && m.command.type === 'capture.status');
    eq(capCmd.command.payload, { camera: 'live', microphone: 'off' }, 'microphone disabled independently');
    w.message({ type: 'v1.ack', request_id: capCmd.request_id, receipt: { ok: true } });
    await started;
    eq(r.made.speech.length, 0, 'no speech stream without a microphone');
    w.serverClose('gone');
    eq(r.provider.capturing, false, 'capture stops when the control connection drops');
    eq(r.capture.stopped, 1, 'devices released');
    check(r.notices.some((n) => /capture stopped/i.test(n.message)), 'user told why capture stopped');
    check(r.clock.pending() > 0, 'reconnect scheduled');
    r.clock.advance(600);
    check(FakeWS.instances.length === 2, 'reconnected with a new socket');
    const w2 = r.ws(); w2.open();
    eq(w2.json()[0].type, 'hello', 'hello re-sent on the new socket');
    await r.provider.stop();
    eq(r.clock.pending(), 0, 'stop cancels every timer');
    eq(w2.readyState, 3, 'stop closes the control socket');
    await r.provider.destroySession();
    check(r.fetchImpl.calls.some((c) => c.method === 'DELETE' && c.url.endsWith('sid_new')), 'reset deletes the temporary session');
    eq(r.storage.get(SESSION_KEY), undefined, 'session id cleared');
    eq(r.provider.sessionId, 'live_unbound', 'provider unbound after reset');
  }

  console.log('\n# media header');
  {
    const buf = encodeMedia(MEDIA_JPEG, 70000, 2 ** 32 + 5, new Uint8Array([9, 8]).buffer);
    const v = new DataView(buf);
    eq(v.getUint16(2, true), 70000 & 0xffff, 'seq wraps to u16');
    eq(v.getUint32(4, true), 5, 'timestamp wraps modulo 2^32');
    eq(new Uint8Array(buf).slice(8), new Uint8Array([9, 8]), 'payload follows the 8-byte header');
  }

  console.log('\n# v1 provider: generation-safe start (cancel during getUserMedia / ack / connection loss)');
  {
    const tickAll = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };
    // (a) Stop while getUserMedia is pending
    const r = rig();
    const w = await connected(r);
    r.capture.deferStart = true;
    const p = r.provider.startCapture(SETTINGS);
    await tickAll();
    eq(r.provider.starting, true, 'starting flag set while permission pending');
    eq(r.provider.getLiveStatus().starting, true, 'status exposes starting (UI shows Cancel)');
    r.provider.stopCapture();               // user pressed Cancel
    eq(r.provider.starting, false, 'cancel clears starting');
    r.capture.pendingStart();               // browser finally grants permission
    await p.then(() => check(false, 'should reject'), (err) => eq(err.message, 'cancelled', 'late getUserMedia result is discarded as cancelled'));
    eq(r.capture.stopped >= 1, true, 'late tracks released immediately');
    eq(r.provider.capturing, false, 'no capture started');
    eq(w.json().filter((m) => m.type === 'command' && m.command.type === 'capture.status' && m.command.payload.camera === 'live').length, 0, 'no capture.status live sent for a cancelled start');
    eq(r.made.faces.length, 0, 'no perception streams created');
    r.clock.advance(5000); await tickAll();
    eq(w.binary().length, 0, 'no media ever sent after a cancelled start');
    // (b) Stop while waiting for the capture.status ack
    const r2 = rig();
    const w2 = await connected(r2);
    const p2 = r2.provider.startCapture(SETTINGS);
    await tickAll();
    const cmd = w2.json().find((m) => m.type === 'command' && m.command.type === 'capture.status');
    check(cmd, 'capture.status live sent, ack pending');
    r2.provider.stopCapture();
    w2.message({ type: 'v1.ack', request_id: cmd.request_id, receipt: { ok: true } });
    await p2.then(() => check(false, 'should reject'), (err) => eq(err.message, 'cancelled', 'late ack does not start capture'));
    eq(r2.provider.capturing, false, 'not capturing after late ack');
    eq(r2.made.faces.length + r2.made.objects.length + r2.made.speech.length, 0, 'no streams after late ack');
    const offs = w2.json().filter((m) => m.type === 'command' && m.command.type === 'capture.status').map((m) => m.command.payload.camera);
    eq(offs.at(-1), 'off', 'server told capture is off after the cancelled start');
    // (c) connection loss during pending start
    const r3 = rig();
    const w3 = await connected(r3);
    r3.capture.deferStart = true;
    const p3 = r3.provider.startCapture(SETTINGS);
    await tickAll();
    w3.serverClose('lost');
    r3.capture.pendingStart();
    await p3.then(() => check(false, 'should reject'), () => check(true, 'start rejected after connection loss'));
    eq(r3.provider.capturing, false, 'connection loss cancels a pending start');
    r3.clock.advance(60_000);
    eq(r3.provider.capturing, false, 'no late timer restarts capture');
    // (d) Start again after a cancel works normally
    const r4 = rig();
    const w4 = await connected(r4);
    r4.capture.deferStart = true;
    const p4 = r4.provider.startCapture(SETTINGS);
    await tickAll();
    r4.provider.stopCapture(); r4.capture.pendingStart(); await p4.catch(() => {});
    r4.capture.deferStart = false;
    const p5 = r4.provider.startCapture(SETTINGS);
    await tickAll();
    const cmd5 = w4.json().filter((m) => m.type === 'command' && m.command.type === 'capture.status').at(-1);
    w4.message({ type: 'v1.ack', request_id: cmd5.request_id, receipt: { ok: true } });
    await p5;
    eq(r4.provider.capturing, true, 'second Start after cancel captures');
    eq(r4.made.faces.length, 1, 'streams created exactly once');
    // late status from the cancelled run must not announce a stream
    r4.provider.stopCapture();
    const oldFaces = r4.made.faces[0];
    oldFaces.opts.onStatus({ phase: 'running' });
    check(!w4.json().slice(-1).some((m) => m.type === 'stream.state' && m.available === true), 'late running status from an old run does not announce a stream');
  }

  console.log('\n# v1 provider: track ended → bounded stop; hello snapshot before ready');
  {
    const r = rig();
    const w = await connected(r);
    const p = r.provider.startCapture(SETTINGS);
    for (let i = 0; i < 6; i++) await Promise.resolve();
    const cmd = w.json().find((m) => m.type === 'command' && m.command.type === 'capture.status');
    w.message({ type: 'v1.ack', request_id: cmd.request_id, receipt: { ok: true } });
    await p;
    r.made.faces[0].running();
    r.capture.endTrack('camera');
    eq(r.provider.capturing, false, 'track ended stops capture');
    check(r.made.faces[0].stopped, 'streams stopped on track end');
    eq(r.capture.stopped, 1, 'devices released on track end');
    const last = w.json().filter((m) => m.type === 'command' && m.command.type === 'capture.status').at(-1);
    eq(last.command.payload, { camera: 'off', microphone: 'off' }, 'server told both sides are off');
    check(r.notices.some((n) => /track ended/i.test(n.message)), 'user sees why capture stopped');
    const before = w.binary().length; r.clock.advance(5000); for (let i = 0; i < 6; i++) await Promise.resolve();
    eq(w.binary().length, before, 'no media sent after a track ended');
    const p2 = r.provider.startCapture(SETTINGS);
    for (let i = 0; i < 6; i++) await Promise.resolve();
    const cmd2 = w.json().filter((m) => m.type === 'command' && m.command.type === 'capture.status').at(-1);
    w.message({ type: 'v1.ack', request_id: cmd2.request_id, receipt: { ok: true } });
    await p2;
    eq(r.provider.capturing, true, 'Start works again after a track ended');
    // hello ordering on reconnect
    const r2 = rig();
    await r2.provider.getSnapshot(); await r2.provider.start();
    const w2 = r2.ws(); w2.open();
    const order = [];
    r2.provider.onSnapshot(() => order.push(`snapshot:${r2.provider.getLiveStatus().session}`));
    r2.provider.onLiveStatus((st) => { if (st.session === 'connected' && !order.includes('connected')) order.push('connected'); });
    w2.message({ type: 'v1.ack', receipt: { hello: true }, snapshot: SNAP('sid_new') });
    eq(order, ['snapshot:connecting', 'connected'], 'snapshot delivered before the connection is marked ready');
    w2.serverClose('blip'); r2.clock.advance(600);
    const w3 = r2.ws(); w3.open();
    const snaps = []; r2.provider.onSnapshot((sn) => snaps.push(sn));
    w3.message({ type: 'v1.ack', receipt: { hello: true }, snapshot: SNAP('sid_new') });
    eq(snaps.length, 1, 'reconnect hello snapshot delivered again');
    eq(r2.provider.capturing, false, 'reconnect never restarts capture');
  }

  console.log('\n# v1 provider: superseded start must not stop the newer capture (root QA repro)');
  {
    const tickAll = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };
    const liveCmds = (w) => w.json().filter((m) => m.type === 'command' && m.command.type === 'capture.status').map((m) => m.command.payload.camera);
    // (a) delayed getUserMedia: cancel → new Start succeeds → old promise resolves
    const r = rig();
    const w = await connected(r);
    r.capture.deferStart = true;
    const first = r.provider.startCapture(SETTINGS);
    await tickAll();
    r.provider.stopCapture();                       // Cancel start
    r.capture.deferStart = false;
    const second = r.provider.startCapture(SETTINGS);
    await tickAll();
    const ack = w.json().filter((m) => m.type === 'command' && m.command.type === 'capture.status').at(-1);
    w.message({ type: 'v1.ack', request_id: ack.request_id, receipt: { ok: true } });
    await second;
    eq(r.provider.capturing, true, 'second capture is live');
    const stopsBefore = r.capture.stopped;
    const offBefore = liveCmds(w).filter((c) => c === 'off').length;
    r.capture.pendingStart();                       // the OLD getUserMedia finally resolves
    await first.then(() => check(false, 'old start should reject'), (err) => eq(err.message, 'cancelled', 'old start rejected as cancelled'));
    await tickAll();
    eq(r.capture.stopped, stopsBefore, 'old start did NOT call the global capture.stop()');
    eq(r.capture.liveTracks(), 2, 'new camera + microphone tracks still live');
    eq(r.capture.selfReleased, 1, 'old acquisition released itself only');
    eq(r.provider.capturing, true, 'still capturing after the old promise resolved');
    eq(liveCmds(w).filter((c) => c === 'off').length, offBefore, 'no capture.status off sent for the superseded start');
    r.made.faces.at(-1).running();
    r.clock.advance(400); await tickAll();
    check(w.binary().length > 0, 'new capture keeps sending media');
    check(r.made.faces.length === 1 && !r.made.faces[0].stopped, 'new perception streams untouched');
    // (b) delayed capture.status ACK: cancel after live sent → new Start → old ACK arrives
    const r2 = rig();
    const w2 = await connected(r2);
    const p1 = r2.provider.startCapture(SETTINGS);
    await tickAll();
    const ack1 = w2.json().filter((m) => m.type === 'command' && m.command.type === 'capture.status').at(-1);
    r2.provider.stopCapture();                      // cancel while ack pending
    const p2 = r2.provider.startCapture(SETTINGS);
    await tickAll();
    const ack2 = w2.json().filter((m) => m.type === 'command' && m.command.type === 'capture.status').at(-1);
    check(ack2.request_id !== ack1.request_id, 'second start issued its own capture.status');
    w2.message({ type: 'v1.ack', request_id: ack2.request_id, receipt: { ok: true } });
    await p2;
    const stops2 = r2.capture.stopped; const off2 = liveCmds(w2).filter((c) => c === 'off').length;
    w2.message({ type: 'v1.ack', request_id: ack1.request_id, receipt: { ok: true } }); // late ack for the cancelled start
    await p1.catch(() => {});
    await tickAll();
    eq(r2.provider.capturing, true, 'late ack of a cancelled start leaves the new capture running');
    eq(r2.capture.stopped, stops2, 'late ack did not stop capture');
    eq(liveCmds(w2).filter((c) => c === 'off').length, off2, 'late ack did not send capture.status off');
    eq(r2.capture.liveTracks(), 2, 'tracks intact after late ack');
    // (c) stale stream callbacks (from a completed, then stopped generation) cannot mutate the newer stream
    const rc = rig();
    const wc = await connected(rc);
    const startAndAck = async () => {
      const pr = rc.provider.startCapture(SETTINGS);
      await tickAll();
      const a = wc.json().filter((m) => m.type === 'command' && m.command.type === 'capture.status').at(-1);
      wc.message({ type: 'v1.ack', request_id: a.request_id, receipt: { ok: true } });
      await pr;
    };
    await startAndAck();
    const oldFaces = rc.made.faces[0]; oldFaces.running();
    rc.provider.stopCapture();
    await startAndAck();
    const newFaces = rc.made.faces[1];
    check(oldFaces !== newFaces && oldFaces.stopped, 'old stream stopped, new stream created');
    newFaces.running();
    const sentBefore = wc.json().length;
    oldFaces.opts.onStatus({ phase: 'error', message: 'late failure' });
    oldFaces.opts.onStatus({ phase: 'running' });
    oldFaces.opts.onStatus({ phase: 'stopped' });
    const after = wc.json().slice(sentBefore);
    check(after.every((m) => !(m.type === 'stream.state' && m.stream_id === newFaces.streamId)), 'stale stream never reports under the new stream id');
    check(after.every((m) => !(m.type === 'stream.state' && m.available === true)), 'stale stream cannot announce availability');
    eq(rc.provider.getLiveStatus().streams.faces.phase, 'running', 'new stream status unaffected by stale callbacks');
    eq(rc.provider.getLiveStatus().streams.faces.streamId, newFaces.streamId, 'active stream id is the new one');
    check(!rc.notices.some((n) => /late failure/.test(n.message)), 'stale error not surfaced as a current notice');
    check(!newFaces.stopped && rc.provider.capturing, 'new stream and capture still running');
    // (d) old start failing after cancel does not stop the new capture
    const r3 = rig();
    const w3 = await connected(r3);
    let rejectOld; const origStart = r3.capture.start;
    r3.capture.start = (opts) => new Promise((res, rej) => { rejectOld = rej; }).then(() => origStart(opts));
    const old = r3.provider.startCapture(SETTINGS);
    await tickAll();
    r3.provider.stopCapture();
    r3.capture.start = origStart;
    const fresh = r3.provider.startCapture(SETTINGS);
    await tickAll();
    const ack3 = w3.json().filter((m) => m.type === 'command' && m.command.type === 'capture.status').at(-1);
    w3.message({ type: 'v1.ack', request_id: ack3.request_id, receipt: { ok: true } });
    await fresh;
    const stops3 = r3.capture.stopped;
    rejectOld(new Error('NotAllowedError: permission denied'));
    await old.catch(() => {});
    await tickAll();
    eq(r3.capture.stopped, stops3, 'old start failure did not stop the new capture');
    eq(r3.provider.capturing, true, 'new capture still live after old failure');
  }

  console.log('\n# v1 provider: decision status (outside envelopes, runtime only)');
  {
    eq(normalizeDecisionStatus({ backend: 'rules', phase: 'rules', model: null, message: 'V1 command and object rules; Jev is not connected' }).phase, 'rules', 'rules status accepted');
    eq(normalizeDecisionStatus({ backend: 'typesafe', phase: 'idle', model: 'jev-1.13.0', message: 'Jev waits for capture' }).model, 'jev-1.13.0', 'typesafe idle accepted');
    eq(normalizeDecisionStatus({ backend: 'openai', phase: 'ready', model: null, message: 'x' }), null, 'unknown backend ignored');
    eq(normalizeDecisionStatus({ backend: 'typesafe', phase: 'thinking', model: null, message: 'x' }), null, 'unknown phase ignored');
    eq(normalizeDecisionStatus({ backend: 'typesafe', phase: 'error', model: 'jev-1.13.0' }), null, 'missing message ignored');
    eq(normalizeDecisionStatus(null), null, 'null ignored');
    const b = normalizeDecisionStatus({ backend: 'typesafe', phase: 'backoff', model: 'jev-1.13.0', message: 'Rate limited', retry_after_s: 12.4, requires_reconfiguration: false, reason: '429', timings_ms: { request: 310, junk: 'x' }, api_key: 'should-not-pass' });
    eq(b.retry_after_s, 12.4, 'retry_after_s kept');
    eq(b.timings_ms, { request: 310 }, 'non-numeric timings dropped');
    eq('api_key' in b, false, 'unknown fields are not copied');
    const r = rig();
    const w = await connected(r);
    eq(r.provider.getLiveStatus().decision, null, 'no decision status before the server sends one');
    let seen = 0; r.provider.onLiveStatus((st) => { if (st.decision) seen += 1; });
    w.message({ type: 'v1.decision_status', status: { backend: 'typesafe', phase: 'idle', model: 'jev-1.13.0', message: 'Jev waits for capture' } });
    eq(r.provider.getLiveStatus().decision?.phase, 'idle', 'status stored on the provider runtime');
    eq(seen, 1, 'live status listeners notified');
    w.message({ type: 'v1.decision_status', status: { backend: 'typesafe', phase: 'error', model: 'jev-1.13.0', message: 'Unauthorized', requires_reconfiguration: true } });
    eq(r.provider.getLiveStatus().decision?.phase, 'error', 'status updates on change');
    w.message({ type: 'v1.decision_status', status: { backend: 'typesafe', phase: 'nonsense', message: 'x' } });
    eq(r.provider.getLiveStatus().decision?.phase, 'error', 'unknown status ignored, last good kept');
    w.message({ type: 'v1.decision_status' });
    eq(r.provider.getLiveStatus().decision?.phase, 'error', 'missing status ignored safely');
    eq(r.events.length, 0, 'decision status never reaches the envelope store');
    w.serverClose('blip'); r.clock.advance(600);
    eq(r.provider.getLiveStatus().decision, null, 'replaced socket clears the old status until the new socket reports');
    const w2 = r.ws(); w2.open();
    w2.message({ type: 'v1.ack', receipt: { hello: true }, snapshot: SNAP('sid_new') });
    w2.message({ type: 'v1.decision_status', status: { backend: 'rules', phase: 'rules', model: null, message: 'V1 command and object rules; Jev is not connected' } });
    eq(r.provider.getLiveStatus().decision?.backend, 'rules', 'new socket status applied');
    await r.provider.stop();
    eq(r.provider.getLiveStatus().decision, null, 'stop clears decision status');
    const r2 = rig(); const w3 = await connected(r2);
    w3.message({ type: 'v1.decision_status', status: { backend: 'typesafe', phase: 'ready', model: 'jev-1.13.0', message: 'Client ready' } });
    await r2.provider.destroySession();
    eq(r2.provider.getLiveStatus().decision, null, 'reset clears decision status');
  }

  console.log('\n# v1 provider: face frames for the overlay follow the capture generation');
  {
    const tickAll = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };
    const r = rig();
    const w = await connected(r);
    const seen = []; r.provider.onFaceFrame((f) => seen.push(f));
    const p = r.provider.startCapture(SETTINGS);
    await tickAll();
    const ack = w.json().filter((m) => m.type === 'command' && m.command.type === 'capture.status').at(-1);
    w.message({ type: 'v1.ack', request_id: ack.request_id, receipt: { ok: true } });
    await p;
    const faces = r.made.faces[0]; faces.running();
    const frame = { type: 'frame', frame_id: 1, input_wh: [640, 480], faces: [{ track_id: 1, box: [1, 2, 3, 4], stable_name: null, match: { name: 'x' } }], detected_count: 1 };
    faces.opts.onFrame(frame, { streamId: faces.streamId, captureTsMs: 5 });
    eq(seen.length, 1, 'frame delivered to the overlay channel');
    check(seen[0].frame === frame, 'the same raw frame object (no reinterpretation)');
    eq(seen[0].meta.captureTsMs, 5, 'capture timing forwarded with the frame');
    r.provider.stopCapture();
    eq(seen.at(-1), null, 'stop clears the overlay');
    const before = seen.length;
    faces.opts.onFrame(frame, { streamId: faces.streamId, captureTsMs: 6 });
    eq(seen.length, before, 'a late frame from the stopped generation is not delivered');
    const p2 = r.provider.startCapture(SETTINGS);
    await tickAll();
    const ack2 = w.json().filter((m) => m.type === 'command' && m.command.type === 'capture.status').at(-1);
    w.message({ type: 'v1.ack', request_id: ack2.request_id, receipt: { ok: true } });
    await p2;
    const faces2 = r.made.faces[1]; faces2.running();
    faces.opts.onFrame(frame, { streamId: faces.streamId, captureTsMs: 7 });
    eq(seen.length, before, 'old stream frames still ignored after a new start');
    faces2.opts.onFrame(frame, { streamId: faces2.streamId, captureTsMs: 8 });
    eq(seen.length, before + 1, 'new stream frames delivered');
    faces2.opts.onStatus({ phase: 'error', message: 'model died' });
    eq(seen.at(-1), null, 'face stream failure clears the overlay');
  }
}
