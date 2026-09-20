// One camera + microphone acquisition per Start. Nothing here touches getUserMedia except start().
// Every start owns a private Session record; every await is followed by a `session is still current`
// check, and cleanup ALWAYS targets that session's own resources — a stale continuation (old
// addModule/resume/getUserMedia resolving after Stop → new Start) can only close what it created,
// never the newer session's tracks or AudioContext. Camera metadata waits are cancellable.
// Dependencies are injectable so lifecycle tests can run in Node without media.
import { CHUNK_MS, CHUNK_SAMPLES } from './speechTiming.ts';
import { fitDimensions } from './overlay.ts';

const WORKLET_URL = '/static/speech-worklet.js';
const WORKLET_NAME = 'pcm-chunker';
const MAC_HINT = 'On macOS the camera/microphone permission belongs to the browser app (System Settings > Privacy & Security).';

export interface PcmChunk { buffer: ArrayBuffer; captureTsMs: number }
export interface MediaCallbacks {
  onChunk(chunk: PcmChunk): void;
  onLevel(rms: number): void;
  onTrackEnded(side: 'camera' | 'microphone', message: string): void;
}
export interface MediaStartResult { video: { width: number; height: number } | null; audioSampleRate: number | null; errors: { camera?: string; microphone?: string } }
export interface DrawnPhoto { canvas: HTMLCanvasElement; width: number; height: number; capturedAt: number }

/** Minimal shapes so tests can substitute fakes. Real browser objects satisfy them structurally. */
export interface TrackLike { stop(): void; addEventListener?(type: 'ended', fn: () => void): void }
export interface StreamLike { getTracks(): TrackLike[]; getVideoTracks?(): TrackLike[]; getAudioTracks?(): TrackLike[] }
export interface PortLike { onmessage: ((ev: { data: unknown }) => void) | null; postMessage(m: unknown): void }
export interface NodeLike { port: PortLike; connect(dst: unknown): void; disconnect(): void }
export interface SourceLike { connect(dst: unknown): void; disconnect(): void }
export interface ContextLike {
  state: string; sampleRate: number; destination: unknown;
  audioWorklet: { addModule(url: string): Promise<void> };
  createMediaStreamSource(stream: StreamLike): SourceLike;
  resume(): Promise<void>; close(): Promise<void>;
}
export interface VideoLike {
  srcObject: unknown; muted: boolean; playsInline: boolean; readyState: number; videoWidth: number; videoHeight: number;
  play(): Promise<void>; addEventListener(type: string, fn: () => void): void; removeEventListener(type: string, fn: () => void): void;
}
export interface MediaDeps {
  getUserMedia(constraints: MediaStreamConstraints): Promise<StreamLike>;
  createContext(): ContextLike;
  createWorkletNode(ctx: ContextLike, name: string, options: unknown): NodeLike;
  createCanvas(): HTMLCanvasElement;
}
export const browserDeps = (): MediaDeps => ({
  getUserMedia: (c) => navigator.mediaDevices.getUserMedia(c) as Promise<StreamLike>,
  createContext: () => { try { return new AudioContext({ sampleRate: 16000 }) as unknown as ContextLike; } catch { return new AudioContext() as unknown as ContextLike; } },
  createWorkletNode: (ctx, name, options) => new AudioWorkletNode(ctx as unknown as AudioContext, name, options as AudioWorkletNodeOptions) as unknown as NodeLike,
  createCanvas: () => document.createElement('canvas'),
});

export async function listDevices(): Promise<{ cameras: MediaDeviceInfo[]; microphones: MediaDeviceInfo[] }> {
  const md = navigator.mediaDevices;
  if (!md?.enumerateDevices) return { cameras: [], microphones: [] };
  const all = await md.enumerateDevices();
  return { cameras: all.filter((d) => d.kind === 'videoinput'), microphones: all.filter((d) => d.kind === 'audioinput') };
}

export function describeMediaError(e: unknown, what: string): string {
  const err = e as { name?: string; message?: string } | null;
  const name = err?.name ?? '';
  const base = `${what} failed${name ? ` (${name})` : ''}${err?.message ? `: ${err.message}` : ''}`;
  return ['NotAllowedError', 'SecurityError', 'NotReadableError', 'AbortError'].includes(name) ? `${base}. ${MAC_HINT}` : base;
}

function stopTracks(stream: StreamLike | null): void {
  for (const t of stream?.getTracks() ?? []) { try { t.stop(); } catch { /* ignore */ } }
}

/** Everything one start() owns. Cleanup functions take the Session, never read `current`. */
interface Session {
  token: number; ended: boolean; endedPromise: Promise<void>; resolveEnded: () => void;
  cameraStream: StreamLike | null; micStream: StreamLike | null;
  ctx: ContextLike | null; node: NodeLike | null; source: SourceLike | null;
  cameraLive: boolean; micLive: boolean;
}

