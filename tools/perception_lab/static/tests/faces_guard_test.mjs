// Regression test for faces.js request/reply guards. Runs in Node with a minimal fake DOM,
// fake timers, and a mock WebSocket. Usage: node static/tests/faces_guard_test.mjs
import { pathToFileURL } from 'node:url';
import path from 'node:path';

let failures = 0;
const check = (cond, msg) => { console.log((cond ? 'ok   ' : 'FAIL ') + msg); if (!cond) failures++; };

// ---- fake timers -----------------------------------------------------------
let now = 0;
let timerSeq = 1;
const timers = new Map();
globalThis.setTimeout = (fn, ms = 0) => { const id = timerSeq++; timers.set(id, { at: now + ms, fn }); return id; };
globalThis.clearTimeout = (id) => { timers.delete(id); };
globalThis.setInterval = (fn, ms) => { const id = timerSeq++; timers.set(id, { at: now + ms, fn, every: ms }); return id; };
globalThis.clearInterval = globalThis.clearTimeout;
Object.defineProperty(globalThis, 'performance', { value: { now: () => now }, configurable: true, writable: true });
async function advance(ms) {
  const target = now + ms;
  for (;;) {
    const due = [...timers.entries()].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
    if (!due) break;
    const [id, t] = due;
    now = t.at;
    if (t.every) t.at = now + t.every; else timers.delete(id);
    t.fn();
    await flush();
  }
  now = target;
  await flush();
}
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

// ---- fake DOM ----------------------------------------------------------------
function makeElement(id = '') {
  const listeners = {};
  const el = {
    id, textContent: '', className: '', value: '', disabled: false, hidden: false, style: {}, children: [],
    readyState: 4, videoWidth: 640, videoHeight: 480, srcObject: null, width: 0, height: 0,
    options: [], classList: { add() {}, remove() {} },
    addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
    dispatch(type, event = {}) { for (const fn of listeners[type] || []) fn(event); },
    replaceChildren(...kids) { el.children = kids; },
    append(...kids) { el.children.push(...kids); },
    setAttribute() {}, focus() {}, remove() {},
    play: async () => {},
    getContext: () => ctx,
    toBlob(cb) { setTimeout(() => cb({ byteLength: 1000, arrayBuffer: async () => new ArrayBuffer(1000) }), 1); },
  };
  return el;
}
const ctxCalls = { clearRect: 0, strokeRect: 0 };
const ctx = { clearRect() { ctxCalls.clearRect++; }, strokeRect() { ctxCalls.strokeRect++; }, drawImage() {}, fillRect() {}, fillText() {}, measureText: () => ({ width: 10 }), set font(v) {}, get font() { return '12px x'; } };
const elements = new Map();
globalThis.document = {
  getElementById: (id) => { if (!elements.has(id)) elements.set(id, makeElement(id)); return elements.get(id); },
  createElement: (tag) => makeElement(tag),
};
globalThis.Option = class { constructor(text, value) { this.text = text; this.textContent = text; this.value = value; } };
globalThis.window = { addEventListener() {} };
globalThis.location = { protocol: 'http:', host: '127.0.0.1:8081' };
globalThis.fetch = async (url) => ({ ok: true, json: async () => (url.includes('gallery') ? { people: [], model: 'buffalo_l' } : { backends: { face: { local: { configured: true, detail: 'ok' }, baseten: { configured: true, detail: 'ok' } } } }) });

// ---- fake media --------------------------------------------------------------
let stoppedTracks = 0;
function makeStream() {
  const track = { stop() { stoppedTracks++; }, addEventListener() {}, getSettings: () => ({ deviceId: 'cam1' }) };
  return { getTracks: () => [track], getVideoTracks: () => [track] };
}
Object.defineProperty(globalThis, 'navigator', { configurable: true, writable: true, value: {
  mediaDevices: {
    getUserMedia: async () => makeStream(),
    enumerateDevices: async () => [{ kind: 'videoinput', deviceId: 'cam1', label: 'Fake camera' }],
    addEventListener() {},
  },
} });

// ---- mock WebSocket ------------------------------------------------------------
const sockets = [];
class MockWebSocket {
  static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
  constructor(url) { this.url = url; this.readyState = MockWebSocket.CONNECTING; this.sent = []; this.closed = false; sockets.push(this); }
  send(data) { this.sent.push(data); }
  close() { this.closed = true; this.readyState = MockWebSocket.CLOSED; }
  open() { this.readyState = MockWebSocket.OPEN; this.onopen?.(); }
  message(obj) { this.onmessage?.({ data: JSON.stringify(obj) }); }
}
globalThis.WebSocket = MockWebSocket;

