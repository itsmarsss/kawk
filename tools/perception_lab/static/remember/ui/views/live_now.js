// Live V1 "Now": persistent camera preview + 240×240 device display, Start/Stop, setup, honest
// per-component status, and the manual controls the V1 engine supports (mark moment, clear
// display, typed question, explicit introduction, cancel enrollment).
import { h, when } from '../dom.js';
import { select } from '../../store/store.js';
import { reminderBanner, profileCard, transcriptList, answerCard, momentRow, emptyState } from '../components.js';

/** Persistent nodes: created once, never re-created by state renders (video keeps playing). */
export function createStage() {
  const video = h('video', { autoplay: true, muted: true, playsInline: true, 'aria-label': 'Live camera preview' });
  video.muted = true;
  const canvas = h('canvas', { width: 240, height: 240, role: 'img', 'aria-label': 'Device display: idle' });
  const lcdText = h('p.sr-only', { 'aria-live': 'polite', id: 'lcd-text' });
  const overlay = h('canvas.cam-overlay', { 'aria-hidden': 'true' }); // face boxes + stable names, drawn over the same video
  const camCaption = h('figcaption', h('span', 'Camera'), h('span.live-tag', { id: 'cam-state' }, 'off'));
  const root = h('section.stage-grid', { 'aria-label': 'Camera and device display' },
    h('figure.scene.cam', h('div.scene-view.cam-view', video, overlay, h('div.cam-idle', { id: 'cam-idle' }, h('div.idle-mark', { 'aria-hidden': 'true' }), h('p.small.muted', 'Camera off. Press Start to begin capture (your browser will ask for permission).'))), camCaption),
    h('figure.device', h('div.device-frame', canvas), lcdText, h('figcaption', h('span', 'Device display · 240 × 240 logical'), h('span.tiny.muted', 'rendered from the server’s display action'))));
  return { root, video, canvas, overlay, lcdText, setCamera(state, label) { root.querySelector('#cam-state').textContent = label; root.querySelector('#cam-idle').hidden = state === 'live'; video.hidden = state !== 'live'; overlay.hidden = state !== 'live'; } };
}

const PHASE_LABEL = { idle: 'off', connecting: 'connecting…', ready: 'ready', running: 'running', stopped: 'stopped', error: 'error' };

/**
 * Effective decision backend for copy: the socket's runtime status wins, then /api/status
 * (environment configured, never verified), else rules. Same precedence as the status strip.
 */
export function effectiveDecisions(live, apiStatus) {
  const d = live?.decision;
  if (d) return { backend: d.backend, phase: d.phase, source: 'runtime' };
  const c = apiStatus?.decisions;
  if (c?.backend === 'typesafe') return { backend: 'typesafe', phase: null, source: 'configured' };
  return { backend: 'rules', phase: 'rules', source: c ? 'configured' : 'default' };
}

/** Copy for the "Heard" card that follows the effective backend without claiming more than is known. */
export function heardCopy(decisions, speechOn) {
  if (!speechOn) return { header: 'Speech stream off', empty: 'Speech stream is off. Type a request below instead.' };
  if (decisions.backend === 'typesafe') {
    const errorish = decisions.phase === 'error' || decisions.phase === 'backoff' || decisions.phase === 'dropped';
    return {
      header: `Live transcript · finalized speech waits for Jev${decisions.source === 'configured' ? ' (configured, not verified)' : ''}`,
      empty: errorish
        ? 'Nothing heard yet. Jev is unavailable right now, so finalized speech triggers no actions; there is no rules fallback.'
        : 'Nothing heard yet. Finalized speech is sent to Jev for a decision; nothing acts until it answers.',
    };
  }
  return { header: 'Live transcript · V1 command rules', empty: 'Nothing heard yet. Finals that match the V1 grammar act; everything else is shown as conversation.' };
}

