// Shared presentational pieces. They receive plain data + callbacks and return DOM.
import { h, when, clock, initials } from './dom.js';

/** 'Just now' / '2 h ago' / 'Yesterday' / 'Thu 18 Sep' — the day part of when(). */
const dayOf = (iso, nowMs) => when(iso, nowMs).split(' · ')[0];
import { select } from '../store/store.js';

export function statusChip(status) {
  const state = status?.state ?? 'idle';
  const cls = state === 'running' ? 'running' : state === 'error' ? 'error' : '';
  return h('span.statusbar', { role: 'status', 'aria-live': 'polite' },
    h('span.chip', { class: cls, title: status?.message ?? '' }, h('span.dot', { 'aria-hidden': 'true' }), status?.provider === 'live' ? 'Live' : 'Demo'),
    h('span.status-text', status?.label?.replace(/^(Demo|Live) · /, '') ?? 'Not started'));
}

export function avatar(profile) {
  return h('div.avatar', { class: profile.kind === 'object' ? 'object' : '', 'aria-hidden': 'true' }, initials(profile.name));
}

/** Reminder(s) shown ABOVE a profile during an encounter. */
export function reminderBanner(reminders, profile, encounter, actions) {
  if (!reminders.length) return null;
  return h('section.reminder-banner', { 'aria-label': `Reminder for ${profile.name}`, role: 'region' },
    ...reminders.map((r) => h('div', { dataset: { reminderId: r.id } },
      h('div.kicker', `Reminder · ${profile.name}`),
      h('p.text', r.text),
      h('div.row', { style: 'margin-top:8px' },
        h('button.small', { type: 'button', onClick: () => actions.complete(r) }, 'Done'),
        h('button.small', { type: 'button', onClick: () => actions.snooze(r) }, `Snooze ${actions.snoozeMinutes} min`),
        h('button.small.quiet', { type: 'button', onClick: () => actions.dismiss(r, encounter) }, 'Not now')))));
}

/**
 * The normal profile card: name, previous encounter, notes. While the profile is in view the
 * "Last met/seen" line still describes the PREVIOUS completed encounter (that is the useful
 * context); the current one is shown as an "In view" badge.
 */
export function profileCard(profile, notes, nowMs, { link = true, encounter, previousEncounter } = {}) {
  const isPerson = profile.kind === 'person';
  const inView = Boolean(encounter && !encounter.ended_at);
  const prev = inView ? previousEncounter : (previousEncounter ?? null);
  let lastLine;
  if (prev) lastLine = `${isPerson ? 'Last met' : 'Last seen'} ${when(prev.ended_at ?? prev.started_at, nowMs)}${prev.location ? ` · ${prev.location}` : ''}`;
  else if (inView) lastLine = isPerson ? 'First meeting' : 'First time seen';
  else if (profile.last_seen_at) lastLine = `${isPerson ? 'Last met' : 'Last seen'} ${when(profile.last_seen_at, nowMs)}${profile.last_seen_location ? ` · ${profile.last_seen_location}` : ''}`;
  else lastLine = isPerson ? 'Not met yet' : 'Not seen yet';
  return h('article.card.profile-card', { 'aria-label': profile.name },
    avatar(profile),
    h('div',
      h('div.row.spread', h('h2', profile.name), inView ? h('span.tag.device', encounter.location && !/^in view$/i.test(encounter.location.trim()) ? `In view · ${encounter.location}` : 'In view') : null),
      profile.descriptor ? h('p.descriptor', profile.descriptor) : null,
      h('p.meta', lastLine),
      notes.length ? h('ul.notes', { 'aria-label': 'Notes' }, ...notes.slice(0, 3).map((n) => h('li', h('span.when', dayOf(n.created_at, nowMs)), h('span', n.text)))) : h('p.notes.muted.small', 'No notes yet.'),
      link ? h('p.small', { style: 'margin-top:10px' }, h('a', { href: `#/${isPerson ? 'people' : 'things'}/${encodeURIComponent(profile.id)}` }, notes.length > 3 ? `Open profile · ${notes.length} notes` : 'Open profile')) : null));
}

export function pendingCard(recognition) {
  return h('article.card.profile-card.pending', { 'aria-live': 'polite' },
    h('div', h('p', h('span.pending-dot', { 'aria-hidden': 'true' }), h('strong', recognition.label)),
      h('p.muted.small', { style: 'margin-top:4px' }, recognition.state === 'listening' ? 'Remember creates a profile from what they say — no photo enrolment, no head turns.' : recognition.kind === 'person' ? 'Matching against people you have met.' : 'Matching against things you keep track of.')));
}