// ---- load faces.js with its /static/common.js import rewritten -----------------
import fs from 'node:fs';
const here = path.dirname(new URL(import.meta.url).pathname);
const src = fs.readFileSync(path.join(here, '..', 'faces.js'), 'utf8').replace("'/static/common.js'", JSON.stringify(pathToFileURL(path.join(here, '..', 'common.js')).href));
const tmp = path.join(here, '.faces_under_test.mjs');
fs.writeFileSync(tmp, src);
try {
  await import(pathToFileURL(tmp).href);
} finally { fs.unlinkSync(tmp); }
await flush();

const $ = (id) => document.getElementById(id);
const readyMsg = { type: 'ready', model: 'buffalo_l', provider: 'CoreMLExecutionProvider', load_ms: 100, max_fps: 5, max_side: 640 };
const frameMsg = { type: 'frame', frame_id: 1, input_wh: [640, 480], detected_count: 1, accepted_count: 1,
  faces: [{ box: [10, 10, 100, 100], detection_score: 0.9, track_id: 1, match: { id: null, name: null, similarity: null }, stable_name: null, stable_id: null }],
  timings_ms: { decode: 1, detection: 2, embedding_and_alignment: 3, inference: 6, server_total: 7 }, enrollment: null };

async function startSession() {
  $('start').dispatch('click');
  await flush(); await advance(5);
  const ws = sockets[sockets.length - 1];
  ws.open();
  ws.message(readyMsg);
  await advance(300); // first tick honours the 200 ms cadence from a zero lastSendAt, then toBlob + arrayBuffer -> send
  return ws;
}

// ---- Test 1: no reply within 5 s ends the session, no second frame on the socket ----
{
  const ws = await startSession();
  check(ws.sent.length === 1, 'one frame in flight after ready');
  const stoppedBefore = stoppedTracks;
  await advance(5000);
  check(ws.sent.length === 1, 'no second frame sent on the same socket after timeout');
  check(ws.closed, 'socket closed by timeout');
  check(stoppedTracks > stoppedBefore, 'camera tracks released by timeout');
  check($('error').textContent.includes('No face reply within 5 seconds'), `error text: "${$('error').textContent}"`);
  check($('start').disabled === false, 'Start re-enabled after timeout');
  // late reply after the session ended must be ignored (handlers detached)
  const rt = $('roundtrip').textContent;
  ws.message(frameMsg);
  await flush();
  check($('roundtrip').textContent === rt, 'late reply after timeout does not change round trip');
  await advance(6000);
  check(ws.sent.length === 1, 'no frames sent by a dead session');
}

// ---- Test 2: busy(cloud_timeout) frees slot, counts, shows hint, keeps boxes, continues ----
{
  ctxCalls.clearRect = 0; ctxCalls.strokeRect = 0;
  const ws = await startSession();
  ws.message(frameMsg);
  await flush();
  const strokes = ctxCalls.strokeRect;
  check(strokes > 0, 'first frame drew boxes');
  const clearsAfterFrame = ctxCalls.clearRect;
  await advance(250); // second frame sent
  check(ws.sent.length === 2, 'second frame sent after reply');
  ws.message({ type: 'busy', reason: 'cloud_timeout', skipped_frames: 1 });
  await flush();
  check($('skipped').textContent === '1', `skipped counter = ${$('skipped').textContent}`);
  check($('hint').textContent === 'Cloud frame timed out; trying the latest frame.', `hint: "${$('hint').textContent}"`);
  check(ctxCalls.clearRect === clearsAfterFrame, 'busy did not clear the overlay (last boxes retained)');
  await advance(250);
  check(ws.sent.length === 3, 'loop continued after busy');
  ws.message({ type: 'busy' });
  await flush();
  check($('skipped').textContent === '2', 'plain busy also counted');
  check(!ws.closed && $('start').disabled === true, 'session still running after busy');
  // Stop cleans up
  $('stop').dispatch('click');
  await flush();
  check(ws.closed, 'Stop closed socket');
  check($('skipped').textContent === '2', 'counter retained until next Start');
}

// ---- Test 3: new Start resets the skipped counter ----
{
  const ws = await startSession();
  check($('skipped').textContent === '–', `counter reset on Start (got "${$('skipped').textContent}")`);
  $('stop').dispatch('click'); await flush();
  check(ws.closed, 'cleanup after test 3');
}

console.log(failures ? `${failures} FAILURES` : 'ALL PASSED');
process.exit(failures ? 1 : 0);