export function renderLiveNow(ctx) {
  const { state, nowMs, actions, live, apiStatus, settings, notices } = ctx;
  const encounter = select.activeEncounter(state);
  const profile = select.activeProfile(state);
  const capturing = Boolean(live?.capturing);
  const connected = live?.session === 'connected';
  const decisions = effectiveDecisions(live, apiStatus);
  const heard = heardCopy(decisions, Boolean(settings.microphone && settings.speech.enabled));

  return h('div.now-grid',
    h('div.stack',
      controlBar(ctx, capturing, connected),
      componentStatus(live, settings, apiStatus),
      noticeList(notices),
      profile ? reminderBanner(select.dueReminders(state, profile.id, encounter.id, nowMs), profile, encounter, actions.reminder) : null,
      profile ? profileCard(profile, select.notesFor(state, profile.id), nowMs, { encounter, previousEncounter: select.previousEncounter(state, profile.id, encounter.id) })
        : emptyState(capturing ? 'Nothing recognised yet' : 'Capture is off', capturing ? 'Enrolled people and detected object categories appear here when the perception streams see them. Recognition uses the real face gallery; objects are categories, not your specific item.' : 'Start capture to run the real face, object and speech streams. Session notes and reminders still work while capture is off.'),
      enrollmentPanel(ctx),
      h('section.card', { 'aria-labelledby': 'heard-h' },
        h('div.section-head', h('h2#heard-h', 'Heard'), h('span.tiny.muted', heard.header)),
        transcriptList(state.transcript, nowMs, { quiet: Boolean(state.answer.latest || state.answer.pending), emptyText: heard.empty }),
        answerCard(state.answer.latest, state.answer.pending, state, nowMs, { onOpenMoment: actions.openMoment }),
        askForm(ctx)),
    ),
    h('aside.stack', { 'aria-label': 'Sidebar' },
      h('section.card', { 'aria-labelledby': 'recent-h' },
        h('div.section-head', h('h2#recent-h', 'Recent moments'), h('a.small', { href: '#/moments' }, 'All')),
        recentMoments(state, nowMs, actions)),
      setupPanel(ctx, capturing),
      h('p.tiny.muted', decisions.backend === 'typesafe'
        ? 'Live V1 with the optional Jev decision bridge (status above). Notes, reminders, encounters and clips live only in this temporary session; the production agent harness and durable memory are deferred. '
        : 'Live V1: real perception and a small server-side command grammar. Notes, reminders, encounters and clips live only in this temporary session; the production agent harness and durable memory are deferred. ',
        h('a', { href: '#', onClick: (e) => { e.preventDefault(); actions.live.switchMode('demo'); } }, 'Switch to Demo mode')),
      diagnostics(state, live)));
}

function controlBar(ctx, capturing, connected) {
  const { actions, live, settings } = ctx;
  const busy = live?.busy;
  return h('div.card.row.spread',
    h('div.row',
      capturing ? h('button', { type: 'button', onClick: actions.live.stop }, 'Stop')
        : busy || live?.starting ? h('button', { type: 'button', onClick: actions.live.stop, title: 'Cancel the pending start (e.g. while the browser asks for permission)' }, 'Cancel start')
        : h('button.primary', { type: 'button', disabled: !connected || (!settings.camera && !settings.microphone), title: connected ? '' : 'Waiting for the V1 session connection', onClick: actions.live.start }, 'Start'),
      h('button', { type: 'button', disabled: !capturing || !settings.camera, title: 'Save a 10 s clip around now from the real camera buffer', onClick: actions.live.markMoment }, 'Mark moment'),
      h('button.quiet', { type: 'button', disabled: !connected, onClick: actions.live.clearDisplay }, 'Clear display')),
    h('span.small.muted', connected ? (capturing ? 'Capturing' : busy || live?.starting ? 'Starting… waiting for devices' : 'Session connected · capture off') : live?.session === 'connecting' ? 'Connecting to V1 session…' : `Not connected${live?.sessionMessage ? ` · ${live.sessionMessage}` : ''}`));
}

