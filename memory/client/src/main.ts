// KAWK continuous-memory testing page. Page load: GET /api/config, GET /api/dashboard, enumerateDevices.
// Nothing else happens until Start (session + media + sockets) or an explicit Search submit.
import { api, agentApi, type ClientConfig, type Dashboard, type Entity, type CaptureRecord, type Packet, type SearchHit, type Person, type PeopleResponse, type AgentStatus, type AgentTask } from './api.ts';
import { NotificationLedger, NotificationStream, describeAgentConnection, isActiveTask, parseNotification, refView, taskResultText, type AgentNotification, type StreamState } from './agentFeed.ts';
import { SEARCH_MODE_OPTIONS, buildSearchBody, normalizeSearchMode, scoreLabel, searchResultNote, type SearchMode } from './searchMode.ts';
import { realClock } from './types.ts';
import { Run, type RunSnapshot, type LiveFaces } from './session.ts';
import { listDevices } from './media.ts';
import { contentRect, mapBox } from './overlay.ts';
import { displayName } from './faceBinding.ts';
import { el, setText, clear, replaceChildren, fmtTime, fmtDateTime, fmtMs, fmtAgo, short, link } from './dom.ts';
import { reconcileKeyed } from './keyed.ts';
import { possibleMatchLabel, searchRowLabel, unresolvedCandidates } from './candidates.ts';
import { formatModelLabel } from './configLabel.ts';
import { SPEECH_BACKEND_OPTIONS, defaultSpeechBackend, describeSpeechBackend, normalizeSpeechBackend, transcriptStatusLine, type SpeechBackend } from './speechBackend.ts';
import type { Transcript } from './types.ts';
import { sortPeople, countPeople, deleteButtonLabel, confirmDeleteButtonLabel } from './people.ts';
import { summarizeIntroduction } from './introductions.ts';

const $ = <T extends HTMLElement>(id: string): T => {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing #${id}`);
  return node as T;
};

const ui = {
  start: $<HTMLButtonElement>('start'), stop: $<HTMLButtonElement>('stop'), refresh: $<HTMLButtonElement>('refresh'),
  camera: $<HTMLSelectElement>('camera'), mic: $<HTMLSelectElement>('mic'),
  speechBackend: $<HTMLSelectElement>('speech-backend'), speechNote: $('speech-note'),
  video: $<HTMLVideoElement>('video'), overlay: $<HTMLCanvasElement>('overlay'), previewNote: $('preview-note'), introNote: $('intro-note'), introDetail: $('intro-detail'),
  people: $('people'), peopleNote: $('people-note'), peopleReset: $<HTMLButtonElement>('people-reset'), peopleResetConfirm: $('people-reset-confirm'), peopleActionNote: $('people-action-note'),
  status: $('status'), errorsSummary: $('errors-summary'), errorsList: $('errors-list'),
  submissionsList: $('submissions-list'), transcript: $('transcript'), transcriptNote: $('transcript-note'),
  state: $('state'), captures: $('captures'), entities: $('entities'), pipeline: $('pipeline'),
  searchForm: $<HTMLFormElement>('search-form'), searchQuery: $<HTMLInputElement>('search-query'), searchMode: $<HTMLSelectElement>('search-mode'), searchEntity: $<HTMLSelectElement>('search-entity'),
  searchFrom: $<HTMLInputElement>('search-from'), searchTo: $<HTMLInputElement>('search-to'), searchLimit: $<HTMLInputElement>('search-limit'),
  searchResults: $('search-results'), searchNote: $('search-note'), configNote: $('config-note'), dashNote: $('dash-note'),
  agentStatus: $('agent-status'), agentForm: $<HTMLFormElement>('agent-form'), agentInput: $<HTMLInputElement>('agent-input'), agentSend: $<HTMLButtonElement>('agent-send'), agentNote: $('agent-note'),
  agentNotifications: $('agent-notifications'), agentTasks: $('agent-tasks'), agentTasksSummary: $('agent-tasks-summary'), pwaNote: $('pwa-note'),
};

let config: ClientConfig = { captureIntervalMs: 5000, transcriptWords: 200 };
let current: Run | null = null;
let liveFaces: LiveFaces | null = null;
let lastSnapshot: RunSnapshot | null = null;
let dashboard: Dashboard | null = null;
const transcripts = new Map<string, Transcript>(); // latest revision per stream/segment, bounded
const pageErrors: string[] = [];

// ---- speech backend selector (applies at Start; never a hidden fallback) -------------------------------
for (const o of SPEECH_BACKEND_OPTIONS) ui.speechBackend.append(el('option', { value: o.value }, o.label));
const selectedSpeechBackend = (): SpeechBackend => normalizeSpeechBackend(ui.speechBackend.value) ?? defaultSpeechBackend(config);
function renderSpeechNote(): void {
  const s = lastSnapshot;
  const running = Boolean(s && (s.phase === 'starting' || s.phase === 'running' || s.phase === 'stopping'));
  const chosen = running && s?.speechBackend ? s.speechBackend : selectedSpeechBackend();
  const live = running && s ? describeSpeechBackend(chosen, s.speech) : `${SPEECH_BACKEND_OPTIONS.find((o) => o.value === chosen)?.label ?? chosen} · applies at Start · no automatic fallback`;
  const notice = config.speechNotice?.trim();
  setText(ui.speechNote, `${live}${notice ? ` · ${notice}` : ''}`);
}
ui.speechBackend.addEventListener('change', renderSpeechNote);

// ---- status region: fixed rows, values replaced in place (no layout jump) ------------------------
const STATUS_ROWS = ['Session', 'Camera', 'Microphone', 'Face socket', 'Speech socket', 'Cadence', 'Photos', 'Captures', 'Agent capture', 'Transcripts', 'Latency', 'Stop snapshot'] as const;
const statusValues = new Map<string, HTMLElement>();
for (const label of STATUS_ROWS) {
  const value = el('div', { class: 'v' }, '—');
  statusValues.set(label, value);
  ui.status.append(el('div', { class: 'k' }, label), value);
}
const setRow = (label: typeof STATUS_ROWS[number], value: string, tone: '' | 'ok' | 'warn' | 'bad' = '') => {
  const node = statusValues.get(label)!;
  setText(node, value);
  if (node.title !== value) node.title = value; // full text on hover without changing the row height
  node.className = `v ${tone}`;
};
let errorsSig = ''; let submissionsSig = '';

