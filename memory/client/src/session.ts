// One Run per Start. Owns: the server session, media, the face slot + link, the speech link, the
// anchored 5 s ticker, the ~5 fps face loop and the once-only capture submissions. A Run that was
// stopped never touches a newer Run: everything it does is scoped to its own objects, and its
// callbacks check `this.stopped` before acting.
import type { CaptureInput, Clock, FaceEvidence, Transcript } from './types.ts';
import { api, type ClientConfig } from './api.ts';
import { newId } from './ids.ts';
import { createAnchoredTicker, type TickInfo } from './cadence.ts';
import { FaceSlot, type ScheduledPhoto, type ScheduledResult } from './faceSlot.ts';
import { FaceLink, type FaceLinkStatus } from './faceLink.ts';
import { SpeechLink, type SpeechLinkStatus } from './speechLink.ts';
import { MediaSource, type MediaDeps, type PcmChunk } from './media.ts';
import { SubmissionLedger, BoundedRevisionQueue, type SubmissionState } from './submissions.ts';
import { unavailableFaceEvidence } from './faceBinding.ts';
import { IntroductionForwarder, idleIntroduction, type EnrollmentReply, type IntroductionReply, type IntroductionState } from './introductions.ts';
import { HISTORICAL_DEFAULT_SPEECH_BACKEND, type SpeechBackend } from './speechBackend.ts';
import { SequenceAllocator } from './sequence.ts';
import { CommandPoller, type CommandTransport, type InterruptState } from './agentCommands.ts';
import { LiveFaceForwarder, type LiveFaceState, type LiveFaceTransport } from './liveFaces.ts';

export type RunPhase = 'idle' | 'starting' | 'running' | 'stopping' | 'stopped' | 'error';
export interface LiveFaces { evidence: FaceEvidence; receivedAt: number; rttMs: number }
export interface RunErrors { at: number; message: string }
export interface RunSnapshot {
  phase: RunPhase; sessionId: string | null; startedAt: number | null; reason: string | null;
  camera: 'off' | 'live' | 'error'; microphone: 'off' | 'live' | 'error'; videoSize: { width: number; height: number } | null;
  ticks: { fired: number; skipped: number; anchor: number | null; intervalMs: number };
  photos: { drawn: number; drawFailed: number; encodeFailed: number; encoding: number; awaitingFace: number; faceReady: number; faceUnavailable: number; faceGaps: number; queueRejected: number; faceQueued: number; interrupts: number; nextSequence: number };
  submissions: { pending: number; submitting: number; accepted: number; failed: number; total: number; lastLatencyMs: number | null; recent: SubmissionState[] };
  face: FaceLinkStatus & { lastRttMs: number | null; lastServerMs: number | null; staleReplies: number; slotBusy: boolean };
  speech: SpeechLinkStatus;
  /** Backend requested on the /ws/speech URL for this Run (what the selector said at Start); null before Start. */
  speechBackend: SpeechBackend | null;
  transcripts: { posted: number; failed: number; dropped: number; pendingHttp: number; suppressed: number };
  /** Visible state of spoken-introduction forwarding and the server's decision/enrollment replies. */
  introduction: IntroductionState;
  micLevel: number;
  finalCapture: FinalCaptureState;
  /** Agent capture interrupts: command polling health and the current claim/capture/report stage. */
  interrupt: InterruptState | null;
  /** Live face forwarding to the agent bridge (identity-set changes + heartbeat); null when disabled. */
  liveFaces: LiveFaceState | null;
  /** Unsent work and how old its SOURCE is: photos awaiting encode/face/HTTP and transcript revisions awaiting POST. */
  backlog: { photos: number; oldestPhotoCapturedAt: number | null; transcripts: number; oldestTranscriptReceivedAt: number | null };
  errors: RunErrors[];
}
/** Stop-time snapshot lifecycle. 'accepted' means HTTP 202 only, not that memory was committed. */
export interface FinalCaptureState { stage: 'not-started' | 'flushing-speech' | 'draining-transcripts' | 'capturing' | 'awaiting-face' | 'submitting' | 'accepted' | 'failed' | 'skipped'; id: string | null; detail: string }

export interface RunDeps {
  videoEl: HTMLVideoElement; config: ClientConfig; clock?: Clock;
  onUpdate: (s: RunSnapshot) => void;
  onLiveFaces: (faces: LiveFaces | null) => void;
  onTranscript: (t: Transcript) => void;
  /** Agent command transport (GET commands / claim / result). Omit to disable interrupt polling. */
  commands?: CommandTransport | null;
  commandIntervalMs?: number;
  /** POST /api/agent/faces transport for live regular face results. Omit to disable forwarding. */
  liveFaces?: LiveFaceTransport | null;
  /** Test seam: fake getUserMedia/canvas. Browser defaults when omitted. */
  mediaDeps?: MediaDeps;
}

