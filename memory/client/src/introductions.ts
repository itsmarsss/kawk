// Spoken introductions travel to the face server over the SAME /ws/faces connection that produced the
// stable face history, as a JSON control message. The server owns matching and the Jev decision;
// the client only forwards finalized transcripts that the memory server has already accepted, at
// most once per speech stream+segment, and only into the face connection (epoch) that was current
// when the final was received. Partials, post-Stop finals and finals whose face connection changed
// are never forwarded. The client never infers who spoke from the faces.
import type { Transcript } from './types.ts';

export interface IntroductionPayload {
  type: 'introduction'; text: string; is_final: true; segment_id: string; revision: number; stream_id: string;
  start_at: number; end_at: number;
}
export type IntroductionDecision = 'sent' | 'not-final' | 'empty' | 'duplicate' | 'stopped' | 'face-changed' | 'send-failed';

export function introductionPayload(t: Transcript): IntroductionPayload {
  return { type: 'introduction', text: t.text, is_final: true, segment_id: t.segmentId, revision: t.revision, stream_id: t.streamId,
    start_at: t.startAt, end_at: t.endAt };
}

export class IntroductionForwarder {
  /** stream/segment keys already decided (sent OR deliberately skipped): a segment is forwarded at most once. */
  private decided = new Set<string>();
  sent = 0;
  skipped = 0;

  constructor(private readonly send: (payload: IntroductionPayload, epoch: number) => boolean) {}

  /**
   * Call ONLY after POST /api/transcripts accepted `t`. `boundEpoch` is the face connection epoch captured
   * when the transcript was received; `currentEpoch` is the face link's epoch now.
   */
  forward(t: Transcript, ctx: { boundEpoch: number; currentEpoch: number; stopped: boolean }): IntroductionDecision {
    if (!t.isFinal) return 'not-final';
    if (!t.text.trim()) return 'empty';
    const key = `${t.streamId}/${t.segmentId}`;
    if (this.decided.has(key)) return 'duplicate';
    this.decided.add(key);
    if (ctx.stopped) { this.skipped += 1; return 'stopped'; }
    if (ctx.boundEpoch <= 0 || ctx.boundEpoch !== ctx.currentEpoch) { this.skipped += 1; return 'face-changed'; }
    if (!this.send(introductionPayload(t), ctx.boundEpoch)) { this.skipped += 1; return 'send-failed'; }
    this.sent += 1;
    return 'sent';
  }
}

// ---- server replies ------------------------------------------------------------------------------
export type IntroductionStatus = 'deciding' | 'ignored' | 'collecting' | 'complete' | 'error';
export interface IntroductionReply { status: IntroductionStatus; message: string; name: string | null; personId: string | null }
export interface EnrollmentReply { status: 'collecting' | 'complete' | 'error'; name: string | null; personId: string | null; collected: number | null; required: number | null; message: string | null }

const str = (v: unknown, max = 200): string | null => (typeof v === 'string' && v.length ? v.slice(0, max) : null);
const int = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const personIdOf = (v: unknown): string | null => {
  if (typeof v === 'string') return str(v, 160);
  if (v && typeof v === 'object' && 'id' in v) return str((v as { id?: unknown }).id, 160);
  return null;
};

/** {type:'introduction', status, message, name?, person_id?} → typed reply; null when malformed. */
export function parseIntroductionReply(raw: unknown): IntroductionReply | null {
  if (!raw || typeof raw !== 'object') return null;
  const m = raw as { status?: unknown; message?: unknown; name?: unknown; person_id?: unknown; person?: unknown };
  const status = m.status;
  if (status !== 'deciding' && status !== 'ignored' && status !== 'collecting' && status !== 'complete' && status !== 'error') return null;
  return { status, message: str(m.message, 300) ?? '', name: str(m.name, 100), personId: personIdOf(m.person_id) ?? personIdOf(m.person) };
}

/** The `enrollment` object riding on a normal frame reply → typed; null when absent or malformed. */
export function parseEnrollmentReply(raw: unknown): EnrollmentReply | null {
  if (!raw || typeof raw !== 'object') return null;
  const m = raw as { status?: unknown; name?: unknown; person?: unknown; collected?: unknown; required?: unknown; message?: unknown };
  const status = m.status;
  if (status !== 'collecting' && status !== 'complete' && status !== 'error') return null;
  return { status, name: str(m.name, 100), personId: personIdOf(m.person), collected: int(m.collected), required: int(m.required), message: str(m.message, 300) };
}

/** Visible introduction state kept by a Run and rendered near the camera preview. */
export interface IntroductionState {
  status: 'idle' | 'sent' | IntroductionStatus | 'skipped';
  message: string; name: string | null; personId: string | null; at: number | null; sent: number; skipped: number;
  /** Enrollment progress from the server while `collecting`; null otherwise. */
  collected: number | null; required: number | null;
}
export const idleIntroduction = (message = 'no introduction forwarded yet'): IntroductionState =>
  ({ status: 'idle', message, name: null, personId: null, at: null, sent: 0, skipped: 0, collected: null, required: null });

// ---- plain-language rendering -------------------------------------------------------------------------
export type IntroductionTone = '' | 'ok' | 'warn' | 'bad';
/** What the user sees next to the preview: one short line, a tone, and the technical diagnostics kept out of the main flow. */
export interface IntroductionSummary { text: string; tone: IntroductionTone; detail: string }

const NOT_STARTED = 'Introductions: press Start, then say something like “this is Sam” while their face is visible.';
const IDLE_DETAIL = 'After Start, each finalized utterance is forwarded once to the face server, which matches the visible stable face and lets Jev decide. Partials are never sent; nothing is sent before Start.';

/** Pure: IntroductionState → user-facing line. `started=false` renders the pre-Start hint. */
export function summarizeIntroduction(i: IntroductionState | null, started: boolean, now: number, fmtAgo: (ms: number, now: number) => string): IntroductionSummary {
  const diag = (s: IntroductionState): string => {
    const parts = [`state ${s.status}`, s.message ? `message: ${s.message}` : null, s.personId ? `person id ${s.personId}` : null,
      s.at !== null ? `updated ${fmtAgo(s.at, now)}` : null, `forwarded ${s.sent}`, `skipped ${s.skipped}`];
    return parts.filter((x): x is string => !!x).join(' · ');
  };
  if (!i || !started) return { text: NOT_STARTED, tone: '', detail: IDLE_DETAIL };
  const who = i.name ?? 'this person';
  switch (i.status) {
    case 'idle': return { text: i.message === 'no introduction forwarded yet' ? 'Listening for an introduction' : 'Listening for an introduction (labels were reset)', tone: '', detail: diag(i) };
    case 'sent':
    case 'deciding': return { text: 'Jev is checking the introduction', tone: 'warn', detail: diag(i) };
    case 'ignored': return { text: 'Not treated as an introduction', tone: '', detail: diag(i) };
    case 'collecting': {
      const progress = i.collected !== null && i.required !== null ? ` — ${i.collected} of ${i.required} frames` : '';
      return { text: `Learning ${who}${progress}`, tone: 'warn', detail: diag(i) };
    }
    case 'complete': return { text: i.name ? `Saved ${i.name}` : 'Saved', tone: 'ok', detail: diag(i) };
    case 'error': return { text: `Failed${i.name ? ` for ${i.name}` : ''}: ${i.message || 'unknown reason'}`, tone: 'bad', detail: diag(i) };
    case 'skipped': return { text: 'Introduction not sent — see details', tone: 'warn', detail: diag(i) };
  }
}
