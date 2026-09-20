// KAWK ambient-memory page: one document with three views (Live / Memory / Debug). Page load: GET /api/config,
// GET /api/dashboard, agent status, enumerateDevices. Nothing records until Start (session + media + sockets).
// Navigation only changes which section is presented; the Run and its timers/sockets live in module state.
// Opening Memory reads GET /api/memory/browse + /api/agent/memory/browse; reads never record, delete or notify.
import { api, agentApi, type ClientConfig, type Dashboard, type Entity, type CaptureRecord, type Packet, type SearchHit, type Person, type PeopleResponse, type AgentStatus, type AgentTask } from './api.ts';
import { NotificationLedger, NotificationStream, describeAgentConnection, isActiveTask, parseNotification, refView, taskResultView, type AgentNotification, type StreamState } from './agentFeed.ts';
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
import { RunSwitcher, singleFlight } from './runControl.ts';
import { NOTIFICATION_TAG_PREFIX, PushController, notificationIdFromSearch, parseWorkerMessage, readPushEnvironment, type PushState } from './push.ts';
import { VIEWS, hashForView, presentation, viewFromHash, type View } from './views.ts';
import { BrowseController, CATEGORY_OPTIONS, KIND_LABEL, describeBrowse, describeStatus, filterFromForm, isSuperseded, itemFacts, timeLabel, type BrowseFilter, type BrowseItem, type BrowseState } from './memoryBrowse.ts';
import { describeInstall, type WorkerState } from './install.ts';

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
  pushEnable: $<HTMLButtonElement>('push-enable'), pushPrepare: $<HTMLButtonElement>('push-prepare'), pushDisable: $<HTMLButtonElement>('push-disable'), pushTest: $<HTMLButtonElement>('push-test'), pushClear: $<HTMLButtonElement>('push-clear'),
  pushStatus: $('push-status'), pushGuidance: $('push-guidance'), pushDelivery: $('push-delivery'),
  // views + live summary
  liveBadge: $<HTMLButtonElement>('live-badge'), liveSummary: $('live-summary'),
  // memory browser
  browseForm: $<HTMLFormElement>('browse-form'), browseKinds: $('browse-kinds'), browseEntityKind: $<HTMLSelectElement>('browse-entity-kind'), browseEntityKindLabel: $('browse-entity-kind-label'),
  browseQuery: $<HTMLInputElement>('browse-query'), browseFrom: $<HTMLInputElement>('browse-from'), browseTo: $<HTMLInputElement>('browse-to'), browseHistory: $<HTMLInputElement>('browse-history'),
  browseReset: $<HTMLButtonElement>('browse-reset'), browseRefresh: $<HTMLButtonElement>('browse-refresh'), browseNote: $('browse-note'), browseList: $('browse-list'), browseMore: $<HTMLButtonElement>('browse-more'), browseRetry: $<HTMLButtonElement>('browse-retry'),
  // install
  installStatus: $('install-status'), installSteps: $('install-steps'), pwaInstall: $<HTMLButtonElement>('pwa-install'),
};

