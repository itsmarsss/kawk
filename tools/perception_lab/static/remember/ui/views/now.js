// Now: quiet scene, reminder above the active profile, what was heard, recent moments, demo controls.
import { h } from '../dom.js';
import { select } from '../../store/store.js';
import { reminderBanner, profileCard, pendingCard, transcriptList, answerCard, momentRow, emptyState } from '../components.js';

export function renderNow(ctx) {
  const { state, nowMs, actions } = ctx;
  const encounter = select.activeEncounter(state);
  const profile = select.activeProfile(state);
  const running = state.status?.state === 'running';

  return h('div.now-grid',
    h('div.stack',
      sceneFigure(state, running),
      profile ? reminderBanner(select.dueReminders(state, profile.id, encounter.id, nowMs), profile, encounter, actions.reminder) : null,
      profile ? profileCard(profile, select.notesFor(state, profile.id), nowMs, { encounter, previousEncounter: select.previousEncounter(state, profile.id, encounter.id) })
        : state.recognition ? pendingCard(state.recognition)
        : emptyState(running ? 'Nothing in view' : 'Remember is paused', running ? 'When someone you know, or something you track, comes into view it appears here.' : 'Start the demo to see recognitions, reminders and recall — all from scripted fixtures.',
          running ? null : h('button.primary', { type: 'button', onClick: actions.demo.runSequence }, 'Start demo')),
      h('section.card', { 'aria-labelledby': 'heard-h' },
        h('div.section-head', h('h2#heard-h', 'Heard'), h('span.tiny.muted', 'Simulated speech · no microphone')),
        transcriptList(state.transcript, nowMs, { quiet: Boolean(state.answer.latest || state.answer.pending) }),
        answerCard(state.answer.latest, state.answer.pending, state, nowMs, { onOpenMoment: actions.openMoment }),
        askForm(ctx)),
    ),
    h('aside.stack', { 'aria-label': 'Sidebar' },
      h('section.card', { 'aria-labelledby': 'recent-h' },
        h('div.section-head', h('h2#recent-h', 'Recent moments'), h('a.small', { href: '#/moments' }, 'All')),
        recentMoments(state, nowMs, actions)),
      demoPanel(ctx),
      diagnostics(state)));
}

function sceneFigure(state, running) {
  const scene = state.scene ?? { kind: 'idle', caption: 'Nothing in view' };
  const showing = running && scene.kind !== 'idle' && scene.illustration_url;
  return h('figure.scene',
    h('div.scene-view', showing ? h('img', { src: scene.illustration_url, alt: `Demo illustration: ${scene.caption}` }) : h('div.idle-mark', { 'aria-hidden': 'true' })),
    h('figcaption', h('span', running ? scene.caption : 'Camera off · demo not running'), h('span.live-tag', showing ? 'Demo scene' : running ? 'Watching (simulated)' : '')));
}

function askForm(ctx) {
  const input = h('input#ask-input', { type: 'text', autocomplete: 'off', maxLength: 160, placeholder: 'Ask Remember — e.g. “where are my keys?”', 'aria-label': 'Ask Remember (typed, stands in for speech)' });
  const form = h('form.ask', { onSubmit: (e) => { e.preventDefault(); const t = input.value.trim(); if (!t) return; ctx.actions.ask(t); input.value = ''; } },
    input, h('button.primary', { type: 'submit' }, 'Ask'));
  return h('div', form, h('p.tiny.muted', { style: 'margin-top:6px' }, 'Typing stands in for device-directed speech. No wake word; the provider decides what is meant for Remember.'));
}

function recentMoments(state, nowMs, actions) {
  const moments = select.moments(state).slice(0, 3);
  if (!moments.length) return h('p.muted.small', 'No moments yet.');
  return h('ul.moment-list', ...moments.map((m) => momentRow(m, nowMs, actions.openMoment)));
}

function demoPanel(ctx) {
  const { state, actions, scenarios } = ctx;
  const running = state.status?.state === 'running';
  return h('details.demo-panel', { open: true },
    h('summary', 'Demo controls', h('span.tiny.muted', { style: 'font-weight:400' }, 'scripted scenes')),
    h('div.inner',
      h('p', 'Every scene is a fixture. Nothing here runs a camera, microphone or model.'),
      h('div.row',
        h('button.primary', { type: 'button', onClick: actions.demo.runSequence }, running ? 'Run full sequence' : 'Start demo'),
        running ? h('button', { type: 'button', onClick: actions.demo.stop }, 'Stop') : null),
      h('p', 'Or trigger one scene:'),
      h('div.scene-buttons', ...scenarios.map((s) => h('button.small', { type: 'button', onClick: () => actions.demo.runScenario(s.key) }, h('span', s.title), h('span.hint', s.hint)))),
      h('div.row', { style: 'margin-top:14px' }, h('button.small.quiet.danger', { type: 'button', onClick: actions.demo.reset }, 'Reset demo data'),
        h('span.tiny.muted', 'Clears this browser’s demo data only.'))));
}

function diagnostics(state) {
  const d = state.diagnostics;
  const lines = [
    `session: ${state.session_id ?? '—'}`,
    `provider: ${state.status?.provider ?? '—'} (${state.status?.state ?? 'idle'})`,
    `events applied: ${state.applied_event_ids.length} · duplicates dropped: ${d.duplicates} · rejected: ${d.rejected.length}`,
    ...d.rejected.slice(-3).map((r) => `  rejected ${r.type}: ${r.reason}`),
    'recent:',
    ...d.log.slice(-8).map((l) => `  ${l.at.slice(11, 23)}  ${l.type}`),
  ];
  return h('details.diag', h('summary', 'Developer diagnostics'), h('pre', lines.join('\n')));
}
