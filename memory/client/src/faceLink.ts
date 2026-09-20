// /ws/faces connection owner. Protocol (tools/perception_lab/server.py): server sends {type:"ready",
// max_fps, max_side} first; client sends one binary JPEG at a time; server answers {type:"frame",
// frame_id, faces:[{track_id, box, stable_id, stable_name, match}], input_wh} or {type:"busy"} or
// {type:"error"}. The server ends the socket after 600 s, so we recycle at 560 s when the slot is idle.
// Every connection has its own epoch (for reply attribution) and streamId (evidence namespace).
// Control plane on the same socket: the client may send {type:"introduction", ...} (a finalized,
// server-accepted transcript) and the server answers {type:"introduction", status, ...}; frame replies
// may additionally carry `enrollment` progress. Both are routed to optional callbacks with their epoch.
import type { Clock } from './types.ts';
import { newId } from './ids.ts';
import type { FaceSlot } from './faceSlot.ts';
import type { RawFaceReply } from './faceBinding.ts';
import { parseEnrollmentReply, parseIntroductionReply, type EnrollmentReply, type IntroductionPayload, type IntroductionReply } from './introductions.ts';

export type FacePhase = 'idle' | 'connecting' | 'ready' | 'reconnecting' | 'stopped' | 'error';
export interface FaceLinkStatus { phase: FacePhase; streamId: string | null; epoch: number; attempt: number; message: string; model: string | null; backend: string | null; connections: number }

const READY_TIMEOUT_MS = 20000;
const LIFETIME_MS = 560_000;
const BACKOFF_MS = [1000, 2000, 4000, 8000];
const MAX_ATTEMPTS = 6;
const RESET_AFTER_MS = 30_000;

export class FaceLink {
  private ws: WebSocket | null = null;
  private epoch = 0;
  private streamId: string | null = null;
  private active = false;
  private attempt = 0;
  private timers = new Set<unknown>();
  private readyAt: number | null = null;
  private status: FaceLinkStatus = { phase: 'idle', streamId: null, epoch: 0, attempt: 0, message: 'idle', model: null, backend: null, connections: 0 };
  private lastServerError: string | null = null;

  constructor(private readonly opts: {
    url: string; slot: FaceSlot; clock: Clock; onStatus: (s: FaceLinkStatus) => void; onError: (message: string) => void;
    onIntroduction?: (reply: IntroductionReply, epoch: number) => void;
    onEnrollment?: (reply: EnrollmentReply, epoch: number) => void;
  }) {}

  get current(): FaceLinkStatus { return this.status; }
  /** Epoch of the connection currently owned (incremented on every connect). 0 before the first connect. */
  get currentEpoch(): number { return this.epoch; }
  /** True only while the current socket is open AND the server has sent `ready` on it. */
  get isReady(): boolean { return this.readyAt !== null && this.ws !== null && this.ws.readyState === WebSocket.OPEN; }

  start(): void {
    if (this.active) return;
    this.active = true; this.attempt = 0;
    this.connect();
  }

  stop(): void {
    this.active = false;
    this.clearTimers();
    const ws = this.ws; const epoch = this.epoch;
    this.detach(ws); this.ws = null;
    try { ws?.close(); } catch { /* ignore */ }
    this.opts.slot.socketLost(epoch, 'stopped');
    this.emit({ phase: 'stopped', message: 'stopped' });
  }