let config: ClientConfig = { captureIntervalMs: 5000, transcriptWords: 200 };
const runs = new RunSwitcher<Run>(); // exactly one Run per Start; a Start during a switch is ignored
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
const STATUS_ROWS = ['Session', 'Camera', 'Microphone', 'Face socket', 'Speech socket', 'Cadence', 'Photos', 'Captures', 'Agent capture', 'Agent faces', 'Transcripts', 'Latency', 'Stop snapshot'] as const;
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
  renderTranscriptNote(); renderIntroduction(s); renderSpeechNote(); renderBadge(s); renderLiveSummary();
  if (!s) {
    for (const label of STATUS_ROWS) setRow(label, label === 'Session' ? 'idle — press Start' : label === 'Agent capture' ? 'polls GET /api/agent/commands every 400 ms while running; the agent can request one extra photo without moving the 5 s ticks'
      : label === 'Agent faces' ? 'live face identities go to POST /api/agent/faces on stable changes (incl. unknown / no face) and as a ≤ 1-per-3 s heartbeat while running' : '—');
    setText(ui.errorsSummary, `Errors (${pageErrors.length})`); // page-level errors (push display, streams) show even without a Run
    const idleSig = `${pageErrors.length}:0:0`;
    if (idleSig !== errorsSig) { errorsSig = idleSig; replaceChildren(ui.errorsList, pageErrors.map((m) => el('li', null, m))); }
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
  const lf = s.liveFaces;
  setRow('Agent faces', !lf ? (s.phase === 'running' ? 'live face forwarding disabled' : 'forwards stable identity-set changes + ≤ 1-per-3 s heartbeat while running')
    : `${lf.message} · known ${lf.identityKey ?? '—'} · sent ${lf.counts.sent} (changes ${lf.counts.changes}, heartbeats ${lf.counts.heartbeats}) · accepted ${lf.counts.accepted} · failed ${lf.counts.failed} · superseded ${lf.counts.superseded} · stale dropped ${lf.counts.staleDropped}${lf.lastSentAt ? ` · last ${fmtTime(lf.lastSentAt)}` : ''}${lf.lastError ? ` · last error: ${lf.lastError}` : ''}`,
    !lf ? '' : lf.stage === 'failed' ? 'bad' : lf.stage === 'sent' ? 'ok' : lf.stage === 'sending' ? 'warn' : '');
  const it = s.interrupt;
  setRow('Agent capture', !it ? (s.phase === 'running' ? 'command polling disabled' : 'polls GET /api/agent/commands every 400 ms while running')
    : `${it.message} · polls ${it.counts.polls}${it.counts.pollErrors ? ` (errors ${it.counts.pollErrors})` : ''} · claimed ${it.counts.claimed} · captured ${it.counts.captured} · failed ${it.counts.failed} · not claimed ${it.counts.notClaimed} · expired ${it.counts.expired}${it.lastPollError ? ` · last poll error: ${it.lastPollError}` : ''}`,
    !it ? '' : it.stage === 'captured' ? 'ok' : it.stage === 'failed' || it.stage === 'unavailable' ? 'bad' : it.stage === 'claiming' || it.stage === 'capturing' || it.stage === 'reporting' ? 'warn' : it.pollingHealthy ? 'ok' : '');
  const now = Date.now();
  const bl = s.backlog;
  const photoAge = bl.oldestPhotoCapturedAt !== null ? now - bl.oldestPhotoCapturedAt : null;
  setRow('Captures', `queued ${s.submissions.pending + s.submissions.submitting} · accepted (202) ${s.submissions.accepted} · failed ${s.submissions.failed} · total ${s.submissions.total} · backlog ${bl.photos} photo(s)${photoAge !== null ? `, oldest source ${fmtMs(photoAge)} old` : ''} — acceptance ≠ memory completion; see server pipeline`,
    s.submissions.failed ? 'bad' : photoAge !== null && photoAge > 15_000 ? 'warn' : '');
  const tAge = bl.oldestTranscriptReceivedAt !== null ? now - bl.oldestTranscriptReceivedAt : null;
  setRow('Transcripts', `posted ${s.transcripts.posted} · failed ${s.transcripts.failed} · dropped ${s.transcripts.dropped} · pending ${s.transcripts.pendingHttp}${tAge !== null ? ` (oldest ${fmtMs(tAge)} old)` : ''} · identical revisions suppressed ${s.transcripts.suppressed}`, s.transcripts.failed || (tAge !== null && tAge > 10_000) ? 'warn' : '');
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
  if (runs.busy) return; // a Start is already being processed (previous Run stopping / new Run starting): never two Runs
  ui.start.disabled = true; // immediately, before the previous Run's bounded Stop; renderSnapshot keeps it consistent afterwards
  const started = await runs.start(() => {
    transcripts.clear(); clear(ui.transcript); liveFaces = null;
    const run: Run = new Run({
      videoEl: ui.video, config,
      commands: { poll: (sid) => agentApi.commands(sid), claim: (id, sid) => agentApi.claim(id, sid), result: (id, body) => agentApi.result(id, body) },
      liveFaces: (body) => agentApi.faces(body),
      onUpdate: (s) => { if (runs.owns(run)) renderSnapshot(s); },
      onLiveFaces: (f) => { if (runs.owns(run)) liveFaces = f; },
      onTranscript: (t) => { if (runs.owns(run)) onTranscript(t); },
    });
    return run;
  }, async (run) => {
    renderSnapshot(run.snapshot());
    await run.start({ cameraId: ui.camera.value || null, micId: ui.mic.value || null, speechBackend: selectedSpeechBackend() });
  });
  if (started) void refreshDevices(); // labels become available after the permission grant
  renderSnapshot(runs.run?.snapshot() ?? null);
}
async function stop(): Promise<void> { await runs.stop('stopped by user'); }

