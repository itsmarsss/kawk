// /ws/speech?backend=local|baseten connection owner (the backend is chosen per Run). Protocol (tools/perception_lab/speech.py): server sends
// {type:"connecting"} then {type:"ready", sample_rate:16000, chunk_samples:512}; the client sends
// 1024-byte PCM16 chunks; the server relays {type:"transcript", segment_id, text, is_final,
// words:[{word,start_time,end_time}]} where offsets are seconds since the first PCM the cloud received,
// i.e. since the first chunk WE SENT on this socket. {type:"stop"} asks for the last final.
// Each connection = new streamId + fresh SentAudioTimeline; a reconnect never reuses either.
import type { Clock, Transcript } from './types.ts';
import { newId } from './ids.ts';
import { CHUNK_BYTES, CHUNK_MS, SentAudioTimeline, boundSegmentInterval, mapWords, type RawWord } from './speechTiming.ts';
import { RevisionLedger } from './revisions.ts';
import type { PcmChunk } from './media.ts';

export type SpeechPhase = 'idle' | 'connecting' | 'ready' | 'reconnecting' | 'stopping' | 'stopped' | 'error';
export interface SpeechLinkStatus {
  phase: SpeechPhase; streamId: string | null; attempt: number; message: string; model: string | null;
  /** Backend the server's `ready` message reported ('local' | 'baseten'); null until ready. */
  backend: string | null;
  chunksSent: number; chunksDroppedBackpressure: number; chunksDroppedNotReady: number; runs: number;
  anchoredAt: number | null; connections: number; suppressedRevisions: number;
}

const READY_TIMEOUT_MS = 130_000; // server waits up to 120 s for a cold Baseten replica
const MAX_BUFFERED_BYTES = 16 * CHUNK_BYTES; // 512 ms
const MAX_CONSECUTIVE_BACKLOG = 31; // ~1 s of dropped audio → fresh namespace instead of shifted words
const FLUSH_CHUNKS = 16; // 512 ms of zeros so the server VAD closes the utterance
const CLOSE_GRACE_MS = 2500;
const BACKOFF_MS = [1000, 2000, 4000, 8000];
const MAX_ATTEMPTS = 5;
const RESET_AFTER_MS = 30_000;

interface Connection {
  epoch: number; streamId: string; ws: WebSocket | null; ready: boolean; readyAt: number | null;
  timeline: SentAudioTimeline; prevFinalEndMs: number | null; consecutiveBacklog: number; lastServerError: string | null; permanent: boolean;
}

export class SpeechLink {
  private conn: Connection | null = null;
  private epoch = 0;
  private active = false;
  private stopping = false;
  private attempt = 0;
  private timers = new Set<unknown>();
  readonly ledger = new RevisionLedger();
  private status: SpeechLinkStatus = { phase: 'idle', streamId: null, attempt: 0, message: 'idle', model: null, backend: null, chunksSent: 0, chunksDroppedBackpressure: 0, chunksDroppedNotReady: 0, runs: 0, anchoredAt: null, connections: 0, suppressedRevisions: 0 };

  constructor(private readonly opts: {
    url: string; sessionId: string; clock: Clock;
    onTranscript: (t: Transcript) => void; onStatus: (s: SpeechLinkStatus) => void; onError: (message: string) => void;
  }) {}

  get current(): SpeechLinkStatus { return this.status; }
  get isReady(): boolean { return Boolean(this.conn?.ready && this.conn.ws?.readyState === WebSocket.OPEN); }

  start(): void {
    if (this.active) return;
    this.active = true; this.stopping = false; this.attempt = 0;
    this.connect();
  }

  /** Feed one microphone chunk. Dropped (never queued) unless the current connection is ready. */
  feed(chunk: PcmChunk): void {
    const c = this.conn;
    if (this.stopping || !c || !c.ready || !c.ws || c.ws.readyState !== WebSocket.OPEN) { this.status.chunksDroppedNotReady += 1; return; }
    if (chunk.buffer.byteLength !== CHUNK_BYTES) return;
    if (c.ws.bufferedAmount > MAX_BUFFERED_BYTES) {
      this.status.chunksDroppedBackpressure += 1;
      c.consecutiveBacklog += 1;
      if (c.consecutiveBacklog > MAX_CONSECUTIVE_BACKLOG) this.fail(c, 'audio backlog over 1 s; reconnecting into a fresh stream instead of shifting word times');
      return; // the timeline is NOT advanced: the next sent chunk starts a new run at its true source time
    }
    try { c.ws.send(chunk.buffer); } catch { this.status.chunksDroppedBackpressure += 1; return; }
    c.timeline.recordSent(chunk.captureTsMs);
    c.consecutiveBacklog = 0;
    this.status.chunksSent += 1;
    if (this.status.chunksSent % 25 === 0) this.emit({});
  }

