// The single outstanding-request slot for /ws/faces, shared by the ~5 fps regular loop and the
// 5-second scheduled photos. Rules:
//   - at most ONE JPEG outstanding on the socket, ever;
//   - a scheduled photo that arrives while the slot is busy waits in a bounded queue and is sent
//     UNCHANGED at the next free slot (its derivative, its id, its capturedAt, its dimensions);
//   - a reply resolves only the flight that is outstanding on the SAME socket epoch; anything else is stale;
//   - reply geometry must equal the sent derivative's dimensions;
//   - on timeout / socket loss / queue overflow / stop, a scheduled photo is reported with
//     faces.status 'unavailable' and an empty face list — never with a neighbouring reply.
import type { Clock, FaceEvidence } from './types.ts';
import { faceEvidenceFromReply, unavailableFaceEvidence, verifyReplyGeometry, type RawFaceReply, type SentFrameMeta } from './faceBinding.ts';

export interface ScheduledPhoto {
  id: string; sequence: number; capturedAt: number;
  faceJpeg: ArrayBuffer; faceWidth: number; faceHeight: number; enqueuedAt: number;
}
interface Flight {
  kind: 'regular' | 'scheduled'; id: string; capturedAt: number; width: number; height: number;
  sentAt: number; epoch: number; streamId: string; photo: ScheduledPhoto | null; timer: unknown; busyRetries: number;
}
export interface RegularResult { evidence: FaceEvidence; rttMs: number; timings: Record<string, number> | null }
export interface ScheduledResult { photo: ScheduledPhoto; evidence: FaceEvidence; rttMs: number | null; reason: string | null }

export interface FaceSlotEvents {
  /** Send bytes on the current socket; return false when it is not open (the slot then treats it as lost). */
  send(jpeg: ArrayBuffer, epoch: number): boolean;
  onRegularResult(result: RegularResult): void;
  onScheduledResult(result: ScheduledResult): void;
  /** A scheduled photo could not get real face evidence (queue overflow, timeout, socket lost, stop...). */
  onGap(info: { photoId: string; reason: string }): void;
  onStaleReply(info: { reason: string }): void;
  requestReconnect(reason: string): void;
}
export interface FaceSlotOptions {
  clock: Clock; events: FaceSlotEvents;
  maxQueue?: number; responseTimeoutMs?: number; maxQueueWaitMs?: number; maxBusyRetries?: number;
}

export class FaceSlot {
  private outstanding: Flight | null = null;
  private queue: { photo: ScheduledPhoto; busyRetries: number }[] = [];
  private epoch = 0;
  private streamId = 'faces_disconnected';
  private ready = false;
  private readonly maxQueue: number;
  private readonly responseTimeoutMs: number;
  private readonly maxQueueWaitMs: number;
  private readonly maxBusyRetries: number;
  staleReplies = 0;

  constructor(private readonly opts: FaceSlotOptions) {
    this.maxQueue = opts.maxQueue ?? 2;
    this.responseTimeoutMs = opts.responseTimeoutMs ?? 4000;
    this.maxQueueWaitMs = opts.maxQueueWaitMs ?? 6000;
    this.maxBusyRetries = opts.maxBusyRetries ?? 4;
  }

  get busy(): boolean { return this.outstanding !== null; }
  get queued(): number { return this.queue.length; }
  get isReady(): boolean { return this.ready; }
  get currentEpoch(): number { return this.epoch; }
  get currentStreamId(): string { return this.streamId; }

  /** Called when a socket becomes ready (server sent `ready`). Each socket has a fresh epoch and namespace. */
  socketReady(epoch: number, streamId: string): void {
    this.epoch = epoch; this.streamId = streamId; this.ready = true;
    this.pump();
  }

  /** The socket with this epoch closed or errored. Anything outstanding on it can never be answered. */
  socketLost(epoch: number, reason: string): void {
    if (epoch !== this.epoch) return;
    this.ready = false;
    const flight = this.outstanding;
    if (flight && flight.epoch === epoch) {
      this.clearFlight();
      if (flight.kind === 'scheduled' && flight.photo) this.giveUp(flight.photo, `face connection lost before reply (${reason})`, flight.streamId);
    }
  }

  /** Regular ~5 fps frame. Returns false when the slot is busy, not ready, or a scheduled photo is waiting. */
  offerRegular(jpeg: ArrayBuffer, meta: { id: string; capturedAt: number; width: number; height: number }): boolean {
    if (!this.ready || this.outstanding || this.queue.length) return false;
    return this.dispatch({ kind: 'regular', ...meta, photo: null, busyRetries: 0 }, jpeg);
  }

  /** Scheduled photo derivative. Sent now, or queued (bounded), or reported unavailable when the queue is full. */
  enqueueScheduled(photo: ScheduledPhoto): 'sent' | 'queued' | 'rejected' {
    if (this.ready && !this.outstanding && this.queue.length === 0) {
      const sent = this.dispatch({ kind: 'scheduled', id: photo.id, capturedAt: photo.capturedAt,
        width: photo.faceWidth, height: photo.faceHeight, photo, busyRetries: 0 }, photo.faceJpeg);
      if (sent) return 'sent';
      // socket vanished between ready and send: fall through to queueing so the photo is not lost
    }
    if (this.queue.length >= this.maxQueue) {
      this.giveUp(photo, `face queue full (${this.maxQueue} waiting); inference is slower than the capture cadence`);
      return 'rejected';
    }
    this.queue.push({ photo, busyRetries: 0 });
    return 'queued';
  }