function renderSnapshot(s: RunSnapshot | null): void {
  lastSnapshot = s;
  const running = Boolean(s && (s.phase === 'starting' || s.phase === 'running'));
  ui.start.disabled = running || Boolean(s && s.phase === 'stopping');
  ui.stop.disabled = !s || s.phase === 'stopped' || s.phase === 'error' || s.phase === 'idle';
  ui.camera.disabled = running; ui.mic.disabled = running; ui.speechBackend.disabled = running;
  renderTranscriptNote(); renderIntroduction(s); renderSpeechNote();
  if (!s) {
    for (const label of STATUS_ROWS) setRow(label, label === 'Session' ? 'idle — press Start' : '—');
    setText(ui.errorsSummary, 'Errors (0)');
    return;
  }
  setRow('Session', `${s.phase}${s.sessionId ? ` · ${short(s.sessionId)}` : ''}${s.startedAt ? ` · started ${fmtTime(s.startedAt)}` : ''}${s.reason ? ` · ${s.reason}` : ''}`,
    s.phase === 'running' ? 'ok' : s.phase === 'error' ? 'bad' : '');
  setRow('Camera', `${s.camera}${s.videoSize ? ` · ${s.videoSize.width}×${s.videoSize.height}` : ''}`, s.camera === 'live' ? 'ok' : s.camera === 'error' ? 'bad' : '');
  setRow('Microphone', `${s.microphone}${s.microphone === 'live' ? ` · level ${s.micLevel.toFixed(3)}` : ''}`, s.microphone === 'live' ? 'ok' : s.microphone === 'error' ? 'bad' : '');
  setRow('Face socket', `${s.face.phase} · ${short(s.face.streamId)} · conn ${s.face.connections} · rtt ${fmtMs(s.face.lastRttMs)}${s.face.lastServerMs !== null ? ` (server ${fmtMs(s.face.lastServerMs)})` : ''} · stale ${s.face.staleReplies}${s.face.slotBusy ? ' · busy' : ''} · ${s.face.message}`,
    s.face.phase === 'ready' ? 'ok' : s.face.phase === 'error' ? 'bad' : s.face.phase === 'reconnecting' ? 'warn' : '');
  setRow('Speech socket', `${s.speech.phase} · requested ${s.speechBackend ?? '?'} · server ${s.speech.backend ?? 'unconfirmed'}${s.speech.model ? ` (${s.speech.model})` : ''} · ${short(s.speech.streamId)} · conn ${s.speech.connections} · sent ${s.speech.chunksSent} · dropped ${s.speech.chunksDroppedBackpressure}+${s.speech.chunksDroppedNotReady} pre-ready · runs ${s.speech.runs} · anchor ${fmtTime(s.speech.anchoredAt)} · ${s.speech.message}`,
    s.speech.phase === 'ready' ? 'ok' : s.speech.phase === 'error' ? 'bad' : s.speech.phase === 'reconnecting' ? 'warn' : '');
  setRow('Cadence', `every ${s.ticks.intervalMs} ms from ${fmtTime(s.ticks.anchor)} · ticks ${s.ticks.fired} · skipped ${s.ticks.skipped} · last-${config.transcriptWords}-word window is server-owned`, s.ticks.skipped ? 'warn' : '');
  setRow('Photos', `drawn ${s.photos.drawn} (${s.photos.interrupts} for agent) · next sequence ${s.photos.nextSequence} · encoding ${s.photos.encoding} · awaiting face ${s.photos.awaitingFace} (queued ${s.photos.faceQueued}) · face ready ${s.photos.faceReady} · unavailable ${s.photos.faceUnavailable} · gaps ${s.photos.faceGaps} · queue rejected ${s.photos.queueRejected} · draw/encode failed ${s.photos.drawFailed}/${s.photos.encodeFailed}`,
    s.photos.faceGaps || s.photos.drawFailed || s.photos.encodeFailed ? 'warn' : '');
  const it = s.interrupt;
  setRow('Agent capture', !it ? (s.phase === 'running' ? 'command polling disabled' : 'polls GET /api/agent/commands every 400 ms while running')
    : `${it.message} · polls ${it.counts.polls}${it.counts.pollErrors ? ` (errors ${it.counts.pollErrors})` : ''} · claimed ${it.counts.claimed} · captured ${it.counts.captured} · failed ${it.counts.failed} · not claimed ${it.counts.notClaimed} · expired ${it.counts.expired}${it.lastPollError ? ` · last poll error: ${it.lastPollError}` : ''}`,
    !it ? '' : it.stage === 'captured' ? 'ok' : it.stage === 'failed' || it.stage === 'unavailable' ? 'bad' : it.stage === 'claiming' || it.stage === 'capturing' || it.stage === 'reporting' ? 'warn' : it.pollingHealthy ? 'ok' : '');
  setRow('Captures', `queued ${s.submissions.pending + s.submissions.submitting} · accepted (202) ${s.submissions.accepted} · failed ${s.submissions.failed} · total ${s.submissions.total} — acceptance ≠ memory completion; see server pipeline`,
    s.submissions.failed ? 'bad' : '');
  setRow('Transcripts', `posted ${s.transcripts.posted} · failed ${s.transcripts.failed} · dropped ${s.transcripts.dropped} · pending ${s.transcripts.pendingHttp} · identical revisions suppressed ${s.transcripts.suppressed}`, s.transcripts.failed ? 'warn' : '');
  setRow('Latency', `capture → 202: ${fmtMs(s.submissions.lastLatencyMs)} · face rtt ${fmtMs(s.face.lastRttMs)} · packet completion latency: server pipeline below`);
  const fc = s.finalCapture;
  setRow('Stop snapshot', fc.stage === 'not-started' ? 'taken once on Stop after the speech flush (covers late finals)' : `${fc.stage}${fc.id ? ` · ${short(fc.id)}` : ''} · ${fc.detail}`,
    fc.stage === 'accepted' ? 'ok' : fc.stage === 'failed' ? 'bad' : fc.stage === 'not-started' || fc.stage === 'skipped' ? '' : 'warn');
  setText(ui.errorsSummary, `Errors (${s.errors.length + pageErrors.length})`);
  const eSig = `${pageErrors.length}:${s.errors.length}:${s.errors.at(-1)?.at ?? 0}`;
  if (eSig !== errorsSig) {
    errorsSig = eSig;
    replaceChildren(ui.errorsList, [...pageErrors.map((m) => el('li', null, m)), ...s.errors.slice().reverse().map((e) => el('li', null, `${fmtTime(e.at)} ${e.message}`))]);
  }
  const sSig = s.submissions.recent.map((r) => `${r.id}:${r.status}:${r.attempts}`).join('|');
  if (sSig !== submissionsSig) {
    submissionsSig = sSig;
    replaceChildren(ui.submissionsList, s.submissions.recent.map((r) => el('li', { class: r.status }, `${short(r.id)} · ${r.status}${r.attempts > 1 ? ` (${r.attempts} attempts)` : ''}${r.latencyMs !== null ? ` · ${fmtMs(r.latencyMs)}` : ''}${r.error ? ` · ${r.error}` : ''}`)));
  }
}