const FACE_FPS_INTERVAL_MS = 200;
const FULL_MAX_SIDE = 1280;
const FACE_MAX_SIDE = 640;
const MAX_ERRORS = 60;
const STOP_TRANSCRIPT_DRAIN_MS = 4000;
const STOP_FACE_WAIT_MS = 2500;
const STOP_SUBMIT_WAIT_MS = 6000;
const INTERRUPT_FACE_WAIT_MS = 9000;
const INTERRUPT_SUBMIT_WAIT_MS = 15000;
const fmt = (ms: number | null | undefined) => (typeof ms === 'number' ? `${Math.round(ms)} ms` : '?');

interface PendingPhoto { id: string; sequence: number; capturedAt: number; width: number; height: number; audioStatus: 'live' | 'unavailable'; jpegBase64: string | null; requestId: string | null }
/** A transcript revision waiting for POST, bound to the face connection epoch current when it was received. */
interface QueuedTranscript { transcript: Transcript; isFinal: boolean; faceEpoch: number }

export class Run {
  readonly clock: Clock;
  private phase: RunPhase = 'idle';
  private reason: string | null = null;
  private sessionId: string | null = null;
  private startedAt: number | null = null;
  private stopped = false;
  private failed = false;
  private stopPromise: Promise<void> | null = null;
  private readonly media: MediaSource;
  private readonly slot: FaceSlot;
  private readonly faceLink: FaceLink;
  private speech: SpeechLink | null = null;
  private readonly ticker;
  private faceLoop: unknown = null;
  private regularEncoding = false;
  private pending = new Map<string, PendingPhoto>();
  private readonly submissions: SubmissionLedger<CaptureInput>;
  private transcriptQueue = new BoundedRevisionQueue<QueuedTranscript>(40);
  private transcriptPumping = false;
  private readonly introductions = new IntroductionForwarder((payload, epoch) => this.faceLink.sendIntroduction(payload, epoch));
  private introduction: IntroductionState = idleIntroduction();
  private speechBackend: SpeechBackend | null = null;
  private counts = { fired: 0, skipped: 0, drawn: 0, drawFailed: 0, encodeFailed: 0, encoding: 0, faceReady: 0, faceUnavailable: 0, faceGaps: 0, queueRejected: 0, tPosted: 0, tFailed: 0 };
  private face = { lastRttMs: null as number | null, lastServerMs: null as number | null, status: null as FaceLinkStatus | null };
  private speechStatus: SpeechLinkStatus | null = null;
  private micLevel = 0;
  private lastLatencyMs: number | null = null;
  private errors: RunErrors[] = [];
  private camera: RunSnapshot['camera'] = 'off';
  private microphone: RunSnapshot['microphone'] = 'off';
  private updateScheduled = false;
  private finalCapture: FinalCaptureState = { stage: 'not-started', id: null, detail: '' };
  private scheduledWaiters = new Map<string, () => void>();
  private readonly sequences = new SequenceAllocator();
  private commands: CommandPoller | null = null;
  private interrupt: InterruptState | null = null;
  private interruptCaptures = new Map<string, Promise<string>>();
  private interruptCount = 0;
  private liveFaces: LiveFaceForwarder | null = null;
  private liveFaceState: LiveFaceState | null = null;