  onReply(reply: RawFaceReply, epoch: number): void {
    const flight = this.outstanding;
    if (!flight) { this.stale('reply with nothing outstanding'); return; }
    if (epoch !== flight.epoch) { this.stale(`reply from socket epoch ${epoch}, outstanding is ${flight.epoch}`); return; }
    this.clearFlight();
    const meta: SentFrameMeta = { id: flight.id, capturedAt: flight.capturedAt, width: flight.width, height: flight.height, streamId: flight.streamId };
    const rtt = this.opts.clock.now() - flight.sentAt;
    const geometry = verifyReplyGeometry(reply, meta);
    if (flight.kind === 'scheduled' && flight.photo) {
      if (geometry.ok) {
        const bound = faceEvidenceFromReply(reply, meta);
        this.opts.events.onScheduledResult({ photo: flight.photo, evidence: bound.evidence, rttMs: rtt,
          reason: bound.rejectedBoxes ? `${bound.rejectedBoxes} malformed box(es) dropped` : null });
      } else {
        this.giveUp(flight.photo, `reply rejected: ${geometry.reason}`, flight.streamId, rtt);
      }
    } else if (geometry.ok) {
      this.opts.events.onRegularResult({ evidence: faceEvidenceFromReply(reply, meta).evidence, rttMs: rtt, timings: reply.timings_ms ?? null });
    } else {
      this.stale(`regular ${geometry.reason}`);
    }
    this.pump();
  }

  /** Server answered `busy` (rate limit / lock). Regular frames are dropped; scheduled photos retry, bounded. */
  onBusy(epoch: number): void {
    const flight = this.outstanding;
    if (!flight || epoch !== flight.epoch) { this.stale('busy with nothing outstanding'); return; }
    this.clearFlight();
    if (flight.kind === 'scheduled' && flight.photo) {
      if (flight.busyRetries >= this.maxBusyRetries) this.giveUp(flight.photo, `face server busy ${flight.busyRetries + 1} times`, flight.streamId);
      else this.queue.unshift({ photo: flight.photo, busyRetries: flight.busyRetries + 1 });
    }
    // retry after the server's 190 ms minimum spacing
    this.opts.clock.setTimeout(() => this.pump(), 200);
  }

  /** Called periodically; expires queued photos that waited too long and sends anything ready. */
  sweep(): void {
    const now = this.opts.clock.now();
    for (const item of [...this.queue]) {
      if (now - item.photo.enqueuedAt > this.maxQueueWaitMs) {
        this.queue = this.queue.filter((q) => q !== item);
        this.giveUp(item.photo, `waited ${Math.round((now - item.photo.enqueuedAt) / 1000)} s for a face slot`);
      }
    }
    this.pump();
  }

  /** Every pending scheduled photo is reported unavailable explicitly; nothing is left dangling. */
  drain(reason: string): void {
    const flight = this.outstanding;
    this.clearFlight();
    if (flight?.kind === 'scheduled' && flight.photo) this.giveUp(flight.photo, `${reason} before face reply`, flight.streamId);
    const rest = this.queue; this.queue = [];
    for (const item of rest) this.giveUp(item.photo, `${reason} while waiting for a face slot`);
    if (flight) {
      // The server still owes a reply for the abandoned frame. On this socket it would be taken for the
      // next flight's answer, so the socket is untrustworthy until recycled: readiness off, new epoch requested.
      this.ready = false;
      this.opts.events.requestReconnect(`${reason} abandoned an outstanding face request`);
    }
    // an idle drain keeps readiness: Stop's single final snapshot can go out on the same socket
  }

  // ---- internals ------------------------------------------------------------------------------
  private dispatch(spec: Omit<Flight, 'sentAt' | 'epoch' | 'streamId' | 'timer'>, jpeg: ArrayBuffer): boolean {
    const epoch = this.epoch;
    const flight: Flight = { ...spec, sentAt: this.opts.clock.now(), epoch, streamId: this.streamId, timer: null };
    this.outstanding = flight;
    const ok = this.opts.events.send(jpeg, epoch);
    if (!ok) {
      this.outstanding = null; this.ready = false;
      return false;
    }
    flight.timer = this.opts.clock.setTimeout(() => this.onTimeout(flight), this.responseTimeoutMs);
    return true;
  }
  private onTimeout(flight: Flight): void {
    if (this.outstanding !== flight) return;
    this.clearFlight();
    if (flight.kind === 'scheduled' && flight.photo) this.giveUp(flight.photo, `no face reply within ${this.responseTimeoutMs} ms`, flight.streamId);
    this.ready = false; // a socket that lost a reply cannot be trusted with the next frame
    this.opts.events.requestReconnect(`face reply timeout after ${this.responseTimeoutMs} ms`);
  }

  private pump(): void {
    if (!this.ready || this.outstanding) return;
    const next = this.queue.shift();
    if (!next) return;
    const sent = this.dispatch({ kind: 'scheduled', id: next.photo.id, capturedAt: next.photo.capturedAt,
      width: next.photo.faceWidth, height: next.photo.faceHeight, photo: next.photo, busyRetries: next.busyRetries }, next.photo.faceJpeg);
    if (!sent) this.queue.unshift(next);
  }

  private clearFlight(): void {
    const f = this.outstanding;
    if (f?.timer !== null && f?.timer !== undefined) this.opts.clock.clearTimeout(f.timer);
    this.outstanding = null;
  }

  private stale(reason: string): void {
    this.staleReplies += 1;
    this.opts.events.onStaleReply({ reason });
  }

  private giveUp(photo: ScheduledPhoto, reason: string, streamId: string = this.streamId, rttMs: number | null = null): void {
    const meta: SentFrameMeta = { id: photo.id, capturedAt: photo.capturedAt, width: photo.faceWidth, height: photo.faceHeight, streamId };
    this.opts.events.onGap({ photoId: photo.id, reason });
    this.opts.events.onScheduledResult({ photo, evidence: unavailableFaceEvidence(meta), rttMs, reason });
  }
}