export function componentStatus(live, settings, apiStatus = null) {
  if (!live) return null;
  const cap = live.capture ?? {};
  const item = (label, stateText, cls, detail) => h('li', h('span.comp-name', label), h('span.comp-state', { class: cls, title: stateText }, stateText), h('span.comp-detail.tiny.muted', { title: detail || null }, detail || ''));
  const capState = (v, enabled) => (!enabled ? ['disabled', ''] : v === 'live' ? ['live', 'ok'] : v === 'error' ? ['failed', 'err'] : ['off', '']);
  const stream = (kind, enabled, needsCam) => {
    const s = live.streams?.[kind] ?? { phase: 'idle' };
    if (!enabled) return ['disabled', '', ''];
    if (needsCam && settings.camera === false) return ['needs camera', '', ''];
    return [PHASE_LABEL[s.phase] ?? s.phase, s.phase === 'running' ? 'ok' : s.phase === 'error' ? 'err' : '', s.message ?? ''];
  };
  const [camT, camC] = capState(cap.camera, settings.camera);
  const [micT, micC] = capState(cap.microphone, settings.microphone);
  const [fT, fC, fM] = stream('faces', settings.faces.enabled, true);
  const [oT, oC, oM] = stream('objects', settings.objects.enabled, true);
  const [sT, sC, sM] = stream('speech', settings.speech.enabled && settings.microphone, false);
  return h('ul.components', { 'aria-label': 'Component status' },
    item('Session', live.session, live.session === 'connected' ? 'ok' : live.session === 'disconnected' ? 'err' : '', live.sessionMessage),
    item('Camera', camT, camC, cap.errors?.camera),
    item('Microphone', micT, micC, cap.errors?.microphone),
    item('Faces', fT, fC, fM),
    item('Objects', oT, oC, oM),
    item('Speech', sT, sC, sM),
    item('Clip buffer', `${live.media?.frames_sent ?? 0} frames · ${live.media?.audio_chunks ?? 0} audio chunks`, '', live.media?.frames_dropped ? `${live.media.frames_dropped} dropped` : ''),
    decisionItem(live.decision, apiStatus?.decisions));
}

/**
 * Decision backend status. Runtime status from the socket wins; before any arrives, /api/status's
 * `decisions` (environment configured, never live-verified) is shown; otherwise rules.
 */
export function decisionItem(decision, configured) {
  let text, cls = '', detail = '';
  if (decision) {
    const model = decision.model ? ` · ${decision.model}` : '';
    text = decision.backend === 'rules' ? 'rules' : `Jev ${decision.phase}${model}`;
    cls = decision.phase === 'error' ? 'err' : decision.phase === 'backoff' || decision.phase === 'dropped' ? 'warn' : decision.phase === 'ready' || decision.phase === 'deciding' ? 'ok' : '';
    detail = decision.message;
    if (decision.phase === 'backoff' && decision.retry_after_s != null) detail += ` Retry in ${Math.round(decision.retry_after_s)} s.`;
    if (decision.requires_reconfiguration) detail += ' Server needs reconfiguration.';
    if (decision.reason && decision.reason !== decision.message) detail += ` (${decision.reason})`;
  } else if (configured && configured.backend === 'typesafe') {
    text = `Jev configured${configured.model ? ` · ${configured.model}` : ''}`;
    detail = `${configured.message ?? ''} Configured means the environment is set, not verified live.`.trim();
  } else {
    text = 'rules';
    detail = configured?.message ?? 'V1 command and object rules; Jev is not connected';
  }
  return h('li', h('span.comp-name', 'Decisions'), h('span.comp-state', { class: cls, title: text }, text), h('span.comp-detail.tiny.muted', { title: detail || null }, detail || ''));
}

function noticeList(notices) {
  if (!notices?.length) return null;
  return h('ul.notices', { role: 'status' }, ...notices.slice(-3).map((n) => h('li', { class: n.level }, n.message)));
}

