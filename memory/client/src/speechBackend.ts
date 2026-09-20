// Speech backend selection and the honest labelling of what is actually transcribing. The server's
// `ready` message names the backend it really used; the label prefers that over the request so a
// local model is never described as cloud (or vice versa). Also owns the Live transcript status
// line: stopped / loading / reconnecting / error / listening are distinct states, not "no speech yet".
export type SpeechBackend = 'local' | 'baseten';

/** Historical default: the page used the cloud relay before the server exposed `speechBackend`. */
export const HISTORICAL_DEFAULT_SPEECH_BACKEND: SpeechBackend = 'baseten';

export const SPEECH_BACKEND_OPTIONS: { value: SpeechBackend; label: string }[] = [
  { value: 'local', label: 'Local: Whisper Small int8 (this Mac)' },
  { value: 'baseten', label: 'Cloud: Baseten Whisper Large v3 streaming' },
];

export function normalizeSpeechBackend(v: unknown): SpeechBackend | null {
  return v === 'local' || v === 'baseten' ? v : null;
}

/** The backend to preselect: the deployment config when it names one, else the historical default. */
export function defaultSpeechBackend(config: { speechBackend?: unknown } | null | undefined): SpeechBackend {
  return normalizeSpeechBackend(config?.speechBackend) ?? HISTORICAL_DEFAULT_SPEECH_BACKEND;
}

const kindOf = (b: string | null): string => (b === 'local' ? 'local (this Mac)' : b === 'baseten' ? 'cloud (Baseten)' : b ?? '?');

/**
 * Human label for the speech backend. `server` is what the relay's `ready` message reported (null
 * until ready). When the server names a different backend than requested, both are shown.
 */
export function describeSpeechBackend(requested: SpeechBackend | null, server: { backend: string | null; model: string | null } | null): string {
  const sb = server?.backend ?? null;
  const model = server?.model ? ` ${server.model}` : '';
  if (sb && requested && sb !== requested) return `requested ${kindOf(requested)} but server reports ${kindOf(sb)}${model}`;
  const kind = kindOf(sb ?? requested);
  if (!sb && requested) return `${kind}${requested === 'local' ? ' Whisper Small int8' : ' Whisper Large v3'} (requested; not yet confirmed by the server)`;
  return `${kind}${model}`;
}

export interface TranscriptStatusInput {
  runPhase: 'idle' | 'starting' | 'running' | 'stopping' | 'stopped' | 'error' | null;
  microphone: 'off' | 'live' | 'error';
  speech: { phase: 'idle' | 'connecting' | 'ready' | 'reconnecting' | 'stopping' | 'stopped' | 'error'; message: string; backend: string | null; model: string | null };
  requested: SpeechBackend | null;
  segments: number;
}

/** One line for the Live transcript header. Distinguishes stopped/loading/reconnecting/error/listening. */
export function transcriptStatusLine(i: TranscriptStatusInput): string {
  const label = describeSpeechBackend(i.requested, i.speech);
  const recent = i.segments ? `${i.segments} recent segment(s) · ` : '';
  if (i.runPhase === null || i.runPhase === 'idle') return `${recent}stopped · press Start to begin listening`;
  if (i.runPhase === 'stopped') return `${recent}stopped · no live transcript`;
  if (i.runPhase === 'error') return `${recent}stopped after an error · see Errors`;
  if (i.runPhase === 'stopping' || i.speech.phase === 'stopping') return `${recent}stopping · waiting for the last final`;
  if (i.microphone === 'error') return `${recent}microphone unavailable · nothing is being transcribed`;
  switch (i.speech.phase) {
    case 'idle': return `${recent}speech not started`;
    case 'connecting': return `${recent}loading ${label} · ${i.speech.message} · audio is not sent until ready`;
    case 'reconnecting': return `${recent}reconnecting · ${i.speech.message}`;
    case 'error': return `${recent}speech error · ${i.speech.message} · not listening`;
    case 'stopped': return `${recent}speech stopped · ${i.speech.message}`;
    case 'ready': return i.segments
      ? `listening via ${label} · ${i.segments} recent segment(s) · times are approximate source times · speaker is never identified`
      : `listening via ${label} · no speech transcribed yet`;
    default: return `${recent}${i.speech.message}`;
  }
}
