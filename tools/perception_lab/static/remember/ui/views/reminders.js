// Reminders: create / edit / delete; grouped by state.
import { h } from '../dom.js';
import { select } from '../../store/store.js';
import { emptyState, reminderStatusText } from '../components.js';

export function renderReminders(ctx) {
  const { state, nowMs, actions } = ctx;
  const all = select.reminders(state);
  const people = select.people(state);
  const groups = [
    ['Active', all.filter((r) => r.status === 'active' || (r.status === 'snoozed' && (!r.snoozed_until || Date.parse(r.snoozed_until) <= nowMs)))],
    ['Snoozed', all.filter((r) => r.status === 'snoozed' && r.snoozed_until && Date.parse(r.snoozed_until) > nowMs)],
    ['Completed', all.filter((r) => r.status === 'completed')],
  ].filter(([, list]) => list.length);
  return h('div',
    h('div.page-head', h('div', h('h1', 'Reminders'), h('p', 'Tied to a person. Remember brings one up the next time that person is recognised.')),
      h('button.primary', { type: 'button', disabled: !people.length, onClick: () => actions.reminder.create() }, 'New reminder')),
    all.length ? groups.map(([title, list]) => h('div', h('h2.group-title', title), h('div.card', ...list.map((r) => row(ctx, r)))))
      : emptyState('No reminders', people.length ? 'Create one for someone you have met.' : ctx.mode === 'live' ? 'Reminders attach to a person; enrol someone first.' : 'Meet someone first — run “Teammate arrives” from Now.'));
}

function row(ctx, r) {
  const { state, nowMs, actions } = ctx;
  const who = state.profiles[r.profile_id]?.name ?? 'Unknown person';
  return h('div.reminder-row', { class: r.status },
    h('div', h('p.who', who, r.source === 'demo-fixture' ? ' · seeded demo reminder' : ''), h('p.text', r.text), h('p.who', reminderStatusText(r, nowMs))),
    h('div.actions',
      r.status !== 'completed' ? h('button.small', { type: 'button', onClick: () => actions.reminder.complete(r) }, 'Done') : null,
      r.status === 'active' ? h('button.small', { type: 'button', onClick: () => actions.reminder.snooze(r) }, `Snooze ${actions.reminder.snoozeMinutes} min`) : null,
      r.status === 'snoozed' || r.status === 'completed' ? h('button.small', { type: 'button', onClick: () => actions.reminder.reactivate(r) }, 'Reactivate') : null,
      h('button.small.quiet', { type: 'button', onClick: () => actions.reminder.edit(r) }, 'Edit'),
      h('button.small.quiet.danger', { type: 'button', onClick: () => actions.reminder.remove(r) }, 'Delete')));
}
