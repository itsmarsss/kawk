import { segmentKey, transcriptKey, type AudioWindow, type Transcript } from './contracts.js';

/** Select by spoken time, never delivery time. Partials remain explicitly tentative. */
export function transcriptWindow(
  revisions: Transcript[], throughAt: number, maxWords: number,
  status: AudioWindow['status'], maxAgeMs = Infinity,
): AudioWindow {
  const latest = new Map<string, Transcript>();
  for (const t of revisions) {
    const old = latest.get(segmentKey(t));
    if (!old || t.revision > old.revision) latest.set(segmentKey(t), t);
  }
  const rows = [...latest.values()].flatMap(t => {
    const words = t.words.length ? t.words : t.text.trim().split(/\s+/).filter(Boolean).map((text, i, all) => ({
      text, startAt: t.startAt + (t.endAt - t.startAt) * i / all.length,
      endAt: t.startAt + (t.endAt - t.startAt) * (i + 1) / all.length,
    }));
    // Without word timestamps a segment crossing the frame boundary cannot safely be split.
    if (!t.words.length && t.endAt > throughAt) return [];
    return words.filter(w => w.endAt <= throughAt && w.endAt >= throughAt - maxAgeMs)
      .map(w => ({ t, w }));
  }).sort((a, b) => a.w.startAt - b.w.startAt || transcriptKey(a.t).localeCompare(transcriptKey(b.t)));
  const selected = rows.slice(-Math.max(1, maxWords));
  const groups = new Map<string, Transcript>();
  for (const { t, w } of selected) {
    const key = transcriptKey(t);
    if (!groups.has(key)) groups.set(key, { ...t, text: '', words: [], startAt: w.startAt, endAt: w.endAt });
    const group = groups.get(key)!;
    group.words.push(w); group.endAt = Math.max(group.endAt, w.endAt);
    group.text = group.words.map(word => word.text).join(' ');
  }
  return { text: selected.map(r => r.w.text).join(' '), wordCount: selected.length,
    segments: [...groups.values()], status, throughAt };
}

export function audioSignature(audio: AudioWindow): string {
  // Partial words are retained in packets/UI but withheld from memory interpretation.
  // Revising a partial must not continually cancel the state update during conversation.
  return JSON.stringify(audio.segments.filter(t => t.isFinal).map(t => [transcriptKey(t), t.text, t.words]));
}