  constructor(private readonly deps: RunDeps) {
    this.clock = deps.clock ?? { now: () => Date.now(), setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>) };
    this.media = new MediaSource(deps.videoEl, {
      onChunk: (c) => this.onChunk(c),
      onLevel: (rms) => { this.micLevel = rms; this.scheduleUpdate(); },
      onTrackEnded: (side, message) => { this.error(message); if (side === 'camera') this.camera = 'error'; else this.microphone = 'error'; void this.stop(`${side} track ended`); },
    }, () => this.clock.now(), deps.mediaDeps);
    this.slot = new FaceSlot({
      clock: this.clock, maxQueue: 2, responseTimeoutMs: 4000, maxQueueWaitMs: 6000,
      events: {
        send: (jpeg, epoch) => this.faceLink.send(jpeg, epoch),
        onRegularResult: (r) => { this.face.lastRttMs = r.rttMs; this.face.lastServerMs = r.timings?.server_total ?? null; this.deps.onLiveFaces({ evidence: r.evidence, receivedAt: this.clock.now(), rttMs: r.rttMs }); this.liveFaces?.offer(r.evidence); this.scheduleUpdate(); },
        onScheduledResult: (r) => { this.onScheduledResult(r); this.scheduledWaiters.get(r.photo.id)?.(); },
        onGap: (g) => { this.counts.faceGaps += 1; this.error(`face gap for ${g.photoId}: ${g.reason}`); },
        onStaleReply: (s) => { this.error(`stale face reply ignored: ${s.reason}`); },
        requestReconnect: (reason) => this.faceLink.reconnect(reason),
      },
    });
    this.faceLink = new FaceLink({
      url: wsUrl('/ws/faces', { backend: 'local' }), slot: this.slot, clock: this.clock,
      onStatus: (s) => { this.face.status = s; if (s.phase !== 'ready') this.deps.onLiveFaces(null); this.scheduleUpdate(); },
      onError: (m) => this.error(m),
      onIntroduction: (r, epoch) => this.onIntroductionReply(r, epoch),
      onEnrollment: (e, epoch) => this.onEnrollmentReply(e, epoch),
    });
    this.ticker = createAnchoredTicker({ intervalMs: deps.config.captureIntervalMs, clock: this.clock, onTick: (t) => this.onTick(t) });
    this.submissions = new SubmissionLedger<CaptureInput>({
      send: (body) => api.postCapture(body), maxAttempts: 3, retryDelayMs: 600, maxInFlight: 4, now: () => this.clock.now(),
      onChange: (s) => { if (s.status === 'accepted' && s.latencyMs !== null) this.lastLatencyMs = s.latencyMs; if (s.status === 'failed' && s.error) this.error(`capture ${s.id} failed: ${s.error}`); this.scheduleUpdate(); },
    });
  }

  get isActive(): boolean { return !this.stopped && (this.phase === 'starting' || this.phase === 'running'); }

  async start(opts: { cameraId: string | null; micId: string | null; speechBackend?: SpeechBackend }): Promise<void> {
    if (this.phase !== 'idle') return;
    this.speechBackend = opts.speechBackend ?? HISTORICAL_DEFAULT_SPEECH_BACKEND;
    this.phase = 'starting'; this.update();
    let session: { id: string; startedAt: number };
    try { session = await api.createSession(); } catch (e) { this.fail(`POST /api/sessions failed: ${msg(e)}`); return; }
    if (this.stopped) return; // Stop pressed during the request: no media is acquired for a dead run
    this.sessionId = session.id; this.startedAt = session.startedAt;
    if (this.deps.liveFaces) {
      this.liveFaces = new LiveFaceForwarder({ sessionId: session.id, clock: this.clock, send: this.deps.liveFaces, onState: (s) => { this.liveFaceState = s; this.scheduleUpdate(); } });
      this.liveFaces.start();
    }
    this.update();
    const media = await this.media.start(opts);
    if (this.stopped) { this.media.stop(); return; }
    if (media.errors.camera) { this.error(media.errors.camera); this.camera = 'error'; }
    else this.camera = 'live';
    if (media.errors.microphone) { this.error(media.errors.microphone); this.microphone = 'error'; }
    else this.microphone = 'live';
    if (this.camera !== 'live') { this.fail('camera unavailable; nothing to capture'); this.media.stop(); return; }
    this.faceLink.start();
    if (this.microphone === 'live') {
      this.speech = new SpeechLink({
        url: wsUrl('/ws/speech', { backend: this.speechBackend }), sessionId: session.id, clock: this.clock,
        onTranscript: (t) => this.onTranscript(t),
        onStatus: (s) => { this.speechStatus = s; this.scheduleUpdate(); },
        onError: (m) => this.error(m),
      });
      this.speech.start();
    }
    this.phase = 'running';
    this.ticker.start(this.clock.now());
    this.faceLoop = setInterval(() => this.faceTick(), FACE_FPS_INTERVAL_MS);
    if (this.deps.commands) {
      this.commands = new CommandPoller({
        sessionId: session.id, clock: this.clock, transport: this.deps.commands, intervalMs: this.deps.commandIntervalMs ?? 400,
        capture: (requestId) => this.captureNow(requestId),
        onState: (s) => { this.interrupt = s; this.scheduleUpdate(); },
      });
      this.commands.start();
    }
    this.update();
  }

  /**
   * Agent interrupt: ONE immediate full photo through the same path as a 5 s tick (same canvas draw, same
   * face derivative + slot, same once-only submission), tagged with `requestId`. The anchored cadence is
   * untouched. Resolves with the capture id once the server answered HTTP 202 (accepted for processing, not
   * yet interpreted); rejects on any failure. A repeated `requestId` returns the original promise so one
   * command never yields two photos.
   */
  captureNow(requestId: string): Promise<string> {
    if (!requestId) return Promise.reject(new Error('captureNow requires a requestId'));
    const existing = this.interruptCaptures.get(requestId);
    if (existing) return existing;
    const p = this.doCaptureNow(requestId);
    this.interruptCaptures.set(requestId, p);
    p.catch(() => {});
    if (this.interruptCaptures.size > 200) { const first = this.interruptCaptures.keys().next().value; if (first !== undefined) this.interruptCaptures.delete(first); }
    return p;
  }

  private async doCaptureNow(requestId: string): Promise<string> {
    if (this.stopped || this.phase !== 'running') throw new Error(`run is ${this.phase}; no camera to capture from`);
    const sessionId = this.sessionId;
    const full = this.media.drawFull(FULL_MAX_SIDE);
    if (!full || !sessionId) throw new Error('no video frame available');
    const id = newId('capnow', full.capturedAt);
    const sequence = this.sequences.next();
    const face = this.media.deriveFace(full, FACE_MAX_SIDE); // from the SAME canvas, never from the video
    const entry: PendingPhoto = { id, sequence, capturedAt: full.capturedAt, width: full.width, height: full.height,
      audioStatus: this.speech?.isReady ? 'live' : 'unavailable', jpegBase64: null, requestId };
    this.pending.set(id, entry);
    this.counts.drawn += 1; this.counts.encoding += 1; this.interruptCount += 1;
    this.update();
    let faceBuf: ArrayBuffer;
    try {
      const [fullBuf, f] = await Promise.all([MediaSource.encodeJpeg(full.canvas, 0.82), MediaSource.encodeJpeg(face.canvas, 0.85)]);
      entry.jpegBase64 = toBase64(fullBuf); faceBuf = f;
    } catch (e) {
      this.counts.encoding -= 1; this.counts.encodeFailed += 1; this.pending.delete(id); this.update();
      throw new Error(`JPEG encode failed: ${msg(e)}`);
    }
    this.counts.encoding -= 1;
    const unavailable = () => unavailableFaceEvidence({ id, capturedAt: entry.capturedAt, width: face.width, height: face.height, streamId: this.slot.currentStreamId });
    if (this.stopped) { // encoded after Stop: still this session's photo; submit honestly without faces
      this.counts.faceGaps += 1;
      this.submitCapture(entry, unavailable(), sessionId);
    } else {
      const photo: ScheduledPhoto = { id, sequence, capturedAt: full.capturedAt, faceJpeg: faceBuf, faceWidth: face.width, faceHeight: face.height, enqueuedAt: this.clock.now() };
      const submitted = new Promise<void>((resolve) => { this.scheduledWaiters.set(id, resolve); });
      const outcome = this.slot.enqueueScheduled(photo);
      if (outcome === 'rejected') this.counts.queueRejected += 1;
      // The slot bounds its own waits (response timeout, queue wait); this guard only covers a slot that never reports.
      const guard = this.clock.setTimeout(() => {
        const still = this.pending.get(id);
        if (!still) return;
        this.counts.faceGaps += 1; this.error(`interrupt ${id}: no face result within ${INTERRUPT_FACE_WAIT_MS} ms; submitting without faces`);
        this.submitCapture(still, unavailable(), sessionId);
        this.scheduledWaiters.get(id)?.();
      }, INTERRUPT_FACE_WAIT_MS);
      await submitted;
      this.clock.clearTimeout(guard);
      this.scheduledWaiters.delete(id);
    }
    const result = await Promise.race([
      this.awaitSubmission(id),
      new Promise<'timeout'>((r) => this.clock.setTimeout(() => r('timeout'), INTERRUPT_SUBMIT_WAIT_MS)),
    ]);
    const state = this.submissions.get(id);
    if (result === 'accepted') return id;
    if (result === 'timeout') throw new Error(`capture ${id}: no HTTP answer within ${INTERRUPT_SUBMIT_WAIT_MS} ms (${state?.status ?? 'unknown'})`);
    throw new Error(`capture ${id} not accepted: ${state?.error ?? 'submission failed'}`);
  }

  /**
   * Idempotent, bounded. Order: stop the cadence → flush speech (500 ms silence + stop control, brief
   * grace for finals) → drain queued transcript revisions (bounded) → ONE final full snapshot while the
   * camera is still live, with its own face derivative (bounded wait, else unavailable) → submit it
   * (bounded) → release camera/mic/sockets. Late speech after the last 5 s tick is thereby covered.
   */
  stop(reason = 'stopped by user'): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.stopPromise = (async () => {
      const wasRunning = this.phase === 'running';
      this.stopped = true; this.reason = reason;
      this.phase = 'stopping'; this.update();
      this.commands?.stop(reason); // no further claims or interrupt photos for this session
      this.liveFaces?.stop(reason); // no live face evidence for a dead session; an in-flight reply is ignored
      this.ticker.stop();
      if (this.faceLoop !== null) clearInterval(this.faceLoop as ReturnType<typeof setInterval>);
      this.faceLoop = null;
      this.slot.drain(reason); // earlier scheduled photos still waiting → explicit unavailable submissions
      const speech = this.speech;
      if (speech) {
        this.setFinal('flushing-speech', null, 'silence flush + stop control, waiting briefly for finals');
        try { await speech.stop(); } catch (e) { this.error(`speech stop: ${msg(e)}`); }
      }
      if (wasRunning && this.sessionId && this.media.cameraLive) {
        this.setFinal('draining-transcripts', null, `${this.transcriptQueue.length} queued revision(s)`);
        const drained = await this.waitForTranscripts(STOP_TRANSCRIPT_DRAIN_MS);
        if (!drained) this.error(`Stop: ${this.transcriptQueue.length} transcript revision(s) still unsubmitted after ${STOP_TRANSCRIPT_DRAIN_MS} ms; final snapshot proceeds without them`);
        await this.finalSnapshot(drained);
      } else {
        this.setFinal('skipped', null, wasRunning ? 'camera not live at Stop' : 'run never reached running');
      }
      this.media.stop();
      this.deps.onLiveFaces(null);
      this.faceLink.stop();
      this.camera = 'off'; this.microphone = 'off';
      this.phase = this.failed ? 'error' : 'stopped';
      if (!wasRunning && !this.sessionId) this.reason = `${reason} (before the session was created)`;
      this.update();
    })();
    return this.stopPromise;
  }

  /**
   * People were deleted/reset on the server: discard every live label immediately and recycle the face
   * connection so no stale identity survives. Camera, microphone and speech keep running.
   */
  resetFaces(reason = 'people deleted'): void {
    if (!this.isActive) return;
    this.deps.onLiveFaces(null);
    this.setIntroduction({ ...idleIntroduction(`${reason}: labels discarded; face connection recycling`), sent: this.introduction.sent, skipped: this.introduction.skipped });
    this.faceLink.resetConnection(reason);
    this.liveFaces?.reset(reason); // the next stable identity set is re-sent on the fresh connection
    this.update();
  }

  private setFinal(stage: FinalCaptureState['stage'], id: string | null, detail: string): void {
    this.finalCapture = { stage, id: id ?? this.finalCapture.id, detail }; this.update();
  }

  /** Resolves true when the revision queue is empty and no POST is in flight, false on timeout. */
  private waitForTranscripts(maxMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      const deadline = this.clock.now() + maxMs;
      const check = () => {
        if (this.transcriptQueue.length === 0 && !this.transcriptPumping) { resolve(true); return; }
        if (this.clock.now() >= deadline) { resolve(false); return; }
        this.clock.setTimeout(check, 100);
      };
      check();
    });
  }

  /** The one Stop-time photo. Never waits on server-side memory completion. */
  private async finalSnapshot(transcriptsDrained: boolean): Promise<void> {
    const full = this.media.drawFull(FULL_MAX_SIDE);
    const sessionId = this.sessionId;
    if (!full || !sessionId) { this.setFinal('failed', null, 'no video frame available at Stop'); return; }
    const id = newId('capfinal', full.capturedAt);
    const sequence = this.sequences.next();
    this.setFinal('capturing', id, `sequence ${sequence} at ${full.capturedAt}${transcriptsDrained ? '' : ' (some transcript revisions unsubmitted)'}`);
    const face = this.media.deriveFace(full, FACE_MAX_SIDE);
    const entry: PendingPhoto = { id, sequence, capturedAt: full.capturedAt, width: full.width, height: full.height, audioStatus: 'unavailable', jpegBase64: null, requestId: null };
    this.pending.set(id, entry);
    this.counts.drawn += 1;
    let faceBuf: ArrayBuffer;
    try {
      const [fullBuf, f] = await Promise.all([MediaSource.encodeJpeg(full.canvas, 0.82), MediaSource.encodeJpeg(face.canvas, 0.85)]);
      entry.jpegBase64 = toBase64(fullBuf); faceBuf = f;
    } catch (e) { this.pending.delete(id); this.counts.encodeFailed += 1; this.setFinal('failed', id, `JPEG encode failed: ${msg(e)}`); return; }
    const photo: ScheduledPhoto = { id, sequence, capturedAt: full.capturedAt, faceJpeg: faceBuf, faceWidth: face.width, faceHeight: face.height, enqueuedAt: this.clock.now() };
    // Bounded wait for this photo's own face reply; otherwise drain → explicit unavailable with the same id/time/dims.
    const submitted = new Promise<void>((resolve) => { this.scheduledWaiters.set(id, resolve); });
    this.setFinal('awaiting-face', id, `face slot ${this.slot.isReady ? 'ready' : 'not ready'}; waiting ≤ ${STOP_FACE_WAIT_MS} ms`);
    const outcome = this.slot.enqueueScheduled(photo);
    if (outcome === 'rejected') this.counts.queueRejected += 1;
    const faceTimer = this.clock.setTimeout(() => { if (this.pending.has(id)) this.slot.drain('Stop face wait exceeded'); }, STOP_FACE_WAIT_MS);
    await submitted;
    this.clock.clearTimeout(faceTimer);
    this.scheduledWaiters.delete(id);
    this.setFinal('submitting', id, 'POST /api/captures (bounded)');
    const result = await Promise.race([
      this.awaitSubmission(id),
      new Promise<'timeout'>((r) => this.clock.setTimeout(() => r('timeout'), STOP_SUBMIT_WAIT_MS)),
    ]);
    const state = this.submissions.get(id);
    if (result === 'accepted') this.setFinal('accepted', id, `HTTP 202 in ${fmt(state?.latencyMs)} — accepted for processing, not yet remembered`);
    else if (result === 'timeout') this.setFinal('failed', id, `no HTTP answer within ${STOP_SUBMIT_WAIT_MS} ms; submission continues in the background (${state?.status ?? 'unknown'})`);
    else this.setFinal('failed', id, state?.error ?? 'submission failed');
  }

  private awaitSubmission(id: string): Promise<'accepted' | 'failed'> {
    return new Promise((resolve) => {
      const check = () => {
        const s = this.submissions.get(id);
        if (s?.status === 'accepted') { resolve('accepted'); return; }
        if (s?.status === 'failed') { resolve('failed'); return; }
        this.clock.setTimeout(check, 50);
      };
      check();
    });
  }

  // ---- capture cadence -------------------------------------------------------------------------
  private onTick(tick: TickInfo): void {
    if (this.stopped) return;
    this.counts.fired += 1; this.counts.skipped += tick.skipped;
    if (tick.skipped) this.error(`cadence skipped ${tick.skipped} tick(s) (page throttled?)`);
    if (tick.lateMs > 1000) this.error(`tick ${tick.index} fired ${Math.round(tick.lateMs)} ms late`);
    const full = this.media.drawFull(FULL_MAX_SIDE);
    if (!full || !this.sessionId) { this.counts.drawFailed += 1; this.error(`tick ${tick.index}: no video frame available`); this.update(); return; }
    const id = newId('cap', full.capturedAt);
    const sequence = this.sequences.next(); // shared with interrupt photos and the Stop snapshot: unique, strictly increasing
    const face = this.media.deriveFace(full, FACE_MAX_SIDE); // from the SAME canvas, never from the video
    const entry: PendingPhoto = { id, sequence, capturedAt: full.capturedAt, width: full.width, height: full.height,
      audioStatus: this.speech?.isReady ? 'live' : 'unavailable', jpegBase64: null, requestId: null };
    this.pending.set(id, entry);
    this.counts.drawn += 1; this.counts.encoding += 1;
    const sessionId = this.sessionId;
    Promise.all([MediaSource.encodeJpeg(full.canvas, 0.82), MediaSource.encodeJpeg(face.canvas, 0.85)]).then(([fullBuf, faceBuf]) => {
      this.counts.encoding -= 1;
      entry.jpegBase64 = toBase64(fullBuf);
      const photo: ScheduledPhoto = { id, sequence, capturedAt: full.capturedAt, faceJpeg: faceBuf, faceWidth: face.width, faceHeight: face.height, enqueuedAt: this.clock.now() };
      if (this.stopped) { // encoded after Stop: still this session's photo; submit it honestly without faces
        this.counts.faceGaps += 1;
        this.submitCapture(entry, unavailableFaceEvidence({ id, capturedAt: entry.capturedAt, width: face.width, height: face.height, streamId: this.slot.currentStreamId }), sessionId);
        return;
      }
      const outcome = this.slot.enqueueScheduled(photo);
      if (outcome === 'rejected') this.counts.queueRejected += 1;
      this.update();
    }).catch((e) => { this.counts.encoding -= 1; this.counts.encodeFailed += 1; this.pending.delete(id); this.error(`tick ${tick.index}: JPEG encode failed: ${msg(e)}`); this.update(); });
    this.update();
  }

  private onScheduledResult(r: ScheduledResult): void {
    const entry = this.pending.get(r.photo.id);
    if (!entry) { this.error(`face result for unknown photo ${r.photo.id}`); return; }
    if (r.evidence.status === 'ready') this.counts.faceReady += 1; else this.counts.faceUnavailable += 1;
    if (r.rttMs !== null) this.face.lastRttMs = r.rttMs;
    this.submitCapture(entry, r.evidence, this.sessionId);
  }

  private submitCapture(entry: PendingPhoto, faces: FaceEvidence, sessionId: string | null): void {
    this.pending.delete(entry.id);
    if (!sessionId || !entry.jpegBase64) { this.counts.encodeFailed += 1; this.error(`capture ${entry.id} has no encoded image; not submitted`); this.update(); return; }
    if (faces.frameId !== entry.id || faces.capturedAt !== entry.capturedAt) { this.error(`refusing to submit ${entry.id}: face evidence belongs to ${faces.frameId}@${faces.capturedAt}`); this.update(); return; }
    const body: CaptureInput = { id: entry.id, sessionId, sequence: entry.sequence, capturedAt: entry.capturedAt, width: entry.width, height: entry.height, jpegBase64: entry.jpegBase64, faces, audioStatus: entry.audioStatus, ...(entry.requestId ? { requestId: entry.requestId } : {}) };
    void this.submissions.submit(entry.id, body, entry.capturedAt).then((s) => { if (s === 'duplicate') this.error(`duplicate submission suppressed for ${entry.id}`); });
    this.update();
  }

  // ---- ~5 fps face loop -------------------------------------------------------------------------
  private faceTick(): void {
    if (this.stopped) return;
    this.slot.sweep();
    if (this.regularEncoding || this.slot.busy || this.slot.queued || !this.slot.isReady) return;
    const drawn = this.media.drawLiveFace(FACE_MAX_SIDE);
    if (!drawn) return;
    this.regularEncoding = true;
    MediaSource.encodeJpeg(drawn.canvas, 0.8).then((buf) => {
      this.regularEncoding = false;
      if (this.stopped) return;
      this.slot.offerRegular(buf, { id: newId('live', drawn.capturedAt), capturedAt: drawn.capturedAt, width: drawn.width, height: drawn.height });
    }).catch(() => { this.regularEncoding = false; });
  }

  // ---- speech -----------------------------------------------------------------------------------
  private onChunk(chunk: PcmChunk): void { if (!this.stopped) this.speech?.feed(chunk); }

  private onTranscript(t: Transcript): void {
    this.deps.onTranscript(t);
    // Bind at receipt: an introduction may only ever go to the face connection that was current now.
    this.transcriptQueue.push({ transcript: t, isFinal: t.isFinal, faceEpoch: this.faceLink.currentEpoch });
    void this.pumpTranscripts();
  }

  private async pumpTranscripts(): Promise<void> {
    if (this.transcriptPumping) return;
    this.transcriptPumping = true;
    try {
      for (let q = this.transcriptQueue.shift(); q; q = this.transcriptQueue.shift()) {
        const t = q.transcript;
        let accepted = false;
        try {
          const res = await api.postTranscript(t);
          accepted = res.ok && !/"accepted"\s*:\s*false/.test(res.text); // server answers 200 {accepted:false} for rejected revisions
          if (accepted) this.counts.tPosted += 1; else { this.counts.tFailed += 1; this.error(`transcript ${t.streamId}/${t.segmentId}@${t.revision} rejected: HTTP ${res.status} ${res.text.slice(0, 200)}`); }
        } catch (e) { this.counts.tFailed += 1; this.error(`transcript POST failed: ${msg(e)}`); }
        if (accepted && t.isFinal) this.forwardIntroduction(t, q.faceEpoch);
        this.scheduleUpdate();
      }
    } finally { this.transcriptPumping = false; }
  }

  // ---- spoken introductions (server decides; client forwards finals once, on the bound face connection) ----
  private forwardIntroduction(t: Transcript, boundEpoch: number): void {
    const decision = this.introductions.forward(t, { boundEpoch, currentEpoch: this.faceLink.currentEpoch, stopped: this.stopped });
    const excerpt = t.text.length > 60 ? `${t.text.slice(0, 57)}…` : t.text;
    switch (decision) {
      case 'sent': this.setIntroduction({ status: 'sent', message: `forwarded final “${excerpt}” to the face server; awaiting its decision`, name: null, personId: null, at: this.clock.now(), collected: null, required: null }); break;
      case 'face-changed': this.setIntroduction({ status: 'skipped', message: `final “${excerpt}” not forwarded: the face connection changed since it was heard`, at: this.clock.now() }); break;
      case 'send-failed': this.setIntroduction({ status: 'skipped', message: `final “${excerpt}” not forwarded: face connection not ready`, at: this.clock.now() }); break;
      case 'stopped': this.setIntroduction({ status: 'skipped', message: `final “${excerpt}” arrived after Stop; not forwarded`, at: this.clock.now() }); break;
      default: break; // duplicate / empty / not-final: nothing to show
    }
  }
  private onIntroductionReply(r: IntroductionReply, epoch: number): void {
    if (this.stopped || epoch !== this.faceLink.currentEpoch) return;
    this.setIntroduction({ status: r.status, message: r.message || r.status, name: r.name, personId: r.personId, at: this.clock.now(), collected: null, required: null });
  }
  private onEnrollmentReply(e: EnrollmentReply, epoch: number): void {
    if (this.stopped || epoch !== this.faceLink.currentEpoch) return;
    const progress = e.collected !== null && e.required !== null ? ` (${e.collected}/${e.required} samples)` : '';
    const message = e.status === 'collecting' ? `enrolling ${e.name ?? 'person'}${progress}${e.message ? ` · ${e.message}` : ''}`
      : e.status === 'complete' ? `enrolled ${e.name ?? 'person'}${progress}; box labels update from the server's own face votes`
      : `enrollment failed${e.name ? ` for ${e.name}` : ''}: ${e.message ?? 'unknown reason'}`;
    this.setIntroduction({ status: e.status, message, name: e.name, personId: e.personId ?? this.introduction.personId, at: this.clock.now(), collected: e.collected, required: e.required });
  }
  private setIntroduction(patch: Partial<IntroductionState>): void {
    this.introduction = { ...this.introduction, ...patch, sent: this.introductions.sent, skipped: this.introductions.skipped };
    this.scheduleUpdate();
  }

  // ---- state ------------------------------------------------------------------------------------
  private fail(message: string): void { this.error(message); this.failed = true; this.reason = message; void this.stop(message); }
  private error(message: string): void {
    this.errors.push({ at: this.clock.now(), message });
    if (this.errors.length > MAX_ERRORS) this.errors.splice(0, this.errors.length - MAX_ERRORS);
    this.scheduleUpdate();
  }
  private scheduleUpdate(): void {
    if (this.updateScheduled) return;
    this.updateScheduled = true;
    requestAnimationFrame(() => { this.updateScheduled = false; this.update(); });
  }
  private update(): void { this.deps.onUpdate(this.snapshot()); }

  private backlog(): RunSnapshot['backlog'] {
    let oldestPhoto = this.submissions.oldestUnsettledCapturedAt();
    for (const p of this.pending.values()) if (oldestPhoto === null || p.capturedAt < oldestPhoto) oldestPhoto = p.capturedAt;
    const sub = this.submissions.counts();
    const head = this.transcriptQueue.peek();
    return { photos: this.pending.size + sub.pending + sub.submitting, oldestPhotoCapturedAt: oldestPhoto, transcripts: this.transcriptQueue.length, oldestTranscriptReceivedAt: head ? head.transcript.receivedAt : null };
  }

  snapshot(): RunSnapshot {
    const sub = this.submissions.counts();
    const face = this.face.status ?? { phase: 'idle' as const, streamId: null, epoch: 0, attempt: 0, message: 'idle', model: null, backend: null, connections: 0 };
    const speech = this.speechStatus ?? { phase: 'idle' as const, streamId: null, attempt: 0, message: this.microphone === 'error' ? 'microphone unavailable' : 'idle', model: null, backend: null, chunksSent: 0, chunksDroppedBackpressure: 0, chunksDroppedNotReady: 0, runs: 0, anchoredAt: null, connections: 0, suppressedRevisions: 0 };
    return {
      phase: this.phase, sessionId: this.sessionId, startedAt: this.startedAt, reason: this.reason,
      camera: this.camera, microphone: this.microphone, videoSize: this.media.videoSize,
      ticks: { fired: this.counts.fired, skipped: this.counts.skipped, anchor: this.ticker.anchor, intervalMs: this.deps.config.captureIntervalMs },
      photos: { drawn: this.counts.drawn, drawFailed: this.counts.drawFailed, encodeFailed: this.counts.encodeFailed, encoding: this.counts.encoding, awaitingFace: this.pending.size - this.counts.encoding, faceReady: this.counts.faceReady, faceUnavailable: this.counts.faceUnavailable, faceGaps: this.counts.faceGaps, queueRejected: this.counts.queueRejected, faceQueued: this.slot.queued, interrupts: this.interruptCount, nextSequence: this.sequences.allocated },
      submissions: { ...sub, lastLatencyMs: this.lastLatencyMs, recent: this.submissions.recent(8) },
      face: { ...face, lastRttMs: this.face.lastRttMs, lastServerMs: this.face.lastServerMs, staleReplies: this.slot.staleReplies, slotBusy: this.slot.busy },
      speech,
      speechBackend: this.speechBackend,
      transcripts: { posted: this.counts.tPosted, failed: this.counts.tFailed, dropped: this.transcriptQueue.dropped, pendingHttp: this.transcriptQueue.length, suppressed: this.speech?.ledger.suppressed ?? 0 },
      introduction: this.introduction,
      micLevel: this.micLevel,
      finalCapture: this.finalCapture,
      interrupt: this.interrupt,
      liveFaces: this.liveFaceState,
      backlog: this.backlog(),
      errors: [...this.errors],
    };
  }
}

export function wsUrl(path: string, params: Record<string, string>): string {
  const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${scheme}//${location.host}${path}?${new URLSearchParams(params).toString()}`;
}

export function toBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let out = '';
  for (let i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + 0x8000)));
  return btoa(out);
}

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));