function enrollmentPanel(ctx) {
  const { state, actions, live } = ctx;
  const e = state.enrollment;
  const canIntroduce = live?.capturing && live.streams?.faces?.phase === 'running';
  const activeEnroll = e && ['listening', 'collecting'].includes(e.status);
  const input = h('input#intro-name', { type: 'text', maxLength: 80, placeholder: 'Their name', 'aria-label': 'Name of the one unknown person in view', disabled: !canIntroduce });
  return h('section.card', { 'aria-labelledby': 'enroll-h' },
    h('div.section-head', h('h2#enroll-h', 'Introduce someone'), h('span.tiny.muted', 'enrols one bound face into the real gallery')),
    e ? h('p.enroll-state', { class: e.status, 'aria-live': 'polite' }, h('strong', enrollLabel(e)), e.message ? ` — ${e.message}` : '', e.collected != null && e.required ? ` (${e.collected}/${e.required} frames)` : '') : h('p.muted.small', 'Needs exactly one stable, unrecognised face in view. Say “Hi, I’m …” with the speech stream on, or type the name here.'),
    h('form.ask', { onSubmit: (ev) => { ev.preventDefault(); const name = input.value.trim(); if (!name) return; actions.live.introduce(name); input.value = ''; } },
      input, h('button', { type: 'submit', disabled: !canIntroduce }, 'Introduce'),
      activeEnroll ? h('button.quiet', { type: 'button', onClick: actions.live.cancelEnrollment }, 'Cancel') : null));
}
function enrollLabel(e) {
  return { listening: 'Listening for a name', collecting: 'Learning this face', complete: 'Profile created', ambiguous: 'Ambiguous', error: 'Failed', cancelled: 'Cancelled' }[e.status] ?? e.status;
}

function askForm(ctx) {
  const input = h('input#ask-input', { type: 'text', autocomplete: 'off', maxLength: 160, placeholder: 'e.g. “where are my keys?”, “who is this?”, “remind me to ask Bob about dinner”', 'aria-label': 'Typed request (falls back for speech)' });
  return h('div', h('form.ask', { onSubmit: (e) => { e.preventDefault(); const t = input.value.trim(); if (!t) return; ctx.actions.ask(t); input.value = ''; } }, input, h('button.primary', { type: 'submit', disabled: ctx.live?.session !== 'connected' }, 'Ask')),
    h('p.tiny.muted', { style: 'margin-top:6px' }, 'Typed requests follow a fixed grammar in every mode: “where is/are my …” (observed object categories), “who is this?” (the recognised person in view — their notes and last encounter; unknown faces are never guessed), “remind me to ask Bob about dinner” (uses their enrolled name; the reminder shows next time Bob is recognised), “recall notes about …”, “remember that …”, “I’m …” (introduction), “clear the display”. With the Jev backend configured, only finalized live speech and significance are gated by Jev; typed Ask is not. Not a general assistant.'));
}

function recentMoments(state, nowMs, actions) {
  const moments = select.moments(state).slice(0, 3);
  if (!moments.length) return h('p.muted.small', 'No moments yet. “Mark moment” saves 5 s before and after now from the real camera buffer.');
  return h('ul.moment-list', ...moments.map((m) => momentRow(m, nowMs, actions.openMoment)));
}

