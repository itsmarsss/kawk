import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MediaSource, type MediaDeps, type ContextLike, type StreamLike, type VideoLike, type TrackLike } from '../src/media.ts';

interface Deferred<T> { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void }
const deferred = <T,>(): Deferred<T> => { let resolve!: (v: T) => void, reject!: (e: unknown) => void; const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; }); return { promise, resolve, reject }; };
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

class FakeTrack implements TrackLike { stopped = false; stop() { this.stopped = true; } }
class FakeStream implements StreamLike { tracks = [new FakeTrack()]; getTracks() { return this.tracks; } getVideoTracks() { return this.tracks; } getAudioTracks() { return this.tracks; } }
class FakeContext implements ContextLike {
  state = 'suspended'; sampleRate = 16000; destination = {}; closed = false;
  addModule = deferred<void>();
  audioWorklet = { addModule: () => this.addModule.promise };
  createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
  async resume() { this.state = 'running'; }
  async close() { this.state = 'closed'; this.closed = true; }
}
function fakeDeps() {
  const streams: FakeStream[] = []; const contexts: FakeContext[] = [];
  const deps: MediaDeps = {
    getUserMedia: async () => { const s = new FakeStream(); streams.push(s); return s; },
    createContext: () => { const c = new FakeContext(); contexts.push(c); return c; },
    createWorkletNode: () => ({ port: { onmessage: null, postMessage() {} }, connect() {}, disconnect() {} }),
    createCanvas: () => ({} as HTMLCanvasElement),
  };
  return { deps, streams, contexts };
}
function fakeVideo(): VideoLike & { listeners: Map<string, Set<() => void>> } {
  const listeners = new Map<string, Set<() => void>>();
  return {
    srcObject: null, muted: false, playsInline: false, readyState: 2, videoWidth: 1280, videoHeight: 720, listeners,
    async play() {},
    addEventListener(t, fn) { (listeners.get(t) ?? listeners.set(t, new Set()).get(t)!).add(fn); },
    removeEventListener(t, fn) { listeners.get(t)?.delete(fn); },
  };
}
const cb = { onChunk() {}, onLevel() {}, onTrackEnded() {} };

test('stale start → Stop → new Start: the old addModule resolving/rejecting closes only OLD resources', async () => {
  const { deps, streams, contexts } = fakeDeps();
  const video = fakeVideo();
  const media = new MediaSource(video, cb, () => 0, deps);
  const first = media.start({ cameraId: null, micId: null });
  await tick(); await tick(); // getUserMedia resolved for both; mic is awaiting addModule (contexts[0])
  assert.equal(contexts.length, 1);
  media.stop();
  const second = media.start({ cameraId: null, micId: null });
  await tick(); await tick();
  assert.equal(contexts.length, 2);
  const [oldCtx, newCtx] = contexts as [FakeContext, FakeContext];
  newCtx.addModule.resolve();
  const r2 = await second;
  assert.equal(r2.audioSampleRate, 16000); assert.equal(media.micLive, true); assert.equal(media.cameraLive, true);
  // now the OLD continuation wakes up
  oldCtx.addModule.resolve();
  const r1 = await first;
  assert.equal(r1.audioSampleRate, null);
  assert.equal(oldCtx.closed, true, 'old context closed by its own continuation');
  assert.equal(newCtx.closed, false, 'new context untouched');
  assert.equal(media.micLive, true); assert.equal(media.cameraLive, true);
  assert.equal(video.srcObject, streams[2], 'video shows the NEW camera stream');
  assert.ok(streams[0]!.tracks[0]!.stopped && streams[1]!.tracks[0]!.stopped, 'old camera+mic tracks stopped');
  assert.ok(!streams[2]!.tracks[0]!.stopped && !streams[3]!.tracks[0]!.stopped, 'new tracks live');
  // and the rejecting variant
  media.stop();
  const third = media.start({ cameraId: null, micId: null });
  await tick(); await tick();
  media.stop();
  const fourth = media.start({ cameraId: null, micId: null });
  await tick(); await tick();
  const [c3, c4] = [contexts[2]!, contexts[3]!];
  c4.addModule.resolve();
  await fourth;
  c3.addModule.reject(new Error('worklet load failed'));
  const r3 = await third;
  assert.deepEqual(r3.errors, { camera: 'stopped during start' }, 'a stale start reports nothing but its own end');
  assert.equal(c3.closed, true); assert.equal(c4.closed, false);
  assert.equal(media.micLive, true);
  assert.equal(media.currentToken, 4);
});

test('Stop during the camera metadata wait cancels it and removes the listeners', async () => {
  const { deps, contexts } = fakeDeps();
  const video = fakeVideo(); video.readyState = 0;
  const media = new MediaSource(video, cb, () => 0, deps);
  const p = media.start({ cameraId: null, micId: null });
  await tick(); await tick();
  assert.equal(video.listeners.get('loadedmetadata')?.size, 1);
  media.stop();
  contexts[0]!.addModule.resolve();
  const r = await p;
  assert.equal(r.video, null);
  assert.equal(video.listeners.get('loadedmetadata')?.size, 0, 'listener removed by the cancelled wait');
  assert.equal(video.srcObject, null);
});
