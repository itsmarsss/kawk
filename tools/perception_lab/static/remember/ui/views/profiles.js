// People and Things: lists plus the profile detail page (notes, reminders, moments, encounters).
import { h, when, clock } from '../dom.js';
import { select } from '../../store/store.js';
import { avatar, emptyState, momentRow, reminderStatusText } from '../components.js';

export function renderProfiles(ctx, kind, id) {
  if (id) return renderDetail(ctx, kind, id);
  const { state, nowMs } = ctx;
  const items = kind === 'person' ? select.people(state) : select.things(state);
  const title = kind === 'person' ? 'People' : 'Things';
  return h('div',
    h('div.page-head', h('div', h('h1', title), h('p', kind === 'person' ? 'Everyone Remember has met. New people are added when they introduce themselves.' : 'Objects Remember keeps track of, with where they were last seen.'))),
    items.length ? h('div.card', ...items.map((p) => listRow(ctx, p)))
      : emptyState(kind === 'person' ? 'No people yet' : 'Nothing tracked yet',
        ctx.mode === 'live'
          ? (kind === 'person' ? 'Enrolled people from the face gallery appear here; new ones are added by an introduction while capture runs.' : 'Object categories from the object stream appear here while capture runs.')
          : (kind === 'person' ? 'Run “Teammate arrives” or “New introduction” from Now.' : 'Run “Keys on the desk” from Now.'),
        h('a.btn', { href: '#/now' }, 'Go to Now')));
}

function listRow(ctx, p) {
  const { state, nowMs } = ctx;
  const notes = select.notesFor(state, p.id).length;
  const open = select.remindersFor(state, p.id).filter((r) => r.status !== 'completed').length;
  const href = `#/${p.kind === 'person' ? 'people' : 'things'}/${encodeURIComponent(p.id)}`;
  return h('div.list-row',
    avatar(p),
    h('div', h('a.name', { href }, p.name), h('div.sub', [p.descriptor, `${p.kind === 'person' ? 'Last met' : 'Last seen'} ${when(p.last_seen_at, nowMs)}`].filter(Boolean).join(' · '))),
    h('div.sub.trail', [notes ? `${notes} note${notes > 1 ? 's' : ''}` : null, open ? `${open} reminder${open > 1 ? 's' : ''}` : null].filter(Boolean).join(' · ')));
}

function sourceText(p, mode) {
  switch (p.source) {
    case 'demo-fixture': return 'Seeded demo data';
    case 'introduction': return mode === 'live' ? 'Enrolled from an introduction · face gallery' : 'Created from an introduction · demo data';
    case 'live-perception': return p.kind === 'person' ? 'Face gallery identity · encounters kept for this session only' : 'Object category from the object stream · this session only';
    case 'v1-rules': return 'Created by V1 rules · temporary session';
    case 'user': return 'Added by you · temporary session';
    default: return mode === 'live' ? 'Temporary session data' : 'Demo data';
  }
}

function renderDetail(ctx, kind, id) {
  const { state, nowMs, actions } = ctx;
  const p = state.profiles[id];
  const backHref = kind === 'person' ? '#/people' : '#/things';
  if (!p) return h('div', h('p.small', h('a', { href: backHref }, '← Back')), emptyState('Not found', 'This profile is not in the demo data (it may have been reset).'));
  const notes = select.notesFor(state, p.id);
  const reminders = select.remindersFor(state, p.id);
  const moments = select.momentsFor(state, p.id);
  const encounters = select.encountersFor(state, p.id).slice(0, 5);
  const isPerson = p.kind === 'person';
  return h('div',
    h('p.small', h('a', { href: backHref }, `← ${isPerson ? 'People' : 'Things'}`)),
    h('header.card.profile-card', { style: 'margin-top:10px' }, avatar(p),
      h('div', h('h1', p.name), p.descriptor ? h('p.descriptor', p.descriptor) : null,
        h('p.meta', `${isPerson ? 'Last met' : 'Last seen'} ${when(p.last_seen_at, nowMs)}`, p.last_seen_location ? ` · ${p.last_seen_location}` : ''),
        h('p.tiny.muted', { style: 'margin-top:6px' }, sourceText(p, ctx.mode)))),

    isPerson ? h('section.section', { 'aria-labelledby': 'rem-h' },
      h('div.section-head', h('h2#rem-h', 'Reminders'), h('button.small', { type: 'button', onClick: () => actions.reminder.create(p.id) }, 'Add reminder')),
      reminders.length ? h('div.card', ...reminders.map((r) => h('div.reminder-row', { class: r.status },
        h('div', h('p.text', r.text), h('p.who', reminderStatusText(r, nowMs))),
        h('div.actions',
          r.status !== 'completed' ? h('button.small', { type: 'button', onClick: () => actions.reminder.complete(r) }, 'Done') : null,
          h('button.small.quiet', { type: 'button', onClick: () => actions.reminder.edit(r) }, 'Edit'),
          h('button.small.quiet.danger', { type: 'button', onClick: () => actions.reminder.remove(r) }, 'Delete')))))
        : h('p.muted.small', 'No reminders. Add one and it appears above this profile next time you meet.')) : null,

    h('section.section', { 'aria-labelledby': 'notes-h' },
      h('div.section-head', h('h2#notes-h', 'Notes'), h('button.small', { type: 'button', onClick: () => actions.note.create(p) }, 'Add note')),
      notes.length ? h('div.card', h('ul.notes', { style: 'border-top:0;padding-top:0;margin-top:0' }, ...notes.map((n) => h('li', { style: 'padding:8px 0' },
        h('span.when', when(n.created_at, nowMs).split(' · ')[0]),
        h('span', { style: 'flex:1 1 auto' }, n.text, n.source === 'introduction' ? h('span.tiny.muted', ' · from introduction') : n.source === 'user' ? h('span.tiny.muted', ' · yours') : null),
        h('span.row', { style: 'gap:2px' }, h('button.small.quiet', { type: 'button', onClick: () => actions.note.edit(n, p) }, 'Edit'), h('button.small.quiet.danger', { type: 'button', onClick: () => actions.note.remove(n) }, 'Delete'))))))
        : h('p.muted.small', 'No notes yet.')),

    h('section.section', { 'aria-labelledby': 'mom-h' },
      h('div.section-head', h('h2#mom-h', 'Moments')),
      moments.length ? h('div.card', h('ul.moment-list', ...moments.map((m) => momentRow(m, nowMs, actions.openMoment)))) : h('p.muted.small', 'No saved moments with this ' + (isPerson ? 'person' : 'object') + '.')),

    h('section.section', { 'aria-labelledby': 'enc-h' },
      h('div.section-head', h('h2#enc-h', 'Encounters')),
      encounters.length ? h('div.card', h('ul', ...encounters.map((e) => h('li.small', { style: 'padding:4px 0' }, `${when(e.started_at, nowMs)}${e.ended_at ? ` – ${clock(e.ended_at)}` : ' · in view'}`, e.location ? h('span.muted', ` · ${e.location}`) : null)))) : h('p.muted.small', 'No encounters recorded.')));
}