ui.start.addEventListener('click', () => { void start(); });
ui.stop.addEventListener('click', () => { void stop(); });
ui.refresh.addEventListener('click', () => { void refreshDevices(); });
// Leaving the page (navigation, tab close, iOS app switch/bfcache) stops the Run: camera and microphone are released and
// nothing restarts by itself on return — recording resumes only with a fresh Start.
window.addEventListener('pagehide', () => { void runs.stop('page hidden'); });

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
function loadEntity(e: Entity, body: HTMLElement): Promise<void> { return loadEntityById(e.id, body); }
async function loadEntityById(id: string, body: HTMLElement): Promise<void> {
  const e = { id };
  try {
    const d = await api.entity(id);
    const attrs = Object.entries(d.entity.attributes ?? {});
    const reload = el('button', { type: 'button', class: 'quiet tiny' }, 'reload history');
    reload.addEventListener('click', () => { void loadEntityById(id, body); });
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
  // Outcomes, not just queue length: a shrinking queue can mean failures. Failed rows stay counted until repaired.
  const failed = typeof p?.failed === 'number' ? p.failed : null;
  const outcome = p ? `failed ${failed ?? '?'}${failed ? ' (old failures persist until repaired; raw photos/transcripts stay saved)' : ''} · committed ${p.committed ?? '?'} · accepted ${p.accepted ?? '?'}` : '';
  const memAge = typeof p?.latestMemoryAgeMs === 'number' ? `derived memory source ${fmtMs(p.latestMemoryAgeMs)} old` : p && p.latestMemoryAgeMs === null ? 'no derived memory yet' : '';
  const oldestPending = typeof p?.oldestPendingMs === 'number' && p.oldestPendingMs > 0 ? ` (oldest waiting ${fmtMs(p.oldestPendingMs)})` : '';
  setText(ui.pipeline, p ? `${outcome}${memAge ? ` · ${memAge}` : ''} · running ${String(p.running ?? '?')} · queue ${p.queue ?? '?'}${oldestPending} · observing ${obs} · reducing ${p.reducing ?? 'none'} · indexing ${String(p.indexing ?? '?')} · last error: ${p.lastError ?? 'none'} · recent latencies: ${latText} · stats: ${d.stats ? Object.entries(d.stats).map(([k, v]) => `${k}=${String(v)}`).join(' ') : '—'}`
    : 'pipeline status not reported');
  ui.pipeline.className = `mono small ${failed ? 'bad' : p?.lastError ? 'warn' : ''}`;
  renderLiveSummary();
}
const pollDashboard = singleFlight(async (): Promise<void> => { // never two dashboard GETs in flight (8 s timeout vs 3 s interval)
  try { renderDashboard(await api.dashboard()); setText(ui.dashNote, `dashboard refreshed ${fmtTime(Date.now())} (GET only, every 3 s)`); }
  catch (e) { setText(ui.dashNote, `dashboard unavailable: ${msg(e)}`); }
  await pollPeople();
});

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
  runs.run?.resetFaces(what);
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
  const v = describeAgentConnection(agentStatus, agentStatusError, streamState, Date.now());
  setText(ui.agentStatus, `${v.text}${notifications.duplicates ? ` · duplicate deliveries ignored ${notifications.duplicates}` : ''}`);
  ui.agentStatus.className = `note mono ${v.tone}`;
  renderLiveSummary();
}
const pollAgentStatus = singleFlight(async (): Promise<void> => {
  try { agentStatus = await agentApi.status(); agentStatusError = null; }
  catch (e) { agentStatusError = msg(e); }
  renderAgentStatus();
});
const loadNotifications = singleFlight(async (): Promise<void> => {
  try {
    const r = await agentApi.notifications();
    let added = 0;
    for (const raw of r.notifications ?? []) { const n = parseNotification(raw, Date.now()); if (n && notifications.add(n)) added += 1; }
    if (added || !notificationsSig) renderNotifications();
  } catch (e) { setText(ui.agentNote, `notifications unavailable: ${msg(e)}`); }
});
/**
 * Acknowledge on the server, then locally. Used by the Ack button, by opening a notification (click/`?notification=`)
 * and by a push that the service worker delivered while this page was visible and focused. Never from SSE arrival.
 */
const acksInFlight = new Set<string>();
async function ackNotification(id: string, reason: string, onError?: (m: string) => void, closeBanner = true): Promise<boolean> {
  const known = notifications.get(id);
  if (known?.acked || acksInFlight.has(id)) return Boolean(known?.acked);
  acksInFlight.add(id);
  try {
    const r = await agentApi.ack(id);
    if (!r || r.acked !== true) throw new Error('server did not confirm the ack');
    notifications.ack(id, reason); notificationsSig = ''; renderNotifications();
    if (closeBanner) void closeSystemNotification(id);
    return true;
  } catch (e) { onError?.(msg(e)); if (!onError) pageError(`ack ${short(id, 8)} (${reason}) failed: ${msg(e)}`); return false; }
  finally { acksInFlight.delete(id); }
}
const openedIds = new Set<string>();
function notificationRow(n: AgentNotification): HTMLElement {
  const ack = el('button', { type: 'button', class: 'quiet tiny' }, 'Ack');
  const status = el('span', { class: 'meta' });
  ack.addEventListener('click', () => {
    ack.disabled = true; setText(status, 'acking…');
    void ackNotification(n.id, 'Ack button', (m) => { ack.disabled = false; setText(status, `ack failed: ${m}`); });
  });
  const refs = n.refs.map((r) => refView(r));
  return el('li', { class: `${n.acked ? 'acked' : ''}${openedIds.has(n.id) ? ' opened' : ''}` },
    el('div', { class: 'text' }, n.text || '(empty answer)'),
    refs.length ? el('div', { class: 'meta refs' }, ...refs.map((r) => (r.href ? link(r.href, r.label) : el('span', null, `${r.label} `)))) : null,
    el('div', { class: 'row meta' }, `${n.createdAt ? fmtDateTime(n.createdAt) : `received ${fmtTime(n.receivedAt)}`}${n.taskId ? ` · task ${short(n.taskId, 8)}` : ''} · id ${short(n.id, 8)}`,
      n.pushAt !== null ? el('span', { class: 'via' }, `push ${fmtTime(n.pushAt)}`) : null,
      openedIds.has(n.id) ? el('span', null, 'opened from notification') : null,
      n.acked ? el('span', null, n.ackReason ? `acked (${n.ackReason})` : 'acked') : ack, status));
}
function renderNotifications(): void {
  const list = notifications.list();
  const sig = list.map((n) => `${n.id}:${n.acked ? 1 : 0}:${n.pushAt ?? ''}:${openedIds.has(n.id) ? 1 : 0}`).join('|');
  if (sig === notificationsSig) return;
  notificationsSig = sig || 'empty';
  replaceChildren(ui.agentNotifications, list.length ? list.map(notificationRow) : [el('li', { class: 'empty' }, 'no updates yet — they appear here when KAWK has something useful to say')]);
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
  const result = taskResultView(t.result);
  const answer = result.text ? (result.text.length > 240 ? `${result.text.slice(0, 240)}…` : result.text) : null;
  const receipts = result.raw ? el('details', { class: 'diag' }, el('summary', null, 'Result details (diagnostic: refs, confidence, review flags)'), el('pre', null, result.raw)) : null;
  return el('li', { class: active ? 'active' : 'terminal' },
    el('div', { class: 'row' }, el('b', { class: active ? 'st-active' : 'st-terminal' }, t.status), el('span', null, typeof t.goal === 'string' && t.goal ? t.goal : '(no goal text)'), active ? cancel : null, note),
    answer ? el('div', { class: 'text answer' }, answer) : result.structured ? el('div', { class: 'meta' }, 'no answer text in the result') : null,
    el('div', { class: 'meta' }, `id ${short(t.id, 8)}${typeof t.updatedAt === 'number' ? ` · updated ${fmtTime(t.updatedAt)}` : typeof t.createdAt === 'number' ? ` · created ${fmtTime(t.createdAt)}` : ''}`),
    receipts);
}
const pollTasks = singleFlight(async (): Promise<void> => {
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
});
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