// ---- preview overlay ------------------------------------------------------------------------------
function drawOverlay(): void {
  const c = ui.overlay; const v = ui.video;
  const w = c.clientWidth, h = c.clientHeight;
  if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
  const ctx = c.getContext('2d')!;
  ctx.clearRect(0, 0, w, h);
  const running = lastSnapshot?.phase === 'running';
  if (!running || !liveFaces || Date.now() - liveFaces.receivedAt > 1200 || !v.videoWidth) {
    setText(ui.previewNote, running ? (liveFaces ? 'face boxes cleared: no reply in 1.2 s' : `faces: ${lastSnapshot?.face.message ?? 'waiting'}`) : 'preview off');
    return;
  }
  const rect = contentRect(v.videoWidth, v.videoHeight, w, h);
  const ev = liveFaces.evidence;
  ctx.lineWidth = 2; ctx.font = '13px ui-monospace, monospace'; ctx.textBaseline = 'top';
  for (const f of ev.faces) {
    const r = mapBox(f.box, ev.width, ev.height, rect);
    const name = displayName(f);
    ctx.strokeStyle = f.identityStatus === 'confirmed' ? '#5fd38a' : '#e0b45a';
    ctx.strokeRect(r.x, r.y, r.w, r.h);
    const label = `${name}${f.similarity !== null ? ` ${f.similarity.toFixed(2)}` : ''} #${f.trackId}`;
    const tw = ctx.measureText(label).width + 8;
    ctx.fillStyle = 'rgba(0,0,0,0.7)'; ctx.fillRect(r.x, Math.max(0, r.y - 18), tw, 18);
    ctx.fillStyle = ctx.strokeStyle; ctx.fillText(label, r.x + 4, Math.max(0, r.y - 18) + 2);
  }
  setText(ui.previewNote, `${ev.faces.length} face(s) · ${ev.width}×${ev.height} derivative · reply ${fmtMs(liveFaces.rttMs)} · ${fmtAgo(liveFaces.receivedAt, Date.now())}`);
}
setInterval(() => { drawOverlay(); renderIntroduction(lastSnapshot); }, 100);

// ---- spoken introductions: status near the preview; the server owns matching and the decision ----------
function renderIntroduction(s: RunSnapshot | null): void {
  const now = Date.now();
  const sum = summarizeIntroduction(s?.introduction ?? null, !!s && s.phase !== 'idle', now, fmtAgo);
  setText(ui.introNote, sum.text);
  const cls = `note intro${sum.tone ? ` ${sum.tone}` : ''}`;
  if (ui.introNote.className !== cls) ui.introNote.className = cls;
  if (ui.introNote.getAttribute('title') !== sum.detail) ui.introNote.setAttribute('title', sum.detail);
  setText(ui.introDetail, sum.detail);
}

// ---- transcript -------------------------------------------------------------------------------------
function renderTranscriptNote(): void {
  const s = lastSnapshot;
  setText(ui.transcriptNote, transcriptStatusLine({
    runPhase: s?.phase ?? null, microphone: s?.microphone ?? 'off',
    speech: s ? s.speech : { phase: 'idle', message: 'idle', backend: null, model: null },
    requested: s?.speechBackend ?? selectedSpeechBackend(), segments: transcripts.size,
  }));
}
function onTranscript(t: Transcript): void {
  transcripts.set(`${t.streamId}/${t.segmentId}`, t);
  while (transcripts.size > 14) transcripts.delete(transcripts.keys().next().value!);
  const rows = [...transcripts.values()].sort((a, b) => a.startAt - b.startAt || a.receivedAt - b.receivedAt);
  replaceChildren(ui.transcript, rows.map((r) => el('li', { class: r.isFinal ? 'final' : 'partial' },
    el('span', { class: 'meta' }, `${r.isFinal ? 'final' : 'partial'} r${r.revision} · speaker unknown · ${fmtTime(r.startAt)}–${fmtTime(r.endAt)} (${r.timing}${r.words.length ? `, ${r.words.length} words` : ', no word offsets'}) · ${short(r.streamId, 6)}/${r.segmentId}`),
    el('span', { class: 'text' }, r.text || '(empty)'))));
  renderTranscriptNote();
}

// ---- controls -----------------------------------------------------------------------------------------
async function refreshDevices(): Promise<void> {
  try {
    const d = await listDevices();
    const fill = (sel: HTMLSelectElement, items: MediaDeviceInfo[], fallback: string) => {
      const prev = sel.value;
      replaceChildren(sel, [el('option', { value: '' }, `Default ${fallback}`), ...items.map((i, n) => el('option', { value: i.deviceId }, i.label || `${fallback} ${n + 1}`))]);
      if ([...sel.options].some((o) => o.value === prev)) sel.value = prev;
    };
    fill(ui.camera, d.cameras, 'camera'); fill(ui.mic, d.microphones, 'microphone');
    if (d.cameras.every((c) => !c.label)) setText(ui.configNote, `${ui.configNote.textContent ?? ''} · device labels appear after the first permission grant`.trim());
  } catch (e) { pageError(`enumerateDevices failed: ${msg(e)}`); }
}