export function transcriptList(segments, nowMs, { quiet = false, emptyText = 'Nothing heard yet. Speech in this demo is scripted; nothing listens to your microphone.' } = {}) {
  if (!segments.length) return quiet ? null : h('p.muted.small', emptyText);
  return h('ul.transcript', { 'aria-live': 'polite', 'aria-label': 'Recent speech' },
    ...segments.slice(-4).map((s) => h('li', { class: s.is_final ? '' : 'partial' },
      h('span.speaker', s.speaker === 'wearer' ? 'You' : s.speaker === 'other' ? 'Them' : '—'),
      h('span.text', s.text, s.is_final ? '' : '…'),
      directedTag(s))));
}
function directedTag(s) {
  if (!s.is_final) return h('span.tag.partial', 'Partial');
  if (s.directed === 'device') return h('span.tag.device', 'For Remember');
  if (s.directed === 'conversation') return h('span.tag', 'Conversation');
  return h('span.tag', 'Deciding…');
}

export function answerCard(answer, pending, state, nowMs, { onOpenMoment } = {}) {
  if (pending) {
    return h('div.answer', { 'aria-live': 'polite' }, h('p.q', `“${pending.question}”`), h('p.a.muted', h('span.pending-dot', { 'aria-hidden': 'true' }), 'Looking…'));
  }
  if (!answer) return null;
  const moment = answer.moment_id ? state.moments[answer.moment_id] : null;
  const profile = answer.profile_id ? state.profiles[answer.profile_id] : null;
  return h('div.answer', { class: answer.kind, 'aria-live': 'polite' },
    h('p.q', `“${answer.question}” · ${when(answer.answered_at, nowMs)}`),
    h('p.a', answer.text),
    answer.context?.length ? h('ul.ctx', ...answer.context.map((c) => h('li', c))) : null,
    moment?.status === 'saved' && moment.clip ? h('div.clip',
      h('img', { src: moment.clip.poster_url ?? '', alt: '' }),
      h('div', h('p', h('strong', moment.title)), h('p.muted.small', `${when(moment.event_at, nowMs)} · ${moment.clip.duration_s} s clip`),
        h('button.small', { type: 'button', style: 'margin-top:6px', onClick: () => onOpenMoment?.(moment) }, 'Play clip'))) : null,
    profile && !moment && answer.kind === 'found' ? h('p.small', { style: 'margin-top:8px' }, h('a', { href: `#/${profile.kind === 'person' ? 'people' : 'things'}/${encodeURIComponent(profile.id)}` }, 'Open profile')) : null);
}

/** −5 s · event · +5 s progress for a recording moment. */
export function recordingProgress(moment, nowMs) {
  const eventMs = Date.parse(moment.event_at);
  const post = Math.max(0, Math.min(1, (nowMs - eventMs) / 5000));
  const remaining = Math.max(0, Math.ceil((eventMs + 5000 - nowMs) / 1000));
  return h('div.rec', { role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': 10, 'aria-valuenow': 5 + Math.round(post * 5), 'aria-label': 'Recording clip' },
    h('div.bar', h('div.pre'), h('div.post', { style: `width:${(post * 50).toFixed(1)}%` }), h('div.mark')),
    h('div.labels', h('span', '−5 s buffered'), h('span', 'event'), h('span', remaining ? `+5 s · ${remaining} s left` : 'saving…')));
}

export function momentStatus(moment) {
  return h('span.status-pill', { class: moment.status }, moment.status === 'saved' ? 'Saved' : moment.status === 'recording' ? 'Recording' : 'Not saved');
}

export function momentRow(moment, nowMs, onOpen) {
  return h('li',
    h('button.open', { type: 'button', onClick: () => onOpen(moment), 'aria-label': `${moment.title}, ${moment.status}` },
      moment.clip?.poster_url ? h('img', { src: moment.clip.poster_url, alt: '' }) : h('div.thumb', { 'aria-hidden': 'true' }),
      h('div', h('div.row.spread', h('span.title', moment.title), momentStatus(moment)),
        moment.status === 'recording' ? recordingProgress(moment, nowMs) : h('div.when', when(moment.event_at, nowMs), moment.location ? ` · ${moment.location}` : ''))));
}

export function momentTile(moment, nowMs, onOpen, profiles) {
  const who = (moment.profile_ids ?? []).map((id) => profiles[id]?.name).filter(Boolean).join(', ');
  return h('button.moment-tile', { type: 'button', onClick: () => onOpen(moment), 'aria-label': `${moment.title}, ${moment.status}` },
    moment.clip?.poster_url ? h('img', { src: moment.clip.poster_url, alt: '' }) : h('div.noposter', moment.status === 'recording' ? 'Recording…' : 'No clip'),
    h('div.body', h('div.row.spread', h('strong', moment.title), momentStatus(moment)),
      moment.status === 'recording' ? recordingProgress(moment, nowMs) : h('p.when', when(moment.event_at, nowMs), who ? ` · ${who}` : '')));
}

export function emptyState(title, body, action) {
  return h('div.empty', h('strong', title), h('span', body), action ? h('div', { style: 'margin-top:12px' }, action) : null);
}

export function reminderStatusText(r, nowMs) {
  if (r.status === 'completed') return `Done ${when(r.completed_at, nowMs)}`;
  if (r.status === 'snoozed' && r.snoozed_until && Date.parse(r.snoozed_until) > nowMs) return `Snoozed until ${clock(r.snoozed_until)}`;
  return 'Active · shows on next encounter';
}
export { select };