// ---- PWA: manifest + network-first shell service worker (never caches API/media) + Web Push ----------------------
let swRegistration: Promise<ServiceWorkerRegistration | null> = Promise.resolve(null);
let workerState: WorkerState = 'serviceWorker' in navigator ? 'pending' : 'unsupported';
let swNote = '';
function registerServiceWorker(): void {
  if (!('serviceWorker' in navigator)) { swNote = 'Service worker unsupported here: no install, no push.'; renderInstall(); return; }
  swRegistration = navigator.serviceWorker.register('/sw.js').then(async (reg) => {
    workerState = 'registered';
    swNote = `Shell cached (scope ${new URL(reg.scope).pathname}); API and media are never cached; push shows here only after a test arrives; iOS background delivery is not verified.`;
    renderInstall();
    await navigator.serviceWorker.ready;
    return reg;
  }).catch((e) => { workerState = 'failed'; swNote = `Service worker registration failed: ${msg(e)}`; renderInstall(); return null; });
  // The worker tells open pages about push arrivals and notification clicks; the page never shows system notifications itself.
  navigator.serviceWorker.addEventListener('message', (ev) => {
    const m = parseWorkerMessage(ev.data);
    if (!m) return;
    if (m.type === 'push') {
      if (!notifications.markPush(m.id, Date.now())) { const n = parseNotification({ id: m.id, text: m.text }, Date.now()); if (n) { n.pushAt = Date.now(); notifications.add(n); } }
      notificationsSig = ''; renderNotifications();
      if (!m.displayed) { pageError(`push ${short(m.id, 8)}: the service worker could not display the system notification`); return; } // never acknowledge a failed display
      // Seen = acknowledged, and only then: the banner was displayed, the worker judged the window visible+focused, the page
      // re-checks that, AND the Live view (where the update row is) is the selected view. While Memory or Debug is shown the
      // Live section is off-stage, so the row is unseen and the update stays unacknowledged until the wearer opens it or Acks.
      // The banner itself is left alone (the OS showed it; the user may still tap it) — only Ack/open close banners.
      if (m.foreground && document.visibilityState === 'visible' && document.hasFocus() && currentView === 'live') void ackNotification(m.id, 'displayed in the foreground via push', undefined, false);
      return;
    }
    if (m.id) openNotification(m.id, 'opened from notification click');
  });
}
/** A notification was opened (system notification click or `?notification=` URL): highlight the row and acknowledge it. */
function openNotification(id: string, reason: string): void {
  showView('live'); // the update lives under Live → Updates; switching views never touches the Run
  openedIds.add(id); notificationsSig = ''; renderNotifications();
  void ackNotification(id, reason);
  ui.agentNotifications.scrollIntoView?.({ block: 'nearest' });
}
async function closeSystemNotification(id: string): Promise<void> {
  const reg = await swRegistration;
  if (!reg?.getNotifications) return;
  try { for (const n of await reg.getNotifications({ tag: `${NOTIFICATION_TAG_PREFIX}${id}` })) n.close(); } catch { /* not permitted here */ }
}