  /** ~500 ms of paced silence, {type:"stop"}, wait briefly for the last final, then release. */
  stop(): Promise<void> {
    if (!this.active && !this.conn) return Promise.resolve();
    this.active = false; this.stopping = true;
    this.clearTimers();
    const c = this.conn;
    if (!c || !c.ready || !c.ws || c.ws.readyState !== WebSocket.OPEN) { this.finish(c, 'stopped'); return Promise.resolve(); }
    this.emit({ phase: 'stopping', message: 'flushing 500 ms of silence and waiting for the final transcript' });
    return new Promise<void>((resolve) => {
      let sent = 0;
      const done = () => { this.finish(c, 'stopped'); resolve(); };
      const step = () => {
        if (this.conn !== c || !c.ws || c.ws.readyState !== WebSocket.OPEN) { done(); return; }
        if (sent < FLUSH_CHUNKS) {
          try { c.ws.send(new ArrayBuffer(CHUNK_BYTES)); } catch { done(); return; }
          c.timeline.recordSent(c.timeline.sentEndMs ?? this.opts.clock.now()); // contiguous: keeps later offsets mappable
          sent += 1;
          this.timer(step, CHUNK_MS);
          return;
        }
        try { c.ws.send(JSON.stringify({ type: 'stop' })); } catch { done(); return; }
        const grace = this.timer(done, CLOSE_GRACE_MS);
        if (c.ws) c.ws.onclose = () => { this.opts.clock.clearTimeout(grace); this.timers.delete(grace); done(); };
      };
      this.timer(step, CHUNK_MS);
    });
  }

  // ---- internals ------------------------------------------------------------------------------
  private connect(): void {
    if (!this.active) return;
    this.clearTimers();
    const c: Connection = {
      epoch: ++this.epoch, streamId: newId('speech', this.opts.clock.now()), ws: null, ready: false, readyAt: null,
      timeline: new SentAudioTimeline(), prevFinalEndMs: null, consecutiveBacklog: 0, lastServerError: null, permanent: false,
    };
    this.conn = c;
    this.status.connections += 1;
    this.emit({ phase: this.attempt ? 'reconnecting' : 'connecting', streamId: c.streamId, anchoredAt: null, runs: 0, backend: null, model: null, message: this.attempt ? `reconnecting (attempt ${this.attempt})` : 'connecting to the speech relay' });
    let ws: WebSocket;
    try { ws = new WebSocket(this.opts.url); } catch (e) { this.fail(c, `cannot open speech socket: ${e instanceof Error ? e.message : String(e)}`); return; }
    ws.binaryType = 'arraybuffer';
    c.ws = ws;
    const readyTimer = this.timer(() => { if (this.conn === c && !c.ready) this.fail(c, `speech backend not ready within ${READY_TIMEOUT_MS / 1000} s (cloud model may be waking)`); }, READY_TIMEOUT_MS);
    ws.onopen = () => { if (this.conn === c) this.emit({ message: 'connected, waiting for the speech backend (PCM is NOT sent yet)' }); };
    ws.onmessage = (ev: MessageEvent) => {
      if (this.conn !== c || c.ws !== ws) return; // old socket: its transcripts belong to a namespace we no longer feed
      let msg: { type?: string; message?: string; model?: string; backend?: string; retryable?: boolean; segment_id?: unknown; text?: unknown; is_final?: unknown; words?: RawWord[] };
      try { msg = JSON.parse(String(ev.data)); } catch { return; }
      switch (msg.type) {
        case 'connecting': this.emit({ message: 'relay is connecting to the cloud backend' }); break;
        case 'ready':
          this.opts.clock.clearTimeout(readyTimer); this.timers.delete(readyTimer);
          c.ready = true; c.readyAt = this.opts.clock.now();
          this.emit({ phase: 'ready', model: msg.model ?? null, backend: typeof msg.backend === 'string' ? msg.backend : null, message: `listening (${msg.model ?? 'speech backend'} via ${msg.backend ?? '?'}); offsets anchor to the first PCM sent` });
          break;
        case 'transcript': this.onTranscript(c, msg); break;
        case 'error':
          c.lastServerError = msg.message ?? 'server error';
          if (msg.retryable === false) c.permanent = true;
          this.opts.onError(`speech server: ${c.lastServerError}`);
          break;
        default: break;
      }
    };
    ws.onerror = () => { if (this.conn === c && c.ws === ws) this.emit({ message: 'websocket error' }); };
    ws.onclose = () => { if (this.conn === c && c.ws === ws) this.fail(c, c.lastServerError ? `speech connection closed: ${c.lastServerError}` : 'speech connection closed'); };
  }