async function start(): Promise<void> {
  if (current) { await current.stop('replaced by a new Start'); }
  transcripts.clear(); clear(ui.transcript);
  const run = new Run({
    videoEl: ui.video, config,
    commands: { poll: (sid) => agentApi.commands(sid), claim: (id, sid) => agentApi.claim(id, sid), result: (id, body) => agentApi.result(id, body) },
    onUpdate: (s) => { if (run === current) renderSnapshot(s); },
    onLiveFaces: (f) => { if (run === current) liveFaces = f; },
    onTranscript: (t) => { if (run === current) onTranscript(t); },
  });
  current = run;
  renderSnapshot(run.snapshot());
  await run.start({ cameraId: ui.camera.value || null, micId: ui.mic.value || null, speechBackend: selectedSpeechBackend() });
  void refreshDevices(); // labels become available after the permission grant
}
async function stop(): Promise<void> { await current?.stop('stopped by user'); }

ui.start.addEventListener('click', () => { void start(); });
ui.stop.addEventListener('click', () => { void stop(); });
ui.refresh.addEventListener('click', () => { void refreshDevices(); });
window.addEventListener('pagehide', () => { void current?.stop('page hidden'); });

// ---- dashboard (GET only; polled) -----------------------------------------------------------------------
function renderState(d: Dashboard): void {
  const s = d.state;
  if (!s) { replaceChildren(ui.state, [el('p', { class: 'empty' }, 'No current state yet: nothing has been committed by the memory pipeline.')]); return; }
  replaceChildren(ui.state, [
    el('dl', null,
      el('dt', null, 'Location'), el('dd', null, s.location ?? '— (unknown)'),
      el('dt', null, 'Activity'), el('dd', null, s.activity ?? '— (unknown)'),
      el('dt', null, 'Summary'), el('dd', null, s.summary || '—'),
      el('dt', null, 'Uncertainties'), el('dd', null, s.uncertainties?.length ? el('ul', null, ...s.uncertainties.map((u) => el('li', null, u))) : 'none stated'),
      el('dt', null, 'Version'), el('dd', null, s.version > 0 && Number.isFinite(s.observedAt) && s.observedAt > 0
        ? `v${s.version} · observed ${fmtDateTime(s.observedAt)} (${fmtAgo(s.observedAt, Date.now())})`
        : 'No memory saved yet'),
      el('dt', null, 'Source packet'), el('dd', null, s.packetId ? link(api.frameUrl(s.packetId), `image ${short(s.packetId)}`) : '—'),
    ),
  ]);
}

const captureNodes = new Map<string, Element>();
const entityNodes = new Map<string, Element>();
function captureSummary(summary: HTMLElement, c: CaptureRecord): void {
  const faces = c.faces?.faces ?? [];
  const names = faces.map((f) => (f.identityStatus === 'confirmed' && f.name ? f.name : 'Unknown'));
  replaceChildren(summary, [`#${c.sequence} · ${fmtTime(c.capturedAt)} · `, el('b', { class: `st-${c.status}` }, c.status),
    ` · faces ${c.faces?.status ?? '?'}${faces.length ? ` [${names.join(', ')}]` : ''}${c.error ? ` · error: ${c.error}` : ''}`]);
}
function captureRow(c: CaptureRecord): HTMLElement {
  const summary = el('summary', null); captureSummary(summary, c);
  const body = el('div', { class: 'detail' }, el('p', { class: 'muted' }, 'expand to load packet…'));
  const details = el('details', null, summary, body);
  const refresh = el('button', { type: 'button', class: 'quiet tiny' }, 'reload packet');
  refresh.addEventListener('click', () => { void loadPacket(c, body); });
  body.append(refresh);
  details.addEventListener('toggle', () => { if (details.open) void loadPacket(c, body); }, { once: true });
  return el('li', null, details);
}
function updateCaptureRow(li: Element, c: CaptureRecord): void {
  const summary = li.querySelector('summary');
  if (summary) captureSummary(summary, c); // status/error refresh in place; open state and loaded packet are untouched
  const statusNote = li.querySelector('.server-status');
  if (statusNote) setText(statusNote, `server status now: ${c.status}${c.error ? ` · ${c.error}` : ''}`);
}
async function loadPacket(c: CaptureRecord, body: HTMLElement): Promise<void> {
  const children: (Node | string)[] = [el('p', null, link(api.frameUrl(c.id), 'source image'), ` · ${c.width}×${c.height} · received ${fmtTime(c.receivedAt)} · id ${c.id}`)];
  if (c.vision) children.push(visionBlock(c.vision));
  try {
    const p = await api.packet(c.id);
    children.push(packetBlock(p));
    try {
      const h = await api.packetHistory(c.id);
      const versions = Array.isArray(h) ? h : h.versions ?? [];
      children.push(el('p', { class: 'muted' }, `${versions.length} packet version(s): ${versions.map((v) => `v${v.version}${v.correction ? ' (correction)' : ''} @ ${fmtTime(v.createdAt)}`).join(', ')}`));
    } catch (e) { children.push(el('p', { class: 'muted' }, `history unavailable: ${msg(e)}`)); }
  } catch (e) { children.push(el('p', { class: 'muted' }, /404/.test(msg(e)) ? 'no completed packet yet (vision/transcript still pending)' : `packet unavailable: ${msg(e)}`)); }
  children.push(el('p', { class: 'muted server-status' }, `server status now: ${c.status}${c.error ? ` · ${c.error}` : ''}`));
  const refresh = el('button', { type: 'button', class: 'quiet tiny' }, 'reload packet');
  refresh.addEventListener('click', () => { void loadPacket(c, body); });
  children.push(refresh);
  if (!body.isConnected && !captureNodes.has(c.id)) return; // detail arrived for a row that was removed meanwhile
  replaceChildren(body, children);
}
const visionBlock = (v: NonNullable<CaptureRecord['vision']>) => el('div', { class: 'block' },
  el('h4', null, 'Vision (model interpretation of the image)'), el('p', null, v.scene),
  v.observations.length ? el('ul', null, ...v.observations.map((o) => el('li', null, o))) : null,
  v.readableText.length ? el('p', null, `Readable text: ${v.readableText.join(' | ')}`) : null,
  el('p', { class: 'muted' }, v.uncertainties.length ? `Uncertainties: ${v.uncertainties.join('; ')}` : 'No uncertainties stated'));