const push = new PushController({
  env: () => readPushEnvironment(window),
  registration: async () => (await swRegistration) as unknown as import('./push.ts').PushRegistrationLike | null,
  api: { key: () => agentApi.pushKey(), subscribe: (json) => agentApi.pushSubscribe(json), unsubscribe: (endpoint) => agentApi.pushUnsubscribe(endpoint), status: () => agentApi.pushStatus(), test: () => agentApi.pushTest() },
  clock: realClock, onState: renderPush,
});
function renderPush(p: PushState): void {
  const tone = p.stage === 'subscribed' && !p.lastError ? 'ok' : p.stage === 'denied' || p.stage === 'error' || p.lastError ? 'bad' : p.stage === 'unsupported' ? 'warn' : '';
  setText(ui.pushStatus, `notifications: ${p.stage}${p.busy ? ' (working…)' : ''} · permission ${p.permission} · ${p.message}${p.lastError && p.lastError !== p.message ? ` · error: ${p.lastError}` : ''}`);
  ui.pushStatus.className = `note mono ${tone}`;
  setText(ui.pushGuidance, p.guidance);
  // Enable is clickable only once the key + registration are cached: the click then calls pushManager.subscribe() directly.
  const canEnable = p.support.kind === 'supported' && p.prepared && !p.subscribed && !p.busy;
  ui.pushEnable.disabled = !canEnable; ui.pushEnable.hidden = p.subscribed;
  ui.pushEnable.textContent = p.stage === 'denied' ? 'Enable notifications (blocked — allow in settings first)' : p.prepared || p.support.kind !== 'supported' ? 'Enable notifications' : 'Enable notifications (preparing…)';
  ui.pushPrepare.hidden = !(p.support.kind === 'supported' && !p.prepared && !p.busy && p.stage !== 'preparing'); ui.pushPrepare.disabled = p.busy;
  ui.pushDisable.hidden = !p.subscribed; ui.pushDisable.disabled = p.busy;
  ui.pushTest.hidden = !p.subscribed; ui.pushTest.disabled = p.busy;
  const d = p.delivery;
  setText(ui.pushDelivery, p.support.kind !== 'supported' ? '' : !p.subscribed ? (p.deliveryError ? `agent push status unavailable: ${p.deliveryError}` : '')
    : `${d ? `agent push: ${d.subscriptions} device(s) · pending ${d.pending} · sent ${d.sent} · failed ${d.failed}` : 'agent push counters not loaded'}${p.deliveryAt ? ` · checked ${fmtTime(p.deliveryAt)}` : ''}${p.deliveryError ? ` · status error: ${p.deliveryError}` : ''}${p.lastTest ? ` · last test ${p.lastTest.id} queued ${fmtTime(p.lastTest.at)}` : ''} · "sent" = accepted by the push service, not proof the OS displayed it; background receipt needs a real iPhone test`);
}
ui.pushEnable.addEventListener('click', () => { void push.enable(); }); // subscribe() runs synchronously inside this handler
ui.pushPrepare.addEventListener('click', () => { void push.prepare(); });
ui.pushDisable.addEventListener('click', () => { void push.disable(); });
ui.pushTest.addEventListener('click', () => { void push.sendTest(); });
ui.pushClear.addEventListener('click', () => { push.clearStatus(); pageErrors.length = 0; renderSnapshot(lastSnapshot); });

// Back in the foreground: reopen a silently dropped stream now, and catch up on anything missed while hidden (ids dedupe).
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  stream.wake();
  void loadNotifications(); void pollAgentStatus(); void pollTasks();
  if (push.snapshot.subscribed) void push.refreshDelivery();
});

// ---- views: Live / Memory / Debug in one document. Only presentation changes; the Run is never touched. ------------
const viewSections: Record<View, HTMLElement> = { live: $('view-live'), memory: $('view-memory'), debug: $('view-debug') };
const navButtons: Record<View, HTMLButtonElement> = { live: $('nav-live'), memory: $('nav-memory'), debug: $('nav-debug') };
let memoryOpened = false;
let currentView: View = 'live'; // the only view in which an update row can be considered seen
function showView(v: View, opts: { writeHash?: boolean } = {}): void {
  currentView = v;
  for (const section of VIEWS) {
    const node = viewSections[section];
    const p = presentation(v, section);
    node.hidden = p === 'hidden';
    node.classList.toggle('offstage', p === 'offstage'); // Live stays painted: the preview keeps decoding for photos/faces
    if (p === 'shown') { node.removeAttribute('inert'); node.removeAttribute('aria-hidden'); } else { node.setAttribute('inert', ''); node.setAttribute('aria-hidden', 'true'); }
    navButtons[section].setAttribute('aria-selected', String(section === v));
    navButtons[section].tabIndex = section === v ? 0 : -1;
  }
  if (opts.writeHash !== false && location.hash !== hashForView(v)) history.replaceState(null, '', `${location.pathname}${location.search}${hashForView(v)}`);
  if (v === 'memory' && !memoryOpened) { memoryOpened = true; void applyBrowse(); } // first open reads memory (GET only)
  if (v === 'live') drawOverlay();
}
for (const v of VIEWS) navButtons[v].addEventListener('click', () => showView(v));
window.addEventListener('hashchange', () => showView(viewFromHash(location.hash), { writeHash: false }));
ui.liveBadge.addEventListener('click', () => showView('live'));

function renderBadge(s: RunSnapshot | null): void {
  const running = Boolean(s && (s.phase === 'starting' || s.phase === 'running'));
  const text = !s || s.phase === 'idle' ? 'not recording' : s.phase === 'running' ? `recording since ${fmtTime(s.startedAt)}` : s.phase === 'error' ? `error — see Debug` : s.phase;
  setText(ui.liveBadge, text);
  const cls = `badge${running ? ' rec' : s?.phase === 'error' ? ' bad' : ''}`;
  if (ui.liveBadge.className !== cls) ui.liveBadge.className = cls;
}