export class MediaSource {
  private seq = 0;
  private current: Session | null = null;
  private fullCanvas: HTMLCanvasElement | null = null;
  private faceCanvas: HTMLCanvasElement | null = null;
  private liveCanvas: HTMLCanvasElement | null = null;

  constructor(private readonly videoEl: VideoLike, private readonly cb: MediaCallbacks, private readonly now: () => number = Date.now, private readonly deps: MediaDeps = browserDeps()) {}

  get cameraLive(): boolean { return Boolean(this.current?.cameraLive); }
  get micLive(): boolean { return Boolean(this.current?.micLive); }
  /** For tests: whether a given start's context/tracks are still held by the current session. */
  get currentToken(): number | null { return this.current?.token ?? null; }

  async start(opts: { cameraId: string | null; micId: string | null }): Promise<MediaStartResult> {
    this.stop();
    let resolveEnded: () => void = () => {};
    const endedPromise = new Promise<void>((r) => { resolveEnded = r; });
    const s: Session = { token: ++this.seq, ended: false, endedPromise, resolveEnded, cameraStream: null, micStream: null, ctx: null, node: null, source: null, cameraLive: false, micLive: false };
    this.current = s;
    const errors: MediaStartResult['errors'] = {};
    const [video, audioSampleRate] = await Promise.all([
      this.startCamera(s, opts.cameraId).catch((e) => { this.releaseCamera(s); if (!s.ended) errors.camera = describeMediaError(e, 'Camera'); return null; }),
      this.startMic(s, opts.micId).catch((e) => { this.teardownMic(s); if (!s.ended) errors.microphone = describeMediaError(e, 'Microphone'); return null; }),
    ]);
    if (s.ended) return { video: null, audioSampleRate: null, errors: { camera: 'stopped during start' } };
    return { video, audioSampleRate, errors };
  }

  /** Ends the CURRENT session only. Idempotent. */
  stop(): void {
    const s = this.current;
    if (!s) return;
    this.current = null;
    this.endSession(s);
  }

  private endSession(s: Session): void {
    if (s.ended) return;
    s.ended = true;
    s.resolveEnded();
    this.releaseCamera(s);
    this.teardownMic(s);
  }

  /** Draw the CURRENT video frame once at ≤ maxSide. The returned canvas is dedicated to scheduled photos. */
  drawFull(maxSide: number): DrawnPhoto | null { return this.draw(maxSide, 'full'); }
  /** Regular ~5 fps face frame straight from the video, on its own canvas. */
  drawLiveFace(maxSide: number): DrawnPhoto | null { return this.draw(maxSide, 'live'); }
  private draw(maxSide: number, which: 'full' | 'live'): DrawnPhoto | null {
    const v = this.videoEl;
    if (!this.cameraLive || v.readyState < 2 || !v.videoWidth || !v.videoHeight) return null;
    const { width, height } = fitDimensions(v.videoWidth, v.videoHeight, maxSide);
    const canvas = which === 'full' ? (this.fullCanvas ??= this.deps.createCanvas()) : (this.liveCanvas ??= this.deps.createCanvas());
    if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
    const capturedAt = this.now();
    canvas.getContext('2d', { alpha: false })!.drawImage(v as unknown as CanvasImageSource, 0, 0, width, height);
    return { canvas, width, height, capturedAt };
  }

  /** Face derivative drawn FROM the full canvas (never from the video again). Same aspect ratio. */
  deriveFace(full: DrawnPhoto, maxSide: number): { canvas: HTMLCanvasElement; width: number; height: number } {
    const { width, height } = fitDimensions(full.width, full.height, maxSide);
    const canvas = (this.faceCanvas ??= this.deps.createCanvas());
    if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
    canvas.getContext('2d', { alpha: false })!.drawImage(full.canvas, 0, 0, width, height);
    return { canvas, width, height };
  }