  /** FaceSlot.send hook: refuses anything not addressed to the current open socket. */
  send(jpeg: ArrayBuffer, epoch: number): boolean {
    if (epoch !== this.epoch || !this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    try { this.ws.send(jpeg); return true; } catch { return false; }
  }

  /**
   * Forward one finalized introduction on the SAME connection whose epoch the caller bound at receipt.
   * Refused (false) when that epoch is no longer current, the socket is not open, or `ready` never
   * arrived on it — a changed face connection never receives a replayed introduction.
   */
  sendIntroduction(payload: IntroductionPayload, epoch: number): boolean {
    if (epoch !== this.epoch || !this.isReady || !this.ws) return false;
    try { this.ws.send(JSON.stringify(payload)); return true; } catch { return false; }
  }

  /** Deliberate recycle (e.g. people were deleted): drop the socket now so no stale label survives. */
  resetConnection(reason: string): void {
    if (!this.active) return;
    this.attempt = 0;
    this.reconnect(reason);
  }

  /** Called by the slot (timeout) or by the lifetime timer. */
  reconnect(reason: string): void {
    if (!this.active) return;
    const ws = this.ws; const epoch = this.epoch;
    this.detach(ws); this.ws = null;
    try { ws?.close(); } catch { /* ignore */ }
    this.opts.slot.socketLost(epoch, reason);
    this.scheduleReconnect(reason);
  }

  // ---- internals ------------------------------------------------------------------------------
  private connect(): void {
    if (!this.active) return;
    this.clearTimers();
    const epoch = ++this.epoch;
    const streamId = newId('faces', this.opts.clock.now());
    this.streamId = streamId; this.readyAt = null; this.lastServerError = null;
    this.status.connections += 1;
    this.emit({ phase: this.attempt ? 'reconnecting' : 'connecting', streamId, epoch, message: this.attempt ? `reconnecting (attempt ${this.attempt})` : 'connecting' });
    let ws: WebSocket;
    try { ws = new WebSocket(this.opts.url); } catch (e) { this.fail(epoch, `cannot open face socket: ${e instanceof Error ? e.message : String(e)}`); return; }
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    const readyTimer = this.timer(() => { if (this.ws === ws) this.fail(epoch, `face model not ready within ${READY_TIMEOUT_MS / 1000} s`); }, READY_TIMEOUT_MS);
    ws.onopen = () => { if (this.ws === ws) this.emit({ message: 'connected, waiting for the face model' }); };
    ws.onmessage = (ev: MessageEvent) => {
      if (this.ws !== ws) return; // stale socket: its replies cannot resolve a newer flight
      let msg: { type?: string; message?: string; model?: string; backend?: string } & Partial<Omit<RawFaceReply, 'type'>>;
      try { msg = JSON.parse(String(ev.data)); } catch { return; }
      switch (msg.type) {
        case 'ready':
          this.opts.clock.clearTimeout(readyTimer); this.timers.delete(readyTimer);
          this.readyAt = this.opts.clock.now();
          this.emit({ phase: 'ready', message: `ready (${msg.model ?? 'face model'} via ${msg.backend ?? '?'})`, model: msg.model ?? null, backend: msg.backend ?? null });
          this.opts.slot.socketReady(epoch, streamId);
          this.timer(() => this.recycle(epoch, 0), LIFETIME_MS);
          break;
        case 'frame': {
          const enrollment = parseEnrollmentReply((msg as { enrollment?: unknown }).enrollment);
          if (enrollment) this.opts.onEnrollment?.(enrollment, epoch);
          this.opts.slot.onReply(msg as unknown as RawFaceReply, epoch);
          break;
        }
        case 'introduction': {
          const reply = parseIntroductionReply(msg);
          if (reply) this.opts.onIntroduction?.(reply, epoch);
          else this.opts.onError('face server: malformed introduction reply');
          break;
        }
        case 'busy': this.opts.slot.onBusy(epoch); break;
        case 'error':
          this.lastServerError = msg.message ?? 'server error';
          this.opts.onError(`face server: ${this.lastServerError}`);
          break;
        default: break;
      }
    };
    ws.onerror = () => { if (this.ws === ws) this.emit({ message: 'websocket error' }); };
    ws.onclose = () => { if (this.ws === ws) this.fail(epoch, this.lastServerError ? `face connection closed: ${this.lastServerError}` : 'face connection closed'); };
  }

  /** Planned recycle before the server's 600 s limit; waits (bounded) for the slot to be idle. */
  private recycle(epoch: number, tries: number): void {
    if (!this.active || epoch !== this.epoch) return;
    if (this.opts.slot.busy && tries < 40) { this.timer(() => this.recycle(epoch, tries + 1), 250); return; }
    this.attempt = 0;
    this.reconnect('planned 560 s connection recycle');
  }

  private fail(epoch: number, reason: string): void {
    if (epoch !== this.epoch) return;
    const ws = this.ws; this.detach(ws); this.ws = null;
    try { ws?.close(); } catch { /* ignore */ }
    this.opts.slot.socketLost(epoch, reason);
    this.opts.onError(reason);
    if (this.readyAt !== null && this.opts.clock.now() - this.readyAt >= RESET_AFTER_MS) this.attempt = 0;
    this.scheduleReconnect(reason);
  }

  private scheduleReconnect(reason: string): void {
    if (!this.active) return;
    this.clearTimers();
    if (this.attempt >= MAX_ATTEMPTS) { this.emit({ phase: 'error', message: `${reason}; gave up after ${this.attempt} attempts` }); return; }
    this.attempt += 1;
    const delay = BACKOFF_MS[Math.min(this.attempt - 1, BACKOFF_MS.length - 1)]!;
    this.emit({ phase: 'reconnecting', streamId: null, message: `${reason}; reconnecting in ${delay / 1000} s (attempt ${this.attempt})` });
    this.timer(() => this.connect(), delay);
  }

  private timer(fn: () => void, ms: number): unknown {
    const h = this.opts.clock.setTimeout(() => { this.timers.delete(h); fn(); }, ms);
    this.timers.add(h); return h;
  }
  private clearTimers(): void { for (const h of this.timers) this.opts.clock.clearTimeout(h); this.timers.clear(); }
  private detach(ws: WebSocket | null): void { if (ws) { ws.onopen = null; ws.onmessage = null; ws.onerror = null; ws.onclose = null; } }
  private emit(patch: Partial<FaceLinkStatus>): void {
    this.status = { ...this.status, streamId: this.streamId, epoch: this.epoch, attempt: this.attempt, ...patch };
    this.opts.onStatus(this.status);
  }
}