// ---- Now block (Live): the few numbers a wearer needs, refreshed from the Run, the dashboard and the agent feed -------
const SUMMARY_ROWS = ['Recording', 'Camera', 'Microphone', 'Speech', 'Photos', 'Memory', 'Agent', 'Last update'] as const;
const summaryValues = new Map<string, HTMLElement>();
for (const label of SUMMARY_ROWS) { const v = el('div', { class: 'v' }, '—'); summaryValues.set(label, v); ui.liveSummary.append(el('div', { class: 'k' }, label), v); }
const setSummary = (label: typeof SUMMARY_ROWS[number], value: string, tone: '' | 'ok' | 'warn' | 'bad' = '') => {
  const node = summaryValues.get(label)!; setText(node, value);
  const cls = `v ${tone}`; if (node.className !== cls) node.className = cls;
};
function renderLiveSummary(): void {
  const s = lastSnapshot; const now = Date.now();
  const running = Boolean(s && (s.phase === 'starting' || s.phase === 'running'));
  if (!s || s.phase === 'idle') setSummary('Recording', 'off — press Start; nothing is captured until then');
  else setSummary('Recording', `${s.phase}${s.startedAt ? ` since ${fmtTime(s.startedAt)}` : ''}${s.reason ? ` · ${s.reason}` : ''}`, s.phase === 'running' ? 'ok' : s.phase === 'error' ? 'bad' : 'warn');
  const faces = liveFaces && running && now - liveFaces.receivedAt <= 5000 ? ` · ${liveFaces.evidence.faces.length} face(s): ${liveFaces.evidence.faces.map(displayName).join(', ') || 'none'} (${fmtAgo(liveFaces.receivedAt, now)})` : '';
  setSummary('Camera', s && running ? `${s.camera}${s.videoSize ? ` ${s.videoSize.width}×${s.videoSize.height}` : ''}${faces}` : 'off', s && running ? (s.camera === 'live' ? 'ok' : s.camera === 'error' ? 'bad' : 'warn') : '');
  setSummary('Microphone', s && running ? `${s.microphone}${s.microphone === 'live' ? ` · level ${s.micLevel.toFixed(2)}` : ''}` : 'off', s && running ? (s.microphone === 'live' ? 'ok' : s.microphone === 'error' ? 'bad' : 'warn') : '');
  const chosen = running && s?.speechBackend ? s.speechBackend : selectedSpeechBackend();
  setSummary('Speech', s && running ? describeSpeechBackend(chosen, s.speech) : `${SPEECH_BACKEND_OPTIONS.find((o) => o.value === chosen)?.label ?? chosen} · applies at Start`, s && running ? (s.speech.phase === 'ready' ? 'ok' : s.speech.phase === 'error' ? 'bad' : 'warn') : '');
  if (s && s.phase !== 'idle') {
    const bl = s.backlog; const photoAge = bl.oldestPhotoCapturedAt !== null ? now - bl.oldestPhotoCapturedAt : null;
    setSummary('Photos', `${s.photos.drawn} taken${s.photos.interrupts ? ` (${s.photos.interrupts} for the agent)` : ''} · ${s.submissions.pending + s.submissions.submitting} uploading · ${s.submissions.accepted} accepted · ${s.submissions.failed} failed${photoAge !== null ? ` · oldest waiting ${fmtMs(photoAge)}` : ''}`, s.submissions.failed ? 'bad' : photoAge !== null && photoAge > 15_000 ? 'warn' : '');
  } else setSummary('Photos', 'one photo every 5 s while recording; the agent may request one extra');
  const p = dashboard?.pipeline;
  if (!dashboard) setSummary('Memory', 'memory service not reached yet', 'warn');
  else if (!p) setSummary('Memory', 'pipeline status not reported');
  else {
    const memAge = typeof p.latestMemoryAgeMs === 'number' ? `newest memory ${fmtMs(p.latestMemoryAgeMs)} old` : 'no derived memory yet';
    const failed = typeof p.failed === 'number' ? p.failed : 0;
    setSummary('Memory', `${memAge} · ${p.queue ?? 0} waiting${typeof p.oldestPendingMs === 'number' && p.oldestPendingMs > 0 ? ` (oldest ${fmtMs(p.oldestPendingMs)})` : ''} · ${p.committed ?? '?'} committed${failed ? ` · ${failed} failed (retained; retry needed)` : ''}${p.lastError ? ` · last error: ${p.lastError}` : ''}`, failed || p.lastError ? 'warn' : '');
  }
  const a = describeAgentConnection(agentStatus, agentStatusError, streamState, now);
  setSummary('Agent', a.text, a.tone === 'ok' ? 'ok' : a.tone === 'bad' ? 'bad' : a.tone === 'warn' ? 'warn' : '');
  const latest = notifications.list()[0];
  setSummary('Last update', latest ? `${fmtAgo(latest.createdAt ?? latest.receivedAt, now)} · ${latest.text.slice(0, 90)}${latest.text.length > 90 ? '…' : ''}` : 'none yet');
}