  private onTranscript(c: Connection, msg: { segment_id?: unknown; text?: unknown; is_final?: unknown; words?: RawWord[] }): void {
    const receivedAt = this.opts.clock.now();
    const segmentId = String(msg.segment_id ?? '0');
    const text = typeof msg.text === 'string' ? msg.text : '';
    const isFinal = Boolean(msg.is_final);
    const words = mapWords(msg.words, c.timeline);
    const interval = boundSegmentInterval(words, { prevFinalEndMs: c.prevFinalEndMs, timeline: c.timeline, receivedAt });
    const t = this.ledger.apply({ sessionId: this.opts.sessionId, streamId: c.streamId, segmentId, text, isFinal, words, startAt: interval.startAt, endAt: interval.endAt, receivedAt });
    this.status.suppressedRevisions = this.ledger.suppressed;
    if (!t) return;
    if (t.isFinal) c.prevFinalEndMs = t.endAt;
    this.emit({ anchoredAt: c.timeline.anchoredAtMs, runs: c.timeline.runCount });
    this.opts.onTranscript(t);
  }

  private fail(c: Connection, reason: string): void {
    if (this.conn !== c) return;
    const ws = c.ws; c.ws = null; c.ready = false;
    if (ws) { ws.onopen = null; ws.onmessage = null; ws.onerror = null; ws.onclose = null; try { ws.close(); } catch { /* ignore */ } }
    this.opts.onError(reason);
    if (this.stopping || !this.active) { this.finish(c, 'stopped'); return; }
    if (c.readyAt !== null && this.opts.clock.now() - c.readyAt >= RESET_AFTER_MS) this.attempt = 0;
    if (c.permanent || this.attempt >= MAX_ATTEMPTS) {
      this.conn = null; this.active = false;
      this.emit({ phase: 'error', streamId: null, message: c.permanent ? reason : `${reason}; gave up after ${this.attempt} attempts` });
      return;
    }
    this.attempt += 1;
    const delay = BACKOFF_MS[Math.min(this.attempt - 1, BACKOFF_MS.length - 1)]!;
    this.conn = null;
    this.emit({ phase: 'reconnecting', streamId: null, message: `${reason}; reconnecting in ${delay / 1000} s (attempt ${this.attempt}) with a new stream` });
    this.timer(() => this.connect(), delay);
  }

  private finish(c: Connection | null, phase: 'stopped'): void {
    this.clearTimers();
    if (c) { const ws = c.ws; c.ws = null; c.ready = false; if (ws) { ws.onopen = null; ws.onmessage = null; ws.onerror = null; ws.onclose = null; try { ws.close(); } catch { /* ignore */ } } }
    if (this.conn === c) this.conn = null;
    this.stopping = false;
    this.emit({ phase, message: 'stopped' });
  }

  private timer(fn: () => void, ms: number): unknown {
    const h = this.opts.clock.setTimeout(() => { this.timers.delete(h); fn(); }, ms);
    this.timers.add(h); return h;
  }
  private clearTimers(): void { for (const h of this.timers) this.opts.clock.clearTimeout(h); this.timers.clear(); }
  private emit(patch: Partial<SpeechLinkStatus>): void {
    this.status = { ...this.status, attempt: this.attempt, streamId: this.conn?.streamId ?? patch.streamId ?? null, ...patch };
    this.opts.onStatus(this.status);
  }
}
