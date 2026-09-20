// Maps cloud word offsets (seconds since the FIRST PCM chunk actually sent on a connection) back to
// source capture time. Cloud time is continuous over SENT chunks (32 ms each); source time jumps
// wherever microphone chunks were skipped/dropped, so the mapping is piecewise: one run per
// contiguous stretch of sent audio. Later words are never shifted by an earlier gap.
import type { Word } from './types.ts';

export const CHUNK_SAMPLES = 512;
export const CHUNK_BYTES = CHUNK_SAMPLES * 2;
export const CHUNK_MS = (CHUNK_SAMPLES / 16000) * 1000; // 32

interface Run { cloudStartS: number; sourceStartMs: number; chunks: number }

export class SentAudioTimeline {
  private runs: Run[] = [];
  private sent = 0;
  constructor(private readonly toleranceMs: number = CHUNK_MS * 1.5) {}

  get chunksSent(): number { return this.sent; }
  get runCount(): number { return this.runs.length; }
  /** Source time of the first PCM sent; null until something was sent. */
  get anchoredAtMs(): number | null { return this.runs[0]?.sourceStartMs ?? null; }
  /** Source time of the END of the last chunk sent. */
  get sentEndMs(): number | null {
    const last = this.runs[this.runs.length - 1];
    return last ? last.sourceStartMs + last.chunks * CHUNK_MS : null;
  }
  get cloudEndS(): number { return this.sent * CHUNK_MS / 1000; }

  /** Record one 512-sample chunk that was actually handed to the socket, with the source time of its first sample. */
  recordSent(sourceTsMs: number): void {
    const last = this.runs[this.runs.length - 1];
    if (last) {
      const expected = last.sourceStartMs + last.chunks * CHUNK_MS;
      if (Math.abs(sourceTsMs - expected) <= this.toleranceMs) { last.chunks += 1; this.sent += 1; return; }
    }
    this.runs.push({ cloudStartS: this.sent * CHUNK_MS / 1000, sourceStartMs: sourceTsMs, chunks: 1 });
    this.sent += 1;
  }

  /** Cloud seconds → source epoch ms. Clamped to [anchor, sentEnd]. null when nothing has been sent. */
  toSourceMs(cloudS: number): number | null {
    if (!this.runs.length) return null;
    if (!Number.isFinite(cloudS) || cloudS <= 0) return this.anchoredAtMs;
    for (const run of this.runs) {
      const endS = run.cloudStartS + run.chunks * CHUNK_MS / 1000;
      if (cloudS < endS) return run.sourceStartMs + (cloudS - run.cloudStartS) * 1000;
    }
    return this.sentEndMs;
  }
}

export interface RawWord { word?: unknown; text?: unknown; start_time?: unknown; end_time?: unknown; start?: unknown; end?: unknown }

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Cloud words → epoch-ms words on the sent-audio timeline. Words without usable offsets are dropped. */
export function mapWords(raw: RawWord[] | undefined, timeline: SentAudioTimeline): Word[] {
  const out: Word[] = [];
  for (const w of raw ?? []) {
    const text = typeof w.word === 'string' ? w.word : typeof w.text === 'string' ? w.text : null;
    if (text === null || !text.trim()) continue;
    const s = num(w.start_time) ?? num(w.start);
    const e = num(w.end_time) ?? num(w.end);
    if (s === null || e === null) continue;
    const startAt = timeline.toSourceMs(s);
    const endAt = timeline.toSourceMs(e);
    if (startAt === null || endAt === null) continue;
    const start = Math.round(startAt), end = Math.max(Math.round(endAt), Math.round(startAt));
    out.push({ text: text.trim(), startAt: start, endAt: end });
  }
  return out;
}

/**
 * Segment interval. With words: their span. Without: bounded by the previous final's end (or the
 * anchor) and the current sent-audio position — never an arbitrary wall clock.
 */
export function boundSegmentInterval(words: Word[], ctx: { prevFinalEndMs: number | null; timeline: SentAudioTimeline; receivedAt: number }): { startAt: number; endAt: number } {
  if (words.length) {
    const startAt = Math.min(...words.map((w) => w.startAt));
    const endAt = Math.max(startAt, ...words.map((w) => w.endAt));
    return { startAt, endAt };
  }
  const anchor = ctx.timeline.anchoredAtMs;
  const sentEnd = ctx.timeline.sentEndMs;
  const startAt = Math.round(ctx.prevFinalEndMs ?? anchor ?? ctx.receivedAt);
  const endAt = Math.round(Math.max(startAt, sentEnd ?? startAt));
  return { startAt, endAt };
}