// ---- Memory view: browse everything that was kept (GET only; stale replies dropped; per-category paging) -------------
for (const o of CATEGORY_OPTIONS) {
  const input = el('input', { type: 'radio', name: 'browse-kind', value: o.value });
  if (o.value === 'all') input.checked = true;
  ui.browseKinds.append(el('label', { title: o.hint }, input, o.label, el('span', { class: 'count' })));
}
const selectedCategory = (): string => ui.browseKinds.querySelector<HTMLInputElement>('input:checked')?.value ?? 'all';
function currentFilter(): BrowseFilter {
  return filterFromForm({ category: selectedCategory(), query: ui.browseQuery.value, from: ui.browseFrom.value, to: ui.browseTo.value, history: ui.browseHistory.checked, entityKind: ui.browseEntityKind.value });
}
const browse = new BrowseController({ fetchPage: (url) => api.browse(url), onState: renderBrowse });
function applyBrowse(): Promise<void> { ui.browseEntityKindLabel.hidden = selectedCategory() !== 'entities'; return browse.load(currentFilter()); }
ui.browseKinds.addEventListener('change', () => { void applyBrowse(); });
ui.browseEntityKind.addEventListener('change', () => { void applyBrowse(); });
ui.browseHistory.addEventListener('change', () => { void applyBrowse(); });
ui.browseForm.addEventListener('submit', (ev) => { ev.preventDefault(); void applyBrowse(); });
ui.browseReset.addEventListener('click', () => {
  ui.browseQuery.value = ''; ui.browseFrom.value = ''; ui.browseTo.value = ''; ui.browseHistory.checked = false; ui.browseEntityKind.value = '';
  const all = ui.browseKinds.querySelector<HTMLInputElement>('input[value="all"]'); if (all) all.checked = true;
  void applyBrowse();
});
ui.browseRefresh.addEventListener('click', () => { void applyBrowse(); });
ui.browseMore.addEventListener('click', () => { void browse.loadMore(); });
ui.browseRetry.addEventListener('click', () => { void browse.retry(); });
const browseNodes = new Map<string, Element>();
let browseGen = -1; let browseSig = '';
function renderBrowse(s: BrowseState): void {
  setText(ui.browseNote, describeBrowse(s, Date.now()));
  ui.browseNote.className = `note mono${s.errors.length ? ' bad' : ''}`;
  ui.browseMore.hidden = !s.hasMore; ui.browseMore.disabled = s.loading; setText(ui.browseMore, s.loading ? 'Loading…' : 'Load more');
  ui.browseRetry.hidden = !s.errors.length || s.loading;
  for (const label of ui.browseKinds.querySelectorAll('label')) {
    const input = label.querySelector('input'); const count = label.querySelector('.count');
    if (!input || !count) continue;
    const k = s.kinds.find((x) => x.kind === input.value);
    setText(count, k ? (k.error ? '✗' : k.total !== null ? String(k.total) : k.items.length ? `${k.items.length}+` : '') : '');
  }
  if (s.generation !== browseGen) { browseGen = s.generation; browseNodes.clear(); clear(ui.browseList); browseSig = ''; } // new filter: old cards (and their loaded evidence) go
  const sig = s.items.map((i) => `${i.kind}:${i.id}`).join('|');
  if (sig !== browseSig) {
    browseSig = sig;
    ui.browseList.querySelector('.empty')?.remove();
    reconcileKeyed(ui.browseList, s.items, (i) => `${i.kind}:${i.id}`, browseNodes, browseCard, () => { /* items are immutable per id; open cards keep their evidence */ });
  }
  const empty = ui.browseList.querySelector('.empty');
  if (!s.items.length) {
    const text = s.loading ? 'loading…' : s.errors.length ? 'nothing could be loaded — see the error above and press Retry' : 'nothing matches this filter';
    if (empty) setText(empty, text); else ui.browseList.append(el('li', { class: 'empty' }, text));
  } else empty?.remove();
}
const TEXT_PREVIEW = 400;
function browseCard(it: BrowseItem): HTMLElement {
  const st = describeStatus(it);
  const captureId = it.captureId ?? (it.kind === 'captures' ? it.id : null);
  const head = el('div', { class: 'card-head' }, el('span', { class: `kind kind-${it.kind}` }, KIND_LABEL[it.kind]), el('span', { class: 'title' }, it.title || '(untitled)'), st.label ? el('span', { class: `status ${st.tone}` }, st.label) : null);
  const when = el('div', { class: 'meta when' }, `${timeLabel(it.kind)} ${fmtDateTime(it.at)} (${fmtAgo(it.at, Date.now())})${captureId ? ` · photo ${short(captureId, 8)}` : ''}${it.entityId ? ` · entity ${short(it.entityId, 8)}` : ''} · id ${short(it.id, 8)}`);
  const body = el('div', { class: 'detail' }, el('p', { class: 'muted' }, 'expand to load…'));
  const details = el('details', null, el('summary', null, 'Evidence & details'), body);
  details.addEventListener('toggle', () => { if (details.open) renderCardDetail(it, body); }, { once: true });
  const long = it.text.length > TEXT_PREVIEW;
  const li = el('li', { class: `card kind-${it.kind}${isSuperseded(it) ? ' superseded' : ''}` }, head,
    it.text ? el('div', { class: 'text' }, long ? `${it.text.slice(0, TEXT_PREVIEW)}…` : it.text) : null,
    long ? el('div', { class: 'meta trunc' }, `preview of ${it.text.length} characters · full text under Evidence & details`) : null, when);
  if (it.kind === 'captures' && captureId) { const a = link(api.frameUrl(captureId), ''); a.append(el('img', { class: 'thumb', loading: 'lazy', decoding: 'async', src: api.frameUrl(captureId), alt: `photo ${captureId}` })); li.append(a); }
  li.append(details);
  return li;
}
function renderCardDetail(it: BrowseItem, body: HTMLElement): void {
  const now = Date.now();
  const facts = itemFacts(it);
  const children: (Node | string)[] = [];
  if (it.text.length > TEXT_PREVIEW) children.push(el('h4', null, `Full text (${it.text.length} characters)`), el('p', { class: 'text full' }, it.text));
  children.push(el('h4', null, 'Details from the record'));
  if (facts.length) {
    const dl = el('dl');
    for (const f of facts) dl.append(el('dt', null, f.label), el('dd', null, f.time !== undefined ? `${fmtDateTime(f.time)} (${fmtAgo(f.time, now)})` : f.list ? el('ul', null, ...f.list.map((x) => el('li', null, x))) : f.text ?? ''));
    children.push(dl);
  } else children.push(el('p', { class: 'muted' }, 'no further fields'));
  const captureId = it.captureId ?? (it.kind === 'captures' ? it.id : null);
  if (captureId) {
    children.push(el('p', { class: 'meta' }, 'source photo: ', link(api.frameUrl(captureId), captureId)));
    if (it.kind !== 'captures') children.push(el('img', { class: 'photo', loading: 'lazy', decoding: 'async', src: api.frameUrl(captureId), alt: `source photo ${captureId}` }));
    const packetBody = el('div');
    const btn = el('button', { type: 'button', class: 'quiet tiny' }, 'Load interpreted packet');
    btn.addEventListener('click', () => { btn.disabled = true; setText(packetBody, 'loading packet…'); void loadPacketById(captureId, packetBody).finally(() => { btn.disabled = false; }); });
    children.push(el('div', { class: 'actions' }, btn), packetBody);
  }
  const entityId = it.entityId ?? (it.kind === 'entities' ? it.id : null);
  if (entityId) {
    const entityBody = el('div');
    const btn = el('button', { type: 'button', class: 'quiet tiny' }, 'Load entity history');
    btn.addEventListener('click', () => { btn.disabled = true; setText(entityBody, 'loading entity…'); void loadEntityById(entityId, entityBody).finally(() => { btn.disabled = false; }); });
    children.push(el('div', { class: 'actions' }, btn), entityBody);
  }
  children.push(el('details', { class: 'raw' }, el('summary', null, 'Raw data (JSON)'), el('pre', null, JSON.stringify({ id: it.id, kind: it.kind, at: it.at, status: it.status, captureId: it.captureId, entityId: it.entityId, data: it.data }, null, 2))));
  replaceChildren(body, children);
}
async function loadPacketById(captureId: string, body: HTMLElement): Promise<void> {
  try {
    const p = await api.packet(captureId);
    const children: (Node | string)[] = [packetBlock(p)];
    try { const h = await api.packetHistory(captureId); const versions = Array.isArray(h) ? h : h.versions ?? []; children.push(el('p', { class: 'muted' }, `${versions.length} packet version(s): ${versions.map((v) => `v${v.version}${v.correction ? ' (correction)' : ''} @ ${fmtTime(v.createdAt)}`).join(', ')}`)); }
    catch (e) { children.push(el('p', { class: 'muted' }, `history unavailable: ${msg(e)}`)); }
    if (!body.isConnected) return; // the card was removed meanwhile (new filter)
    replaceChildren(body, children);
  } catch (e) { if (body.isConnected) replaceChildren(body, [el('p', { class: 'muted' }, /404/.test(msg(e)) ? 'no interpreted packet yet: the frame is retained but still queued or its interpretation failed/pending' : `packet unavailable: ${msg(e)}`)]); }
}

