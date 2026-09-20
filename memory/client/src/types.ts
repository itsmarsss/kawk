// Client-side mirror of the server contracts in memory/src/contracts.ts (kept structurally identical).
// All times are epoch milliseconds.
export interface Word { text: string; startAt: number; endAt: number }
export interface Transcript {
  sessionId: string; streamId: string; segmentId: string; revision: number;
  text: string; isFinal: boolean; startAt: number; endAt: number; receivedAt: number;
  words: Word[]; speakerId: null; timing: 'approximate' | 'exact';
}
export interface FaceEvidenceFace {
  trackId: string; personId: string | null; name: string | null; similarity: number | null;
  box: [number, number, number, number]; identityStatus: 'confirmed' | 'unknown';
}
export interface FaceEvidence {
  frameId: string; streamId: string; capturedAt: number; status: 'ready' | 'unavailable';
  width: number; height: number; faces: FaceEvidenceFace[];
}
export interface CaptureInput {
  id: string; sessionId: string; sequence: number; capturedAt: number; width: number; height: number;
  jpegBase64: string; faces: FaceEvidence; audioStatus: 'live' | 'unavailable';
  /** Agent interrupt: the command id that requested this photo. Absent on regular 5 s ticks and the Stop snapshot. */
  requestId?: string;
}
export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}
export const realClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (h) => globalThis.clearTimeout(h as ReturnType<typeof setTimeout>),
};