  /** JPEG-encode a canvas. toBlob copies the bitmap synchronously, so later draws do not affect it. */
  static encodeJpeg(canvas: HTMLCanvasElement, quality: number): Promise<ArrayBuffer> {
    return new Promise<ArrayBuffer>((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (!blob) { reject(new Error('JPEG encode produced no data')); return; }
        blob.arrayBuffer().then(resolve, reject);
      }, 'image/jpeg', quality);
    });
  }

  get videoSize(): { width: number; height: number } | null {
    const v = this.videoEl;
    return v.videoWidth && v.videoHeight ? { width: v.videoWidth, height: v.videoHeight } : null;
  }

  // ---- internals (all take the owning Session) ---------------------------------------------------
  private isCurrent(s: Session): boolean { return !s.ended && this.current === s; }

  private async startCamera(s: Session, cameraId: string | null): Promise<{ width: number; height: number } | null> {
    const video: MediaTrackConstraints = { width: { ideal: 1280 }, height: { ideal: 720 }, ...(cameraId ? { deviceId: { exact: cameraId } } : {}) };
    const stream = await this.deps.getUserMedia({ video, audio: false });
    if (!this.isCurrent(s)) { stopTracks(stream); return null; }
    s.cameraStream = stream;
    (stream.getVideoTracks?.() ?? stream.getTracks())[0]?.addEventListener?.('ended', () => {
      if (!this.isCurrent(s) || !s.cameraLive) return;
      this.releaseCamera(s);
      this.cb.onTrackEnded('camera', 'Camera track ended (device unplugged or permission revoked).');
    });
    const v = this.videoEl;
    v.srcObject = stream; v.muted = true; v.playsInline = true;
    if (v.readyState < 1) {
      // cancellable: Stop resolves endedPromise, which removes the listeners instead of stranding them
      await Promise.race([
        new Promise<void>((resolve, reject) => {
          const cleanup = () => { v.removeEventListener('loadedmetadata', done); v.removeEventListener('error', fail); };
          const done = () => { cleanup(); resolve(); };
          const fail = () => { cleanup(); reject(new Error('video element failed to load the camera stream')); };
          v.addEventListener('loadedmetadata', done); v.addEventListener('error', fail);
          void s.endedPromise.then(cleanup);
        }),
        s.endedPromise,
      ]);
    }
    if (!this.isCurrent(s)) { this.releaseCamera(s); return null; }
    try { await v.play(); } catch { /* muted autoplay */ }
    if (!this.isCurrent(s)) { this.releaseCamera(s); return null; }
    s.cameraLive = true;
    return v.videoWidth && v.videoHeight ? { width: v.videoWidth, height: v.videoHeight } : null;
  }

  private releaseCamera(s: Session): void {
    const stream = s.cameraStream;
    s.cameraStream = null; s.cameraLive = false;
    stopTracks(stream);
    if (stream && this.videoEl.srcObject === stream) this.videoEl.srcObject = null; // only OUR stream, never a newer one
  }

  private async startMic(s: Session, micId: string | null): Promise<number | null> {
    const audio: MediaTrackConstraints = { ...(micId ? { deviceId: { exact: micId } } : {}), echoCancellation: true, noiseSuppression: true, autoGainControl: true };
    const stream = await this.deps.getUserMedia({ audio, video: false });
    if (!this.isCurrent(s)) { stopTracks(stream); return null; }
    s.micStream = stream;
    (stream.getAudioTracks?.() ?? stream.getTracks())[0]?.addEventListener?.('ended', () => {
      if (!this.isCurrent(s) || !s.micLive) return;
      this.teardownMic(s);
      this.cb.onTrackEnded('microphone', 'Microphone track ended (device unplugged or permission revoked).');
    });
    const ctx = this.deps.createContext();
    s.ctx = ctx;
    await ctx.audioWorklet.addModule(WORKLET_URL);
    if (!this.isCurrent(s)) { this.teardownMic(s); return null; }
    s.source = ctx.createMediaStreamSource(stream);
    s.node = this.deps.createWorkletNode(ctx, WORKLET_NAME, {
      numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1],
      processorOptions: { inputRate: ctx.sampleRate, outRate: 16000, chunkSamples: CHUNK_SAMPLES },
    });
    s.node.port.onmessage = (event) => {
      if (!this.isCurrent(s)) return;
      const data = event.data as { type?: string; buffer?: ArrayBuffer; rms?: number } | null;
      if (!data) return;
      if (data.type === 'chunk' && data.buffer) this.cb.onChunk({ buffer: data.buffer, captureTsMs: this.now() - CHUNK_MS });
      else if (data.type === 'level' && typeof data.rms === 'number') this.cb.onLevel(data.rms);
    };
    s.source.connect(s.node);
    s.node.connect(ctx.destination); // worklet output is silent; keeps the graph alive
    if (ctx.state !== 'running') await ctx.resume();
    if (!this.isCurrent(s)) { this.teardownMic(s); return null; }
    s.micLive = true;
    return ctx.sampleRate;
  }

  private teardownMic(s: Session): void {
    try { s.node?.port.postMessage({ type: 'stop' }); } catch { /* ignore */ }
    if (s.node) s.node.port.onmessage = null;
    try { s.source?.disconnect(); } catch { /* ignore */ }
    try { s.node?.disconnect(); } catch { /* ignore */ }
    stopTracks(s.micStream);
    const ctx = s.ctx;
    s.ctx = null; s.node = null; s.source = null; s.micStream = null; s.micLive = false;
    if (ctx && ctx.state !== 'closed') { try { void ctx.close().catch(() => {}); } catch { /* ignore */ } }
  }
}