function packetBlock(p: Packet): HTMLElement {
  return el('div', { class: 'block' },
    el('h4', null, `Packet v${p.version}${p.correction ? ' (correction)' : ''} · created ${fmtTime(p.createdAt)}`),
    p.vision ? visionBlock(p.vision) : null,
    el('p', null, `Faces (${p.faces?.status ?? '?'}, stream ${short(p.faces?.streamId)}): ${(p.faces?.faces ?? []).map((f) => `${f.identityStatus === 'confirmed' && f.name ? f.name : 'Unknown'} #${f.trackId}${f.personId ? ` (${short(f.personId, 8)})` : ''}`).join(', ') || 'none'}`),
    el('p', null, `Audio (${p.audio?.status ?? '?'}, ${p.audio?.wordCount ?? 0} words through ${fmtTime(p.audio?.throughAt)}): `, el('span', { class: 'text' }, p.audio?.text || '—')),
    p.audio?.segments?.length ? el('p', { class: 'muted' }, `segments: ${p.audio.segments.map((s) => `${short(s.streamId, 6)}/${s.segmentId}@r${s.revision}${s.isFinal ? '' : ' (partial)'}`).join(', ')}`) : null);
}

function entitySummary(summary: HTMLElement, e: Entity): void {
  replaceChildren(summary, [el('b', null, e.kind), ` ${e.label}${e.personId ? ` · gallery ${short(e.personId, 8)}` : ''} · last seen ${fmtAgo(e.lastSeenAt, Date.now())}`]);
}
function entityRow(e: Entity): HTMLElement {
  const summary = el('summary', null); entitySummary(summary, e);
  const body = el('div', { class: 'detail' }, el('p', { class: 'muted' }, 'expand to load history…'));
  const details = el('details', null, summary, body);
  details.addEventListener('toggle', () => { if (details.open) void loadEntity(e, body); }, { once: true });
  return el('li', null, details);
}
function updateEntityRow(li: Element, e: Entity): void {
  const summary = li.querySelector('summary');
  if (summary) entitySummary(summary, e);
}
async function loadEntity(e: Entity, body: HTMLElement): Promise<void> {
  try {
    const d = await api.entity(e.id);
    const attrs = Object.entries(d.entity.attributes ?? {});
    const reload = el('button', { type: 'button', class: 'quiet tiny' }, 'reload history');
    reload.addEventListener('click', () => { void loadEntity(e, body); });
    replaceChildren(body, [
      el('p', null, d.entity.description || '(no description)'), el('p', { class: 'muted' }, `id ${d.entity.id} · created ${fmtDateTime(d.entity.createdAt)}`),
      attrs.length ? el('ul', null, ...attrs.map(([k, a]) => el('li', null, `${k} = ${a.value} (observed ${fmtTime(a.observedAt)})`))) : el('p', { class: 'muted' }, 'no attributes'),
      el('h4', null, `Observations (${d.observations.length})`),
      el('ul', null, ...d.observations.slice(-20).reverse().map((o) => el('li', { class: o.superseded ? 'superseded' : '' },
        `${fmtTime(o.observedAt)} · ${o.confidence}${o.visual ? ' · visual' : ''}${o.superseded ? ' · superseded' : ''} · `,
        possibleMatchLabel(o, e.id) ? el('b', { class: 'possible' }, `${possibleMatchLabel(o, e.id)} · `) : null,
        o.text, ' ', link(api.frameUrl(o.packetId), 'image')))),
      el('p', { class: 'muted' }, `${d.encounters?.length ?? 0} encounter(s), ${d.events?.length ?? 0} event(s)`), reload,
    ]);
  } catch (err) { replaceChildren(body, [el('p', { class: 'muted' }, `entity detail unavailable: ${msg(err)}`)]); }
}

function renderDashboard(d: Dashboard): void {
  dashboard = d;
  renderState(d);
  // Keyed reconciliation: rows the user has expanded keep their node, open state and loaded evidence.
  const caps = (d.captures ?? []).slice().sort((a, b) => b.capturedAt - a.capturedAt).slice(0, 12);
  ui.captures.querySelector('.empty')?.remove();
  reconcileKeyed(ui.captures, caps, (c) => c.id, captureNodes, captureRow, updateCaptureRow);
  if (!caps.length && !ui.captures.children.length) ui.captures.append(el('li', { class: 'empty' }, 'no captures recorded by the server yet'));
  const ents = (d.entities ?? []).slice().sort((a, b) => b.lastSeenAt - a.lastSeenAt).slice(0, 30);
  ui.entities.querySelector('.empty')?.remove();
  reconcileKeyed(ui.entities, ents, (e) => e.id, entityNodes, entityRow, updateEntityRow);
  if (!ents.length && !ui.entities.children.length) ui.entities.append(el('li', { class: 'empty' }, 'no entities yet'));
  const prev = ui.searchEntity.value;
  replaceChildren(ui.searchEntity, [el('option', { value: '' }, 'any entity'), ...ents.map((e) => el('option', { value: e.id }, `${e.kind}: ${e.label}`))]);
  if ([...ui.searchEntity.options].some((o) => o.value === prev)) ui.searchEntity.value = prev;
  const p = d.pipeline;
  const lat = p?.latencies;
  const latText = Array.isArray(lat) ? lat.slice(-8).map((l) => `${l.stage} ${fmtMs(l.ms)}`).join(' · ') : lat ? Object.entries(lat).map(([k, v]) => `${k} ${fmtMs(v)}`).join(' · ') : '—';
  const obs = Array.isArray(p?.observing) ? p.observing.length : p?.observing ?? 0;
  setText(ui.pipeline, p ? `running ${String(p.running ?? '?')} · queue ${p.queue ?? '?'} · observing ${obs} · reducing ${p.reducing ?? 'none'} · indexing ${String(p.indexing ?? '?')} · last error: ${p.lastError ?? 'none'} · recent latencies: ${latText} · stats: ${d.stats ? Object.entries(d.stats).map(([k, v]) => `${k}=${String(v)}`).join(' ') : '—'}`
    : 'pipeline status not reported');
}
async function pollDashboard(): Promise<void> {
  try { renderDashboard(await api.dashboard()); setText(ui.dashNote, `dashboard refreshed ${fmtTime(Date.now())} (GET only, every 3 s)`); }
  catch (e) { setText(ui.dashNote, `dashboard unavailable: ${msg(e)}`); }
  await pollPeople();
}

// ---- people (GET polled; DELETE only after an explicit confirmation; nothing cleared before the server confirms) ----
const DELETE_SCOPE = 'Removes this person’s recognition and profile and hides their person-linked memories from active retrieval. Source photos and transcripts are retained.';
const RESET_SCOPE = 'Removes recognition and profiles for ALL people (provisional and enrolled) and hides person-linked memories from active retrieval. Source photos and transcripts are retained.';
let people: Person[] = [];
const peopleNodes = new Map<string, Element>();
let peopleDeleting = 0;
const personLabel = (p: Person): string => `${p.name || '(unnamed)'} · ${p.enrolled ? 'enrolled' : 'provisional'} · id ${short(p.id, 8)} · last seen ${p.lastSeenAt ? fmtAgo(p.lastSeenAt, Date.now()) : '—'}`;
const currentName = (p: Person): string => people.find((x) => x.id === p.id)?.name || p.name || '(unnamed)';
function personRow(p: Person): HTMLElement {
  const label = el('span', { class: 'person-label' }, personLabel(p));
  const actions = el('span', { class: 'person-actions' });
  const li = el('li', { class: 'person' }, label, actions);
  const idle = (error: string | null = null) => {
    const del = el('button', { type: 'button', class: 'quiet tiny', 'aria-label': deleteButtonLabel(p), title: deleteButtonLabel(p) }, 'Delete…');
    del.addEventListener('click', confirmStage);
    replaceChildren(actions, [error ? el('span', { class: 'bad' }, error) : null, del]);
  };
  const confirmStage = () => {
    const yes = el('button', { type: 'button', class: 'tiny danger', 'aria-label': confirmDeleteButtonLabel({ ...p, name: currentName(p) }) }, `Confirm delete ${currentName(p)}`);
    const no = el('button', { type: 'button', class: 'quiet tiny' }, 'Cancel');
    no.addEventListener('click', () => idle());
    yes.addEventListener('click', () => { void run(); });
    replaceChildren(actions, [el('span', { class: 'scope' }, DELETE_SCOPE), yes, no]);
  };
  const run = async () => {
    peopleDeleting += 1;
    replaceChildren(actions, [el('span', { class: 'muted' }, 'deleting… waiting for the server')]);
    try {
      const r = await api.deletePerson(p.id);
      if (!r || r.deleted !== true) throw new Error('server did not confirm the deletion');
      afterPeopleDeleted(`deleted ${currentName(p)} (${short(p.id, 8)})`);
    } catch (e) { idle(`delete failed: ${msg(e)}`); setText(ui.peopleActionNote, `delete of ${currentName(p)} failed: ${msg(e)} · Could not confirm the complete deletion; refresh the people list to check the current state.`); void pollPeople(); }
    finally { peopleDeleting -= 1; }
  };
  idle();
  return li;
}
function updatePersonRow(li: Element, p: Person): void {
  const label = li.querySelector('.person-label');
  if (label) setText(label, personLabel(p));
  const del = li.querySelector<HTMLButtonElement>('.person-actions button[aria-label^="Delete "]');
  if (del) { del.setAttribute('aria-label', deleteButtonLabel(p)); del.setAttribute('title', deleteButtonLabel(p)); }
}
/** Renders EVERY person the server returned (enrolled first, then most recently seen) in the scrolling panel; counts cover the full response. */
function renderPeople(r: PeopleResponse): void {
  people = Array.isArray(r.people) ? r.people : [];
  const list = sortPeople(people);
  ui.people.querySelector('.empty')?.remove();
  reconcileKeyed(ui.people, list, (p) => p.id, peopleNodes, personRow, updatePersonRow);
  if (!list.length && !ui.people.children.length) ui.people.append(el('li', { class: 'empty' }, 'no people known to the server'));
  const n = countPeople(people);
  setText(ui.peopleNote, `${n.total} people (all shown, enrolled first) · ${n.enrolled} enrolled · ${n.provisional} provisional · refreshed ${fmtTime(Date.now())} (GET, every 3 s)${typeof r.resetBefore === 'number' ? ` · people reset at ${fmtDateTime(r.resetBefore)}` : ''}`);
  ui.peopleReset.disabled = !people.length || peopleDeleting > 0;
}
async function pollPeople(): Promise<void> {
  try { renderPeople(await api.people()); }
  catch (e) { setText(ui.peopleNote, `people list unavailable: ${msg(e)}`); ui.peopleReset.disabled = true; }
}
/** Server confirmed a deletion: discard live labels now and recycle the face connection; camera and speech keep running. */
function afterPeopleDeleted(what: string): void {
  liveFaces = null;
  current?.resetFaces(what);
  setText(ui.peopleActionNote, `${what} · server confirmed · live face labels discarded and the face connection is recycling · ${DELETE_SCOPE}`);
  void pollPeople();
}
ui.peopleReset.addEventListener('click', () => {
  const yes = el('button', { type: 'button', class: 'tiny danger' }, `Confirm reset of ${people.length} people`);
  const no = el('button', { type: 'button', class: 'quiet tiny' }, 'Cancel');
  no.addEventListener('click', () => clear(ui.peopleResetConfirm));
  yes.addEventListener('click', () => {
    peopleDeleting += 1; ui.peopleReset.disabled = true;
    replaceChildren(ui.peopleResetConfirm, [el('span', { class: 'muted' }, 'resetting… waiting for the server')]);
    api.deleteAllPeople().then((r) => {
      if (!r || r.deleted !== true) throw new Error('server did not confirm the reset');
      clear(ui.peopleResetConfirm);
      afterPeopleDeleted(`reset ${typeof r.count === 'number' ? r.count : '?'} people`);
    }).catch((e) => { replaceChildren(ui.peopleResetConfirm, [el('span', { class: 'bad' }, `reset failed: ${msg(e)} · Could not confirm the complete deletion; refresh the people list to check the current state.`)]); void pollPeople(); })
      .finally(() => { peopleDeleting -= 1; ui.peopleReset.disabled = !people.length; });
  });
  replaceChildren(ui.peopleResetConfirm, [el('span', { class: 'scope' }, RESET_SCOPE), yes, no]);
});

// ---- search (explicit submit only; keyword default, semantic optional) ------------------------------------
for (const o of SEARCH_MODE_OPTIONS) ui.searchMode.append(el('option', { value: o.value }, o.label));
ui.searchMode.value = 'keyword';
ui.searchForm.addEventListener('submit', (ev) => {
  ev.preventDefault();
  const body = buildSearchBody({ query: ui.searchQuery.value, mode: ui.searchMode.value, entityId: ui.searchEntity.value, from: ui.searchFrom.value, to: ui.searchTo.value, limit: ui.searchLimit.value });
  if (!body) return;
  setText(ui.searchNote, `searching (${body.mode})…`);
  const t0 = performance.now();
  const filterEntityId = body.entityId ?? null; // captured at submission; the selector may change before the reply
  const mode = body.mode;
  api.search(body).then((r) => {
    const hits = r.results ?? [];
    setText(ui.searchNote, searchResultNote(mode, hits.length, performance.now() - t0));
    replaceChildren(ui.searchResults, hits.length ? hits.map((h) => searchRow(h, filterEntityId, mode)) : [el('li', { class: 'empty' }, `no matching observations (${mode})`)]);
  }).catch((e) => { setText(ui.searchNote, `search failed (${mode}): ${msg(e)}`); clear(ui.searchResults); });
});
function searchRow(h: SearchHit, filterEntityId: string | null, mode: SearchMode = normalizeSearchMode(ui.searchMode.value)): HTMLElement {
  const nameOf = (id: string) => dashboard?.entities?.find((e) => e.id === id)?.label ?? short(id, 8);
  const entityNames = h.entityIds.map(nameOf);
  const candidates = unresolvedCandidates(h).map(nameOf); // never merged into the canonical entity list
  const possible = searchRowLabel(h, filterEntityId); // filtered: target must itself be unconfirmed; unfiltered: any unresolved candidate
  return el('li', { class: h.superseded ? 'superseded' : '' },
    possible ? el('div', { class: 'meta possible' }, possible) : null,
    el('div', { class: 'text' }, h.text),
    el('div', { class: 'meta' }, `${fmtDateTime(h.observedAt)}${h.endAt !== h.observedAt ? ` – ${fmtTime(h.endAt)}` : ''} · ${h.confidence}${h.visual ? ' · visual' : ' · reported'} · ${scoreLabel(mode, h.distance)}${h.superseded ? ' · SUPERSEDED' : ''}`),
    el('div', { class: 'meta' }, 'cites: ', link(api.frameUrl(h.packetId), `source image (packet ${short(h.packetId)} v${h.packetVersion})`),
      entityNames.length ? ` · entities: ${entityNames.join(', ')}` : '',
      candidates.length ? ` · possible (unconfirmed): ${candidates.join(', ')}` : '',
      h.transcriptKeys.length ? ` · transcript keys: ${h.transcriptKeys.join(', ')}` : ' · no transcript evidence'));
}

// ---- agent: status poll, manual ask, notifications (GET + SSE, deduped), tasks with cancel -----------------
const notifications = new NotificationLedger(100);
let agentStatus: AgentStatus | null = null;
let agentStatusError: string | null = null;
let streamState: StreamState = { phase: 'idle', attempt: 0, connections: 0, lastEventAt: null, lastError: null };
let agentTasks: AgentTask[] = [];
let notificationsSig = '';
const stream = new NotificationStream({
  url: agentApi.eventsUrl, clock: realClock, create: (url) => new EventSource(url),
  onNotification: (n) => { if (notifications.add(n)) renderNotifications(); },
  onState: (st) => { streamState = st; renderAgentStatus(); },
  onError: (m) => pageError(`agent stream: ${m}`),
});
function renderAgentStatus(): void {
  const v = describeAgentConnection(agentStatus, agentStatusError, streamState);
  setText(ui.agentStatus, `${v.text}${notifications.duplicates ? ` · duplicate deliveries ignored ${notifications.duplicates}` : ''}`);
  ui.agentStatus.className = `note mono ${v.tone}`;
}
async function pollAgentStatus(): Promise<void> {
  try { agentStatus = await agentApi.status(); agentStatusError = null; }
  catch (e) { agentStatusError = msg(e); }
  renderAgentStatus();
}
async function loadNotifications(): Promise<void> {
  try {
    const r = await agentApi.notifications();
    let added = 0;
    for (const raw of r.notifications ?? []) { const n = parseNotification(raw, Date.now()); if (n && notifications.add(n)) added += 1; }
    if (added || !notificationsSig) renderNotifications();
  } catch (e) { setText(ui.agentNote, `notifications unavailable: ${msg(e)}`); }
}
function notificationRow(n: AgentNotification): HTMLElement {
  const ack = el('button', { type: 'button', class: 'quiet tiny' }, 'Ack');
  const status = el('span', { class: 'meta' });
  ack.addEventListener('click', () => {
    ack.disabled = true; setText(status, 'acking…');
    agentApi.ack(n.id).then((r) => {
      if (!r || r.acked !== true) throw new Error('server did not confirm the ack');
      notifications.ack(n.id); renderNotifications();
    }).catch((e) => { ack.disabled = false; setText(status, `ack failed: ${msg(e)}`); });
  });
  const refs = n.refs.map((r) => refView(r));
  return el('li', { class: n.acked ? 'acked' : '' },
    el('div', { class: 'text' }, n.text || '(empty answer)'),
    refs.length ? el('div', { class: 'meta refs' }, ...refs.map((r) => (r.href ? link(r.href, r.label) : el('span', null, `${r.label} `)))) : null,
    el('div', { class: 'row meta' }, `${n.createdAt ? fmtDateTime(n.createdAt) : `received ${fmtTime(n.receivedAt)}`}${n.taskId ? ` · task ${short(n.taskId, 8)}` : ''} · id ${short(n.id, 8)}`,
      n.acked ? el('span', null, 'acked') : ack, status));
}
function renderNotifications(): void {
  const list = notifications.list();
  const sig = list.map((n) => `${n.id}:${n.acked ? 1 : 0}`).join('|');
  if (sig === notificationsSig) return;
  notificationsSig = sig || 'empty';
  replaceChildren(ui.agentNotifications, list.length ? list.map(notificationRow) : [el('li', { class: 'empty' }, 'no agent answers yet')]);
  renderAgentStatus();
}
let tasksSig = '';
function taskRow(t: AgentTask): HTMLElement {
  const active = isActiveTask(t.status);
  const cancel = el('button', { type: 'button', class: 'quiet tiny' }, 'Cancel');
  const note = el('span', { class: 'meta' });
  cancel.addEventListener('click', () => {
    cancel.disabled = true; setText(note, 'cancelling…');
    agentApi.cancelTask(t.id).then(() => { setText(note, 'cancel requested; waiting for the task list'); void pollTasks(); })
      .catch((e) => { cancel.disabled = false; setText(note, `cancel failed: ${msg(e)}`); });
  });
  const result = taskResultText(t.result);
  return el('li', null,
    el('div', { class: 'row' }, el('b', { class: active ? 'st-active' : 'st-terminal' }, t.status), el('span', null, typeof t.goal === 'string' && t.goal ? t.goal : '(no goal text)'), active ? cancel : null, note),
    result ? el('div', { class: 'meta text' }, `result: ${result}`) : null,
    el('div', { class: 'meta' }, `id ${short(t.id, 8)}${typeof t.updatedAt === 'number' ? ` · updated ${fmtTime(t.updatedAt)}` : typeof t.createdAt === 'number' ? ` · created ${fmtTime(t.createdAt)}` : ''}`));
}
async function pollTasks(): Promise<void> {
  try {
    const r = await agentApi.tasks();
    agentTasks = Array.isArray(r.tasks) ? r.tasks.filter((t) => t && typeof t.id === 'string') : [];
    const active = agentTasks.filter((t) => isActiveTask(t.status));
    const sig = agentTasks.map((t) => `${t.id}:${t.status}:${typeof t.updatedAt === 'number' ? t.updatedAt : ''}`).join('|');
    setText(ui.agentTasksSummary, `Tasks (${agentTasks.length}, ${active.length} active)`);
    if (sig === tasksSig) return;
    tasksSig = sig || 'empty';
    const rows = [...active, ...agentTasks.filter((t) => !isActiveTask(t.status))].slice(0, 20);
    replaceChildren(ui.agentTasks, rows.length ? rows.map(taskRow) : [el('li', { class: 'empty' }, 'no tasks')]);
  } catch (e) { setText(ui.agentTasksSummary, `Tasks (unavailable: ${msg(e)})`); }
}
ui.agentForm.addEventListener('submit', (ev) => {
  ev.preventDefault();
  const text = ui.agentInput.value.trim();
  if (!text) return;
  const running = Boolean(lastSnapshot && lastSnapshot.phase === 'running' && lastSnapshot.sessionId);
  const body: { text: string; sessionId?: string } = running && lastSnapshot?.sessionId ? { text, sessionId: lastSnapshot.sessionId } : { text };
  ui.agentSend.disabled = true;
  setText(ui.agentNote, `sending${body.sessionId ? ` (attached to session ${short(body.sessionId)})` : ' (no running session; camera stopped)'}…`);
  agentApi.ask(body).then((r) => {
    ui.agentInput.value = '';
    setText(ui.agentNote, `accepted as event ${short(r?.eventId ?? '?', 12)} at ${fmtTime(Date.now())}${body.sessionId ? ' · attached to the running session' : ' · sent without a session'} · answers arrive below when the agent notifies`);
    void pollTasks();
  }).catch((e) => setText(ui.agentNote, `send failed: ${msg(e)}`))
    .finally(() => { ui.agentSend.disabled = false; });
});

// ---- PWA: manifest + network-first shell service worker (never caches API/media) ------------------------------
function registerServiceWorker(): void {
  if (!('serviceWorker' in navigator)) { setText(ui.pwaNote, 'Install: service worker unsupported here.'); return; }
  navigator.serviceWorker.register('/sw.js').then((reg) => setText(ui.pwaNote, `Installable (shell cached, scope ${new URL(reg.scope).pathname}); API and media are never cached; phone push/hardware not verified.`))
    .catch((e) => setText(ui.pwaNote, `Service worker registration failed: ${msg(e)}`));
}

// ---- boot -----------------------------------------------------------------------------------------------
function pageError(m: string): void { pageErrors.push(m); if (pageErrors.length > 20) pageErrors.shift(); renderSnapshot(lastSnapshot); }
const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

async function boot(): Promise<void> {
  renderSnapshot(null);
  try {
    const c = await api.config();
    config = { captureIntervalMs: Number(c.captureIntervalMs) > 0 ? Number(c.captureIntervalMs) : 5000, transcriptWords: Number(c.transcriptWords) > 0 ? Number(c.transcriptWords) : 200, provider: c.provider, model: c.model, writerModel: c.writerModel, perceptionUrl: c.perceptionUrl,
      speechBackend: normalizeSpeechBackend(c.speechBackend) ?? undefined, speechNotice: typeof c.speechNotice === 'string' ? c.speechNotice : undefined };
    setText(ui.configNote, `capture every ${config.captureIntervalMs} ms · last ${config.transcriptWords} words per packet (server-assembled) · ${formatModelLabel(config)} · perception ${config.perceptionUrl ?? '(proxied)'} · speech default ${config.speechBackend ?? `${defaultSpeechBackend(config)} (config did not specify)`}`);
  } catch (e) { setText(ui.configNote, `config unavailable (${msg(e)}); using 5000 ms / 200 words defaults`); pageError(`GET /api/config failed: ${msg(e)}`); }
  ui.speechBackend.value = defaultSpeechBackend(config);
  renderSpeechNote(); renderTranscriptNote();
  await Promise.all([refreshDevices(), pollDashboard(), pollAgentStatus(), loadNotifications(), pollTasks()]);
  stream.start();
  setInterval(() => { void pollDashboard(); }, 3000);
  setInterval(() => { void pollAgentStatus(); void pollTasks(); }, 2500);
  setInterval(() => { void loadNotifications(); }, 15000); // safety net if the stream misses an event; ids dedupe
  registerServiceWorker();
}
void boot();