// ---- Install block (Live): honest status + steps; the Install button exists only when the browser offered a prompt ----
let deferredInstall: (Event & { prompt(): Promise<unknown> }) | null = null;
function renderInstall(): void {
  const env = readPushEnvironment(window);
  const v = describeInstall({ isIOS: env.isIOS, standalone: env.standalone, isSecureContext: env.isSecureContext, protocol: env.protocol, hostname: env.hostname, hasServiceWorker: env.hasServiceWorker, canPrompt: deferredInstall !== null, worker: workerState, userAgent: navigator.userAgent });
  setText(ui.installStatus, v.status);
  const cls = `note ${v.tone}`; if (ui.installStatus.className !== cls) ui.installStatus.className = cls;
  replaceChildren(ui.installSteps, v.steps.map((step) => el('li', null, step)));
  ui.pwaInstall.hidden = !v.showInstallButton;
  setText(ui.pwaNote, `${v.note}${swNote ? ` ${swNote}` : ''}`);
}
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferredInstall = e as Event & { prompt(): Promise<unknown> }; renderInstall(); });
window.addEventListener('appinstalled', () => { deferredInstall = null; renderInstall(); });
ui.pwaInstall.addEventListener('click', () => { const p = deferredInstall; if (!p) return; deferredInstall = null; renderInstall(); p.prompt().catch(() => undefined).finally(renderInstall); });
try { window.matchMedia('(display-mode: standalone)').addEventListener('change', renderInstall); } catch { /* matchMedia unavailable */ }

// ---- boot -----------------------------------------------------------------------------------------------
function pageError(m: string): void { pageErrors.push(m); if (pageErrors.length > 20) pageErrors.shift(); renderSnapshot(lastSnapshot); }
const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

async function boot(): Promise<void> {
  showView(viewFromHash(location.hash), { writeHash: false });
  renderInstall();
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
  setInterval(renderLiveSummary, 2000); // ages in the Now block keep moving while idle
  registerServiceWorker();
  void push.prepare(); // caches key + registration and re-syncs an existing subscription; never prompts — only Enable does
  const opened = notificationIdFromSearch(location.search);
  if (opened) { // the service worker opened this page from a notification click
    openNotification(opened, 'opened from notification');
    const url = new URL(location.href); url.searchParams.delete('notification'); history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
  }
}
void boot();