function setupPanel(ctx, capturing) {
  const { settings, devices, apiStatus, actions } = ctx;
  const upd = (patch) => actions.live.updateSettings(patch);
  const backends = apiStatus?.backends ?? null;
  const conf = (kind, choice) => backends?.[kind]?.[choice];
  const backendSelect = (kind, key, value) => {
    const opts = ['local', 'baseten'].map((c) => { const b = conf(kind, c); return h('option', { value: c, selected: value === c, disabled: b ? !b.configured : false }, `${c}${b && !b.configured ? ' · unavailable' : ''}`); });
    return h('select', { disabled: capturing, 'aria-label': `${key} backend`, onChange: (e) => upd({ [key]: { ...settings[key], backend: e.target.value } }) }, ...opts);
  };
  const detail = (kind, choice) => { const b = conf(kind, choice); return b ? h('span.tiny.muted', b.detail) : h('span.tiny.muted', apiStatus ? 'status has no backend info' : 'server status unavailable'); };
  const devSelect = (list, value, label, key) => h('select', { disabled: capturing, 'aria-label': label, onChange: (e) => upd({ [key]: e.target.value || null }) },
    h('option', { value: '', selected: !value }, 'Default'), ...(list ?? []).map((d) => h('option', { value: d.deviceId, selected: value === d.deviceId }, d.label)));
  const toggle = (label, checked, onChange, disabled) => h('label.toggle', h('input', { type: 'checkbox', checked, disabled: capturing || disabled, onChange: (e) => onChange(e.target.checked) }), label);
  return h('details.demo-panel', { open: !capturing },
    h('summary', 'Setup', h('span.tiny.muted', { style: 'font-weight:400' }, capturing ? 'stop to change' : 'devices · components · backends')),
    h('div.inner.stack',
      h('p', 'Nothing is captured until you press Start. On macOS the camera and microphone permission belongs to the browser app (System Settings → Privacy & Security).'),
      h('div.setup-row', toggle('Camera', settings.camera, (v) => upd({ camera: v })), devSelect(devices?.cameras, settings.cameraId, 'Camera device', 'cameraId')),
      h('div.setup-row', toggle('Microphone', settings.microphone, (v) => upd({ microphone: v })), devSelect(devices?.microphones, settings.micId, 'Microphone device', 'micId')),
      h('div.setup-row', toggle('Faces (needs camera)', settings.faces.enabled, (v) => upd({ faces: { ...settings.faces, enabled: v } })), backendSelect('face', 'faces', settings.faces.backend), detail('face', settings.faces.backend)),
      h('div.setup-row', toggle('Objects (needs camera)', settings.objects.enabled, (v) => upd({ objects: { ...settings.objects, enabled: v } })), backendSelect('objects', 'objects', settings.objects.backend), detail('objects', settings.objects.backend)),
      h('div.setup-row', h('label.small.muted', { style: 'flex:1 1 100%' }, 'Object vocabulary (≤ 20, comma-separated)', h('input', { type: 'text', disabled: capturing, value: settings.objects.vocabulary.join(', '), onChange: (e) => upd({ objects: { ...settings.objects, vocabulary: e.target.value.split(',').map((s) => s.trim()).filter(Boolean).slice(0, 20) } }) }))),
      h('div.setup-row', toggle('Speech (needs microphone)', settings.speech.enabled, (v) => upd({ speech: { ...settings.speech, enabled: v } })), backendSelect('speech', 'speech', settings.speech.backend), detail('speech', settings.speech.backend)),
      h('div.row', { style: 'margin-top:8px' }, h('button.small', { type: 'button', disabled: capturing, onClick: actions.live.refreshDevices }, 'Refresh devices'), h('button.small.quiet.danger', { type: 'button', onClick: actions.live.reset }, 'Reset session'), h('span.tiny.muted', 'Reset deletes this temporary session and its clips only. Enrolled faces stay.'))));
}

function diagnostics(state, live) {
  const d = state.diagnostics;
  const lines = [
    `session: ${state.session_id ?? '—'} (${live?.session ?? '—'})`,
    `streams: ${['faces', 'objects', 'speech'].map((k) => `${k}=${live?.streams?.[k]?.streamId ?? '-'}`).join(' ')}`,
    `events applied: ${state.applied_event_ids.length} · duplicates: ${d.duplicates} · stale: ${d.stale} · rejected: ${d.rejected.length}`,
    ...d.rejected.slice(-3).map((r) => `  rejected ${r.type}: ${r.reason}`),
    `display: ${state.display ? `${state.display.card.template} “${state.display.card.title}” prio ${state.display.priority} ttl ${state.display.ttl_ms}` : '—'}`,
    'recent:', ...d.log.slice(-8).map((l) => `  ${l.at.slice(11, 23)}  ${l.type}`),
  ];
  return h('details.diag', h('summary', 'Developer diagnostics'), h('pre', lines.join('\n')));
}
