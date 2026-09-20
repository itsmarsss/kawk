// Transcript revision ledger keyed by streamId/segmentId. A revision number increases only when text,
// finality or word timings actually change; identical repeats are suppressed. A segment that reached
// isFinal never regresses to a partial.
import type { Transcript, Word } from './types.ts';

export interface RevisionInput {
  sessionId: string; streamId: string; segmentId: string; text: string; isFinal: boolean;
  words: Word[]; startAt: number; endAt: number; receivedAt: number;
}
interface Entry { revision: number; signature: string; isFinal: boolean }

export function revisionSignature(text: string, isFinal: boolean, words: Word[]): string {
  return JSON.stringify([text, isFinal, words.map((w) => [w.text, w.startAt, w.endAt])]);
}

export class RevisionLedger {
  private entries = new Map<string, Entry>();
  suppressed = 0;

  /** Returns the Transcript to POST, or null when nothing changed (or a final would regress). */
  apply(input: RevisionInput): Transcript | null {
    const key = `${input.streamId}/${input.segmentId}`;
    const signature = revisionSignature(input.text, input.isFinal, input.words);
    const prev = this.entries.get(key);
    if (prev && (prev.signature === signature || (prev.isFinal && !input.isFinal))) { this.suppressed += 1; return null; }
    const revision = prev ? prev.revision + 1 : 0;
    this.entries.set(key, { revision, signature, isFinal: input.isFinal });
    return {
      sessionId: input.sessionId, streamId: input.streamId, segmentId: input.segmentId, revision,
      text: input.text, isFinal: input.isFinal, startAt: input.startAt,
      endAt: Math.max(input.startAt, input.endAt), receivedAt: input.receivedAt,
      words: input.words, speakerId: null, timing: 'approximate',
    };
  }
  get size(): number { return this.entries.size; }
}
