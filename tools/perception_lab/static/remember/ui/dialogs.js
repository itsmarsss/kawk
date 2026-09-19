// Modal dialogs (native <dialog>): moment player, reminder form, note form, confirm.
// Dialogs live outside the re-rendered <main>, so playback and typed text survive state updates.
import { h, full, clockS, when, replaceChildren } from './dom.js';

const host = () => document.getElementById('dialogs') ?? document.body;

/** Open a dialog, trap focus natively, return focus to the opener on close. */
function open(dialogEl, { onClose } = {}) {
  const opener = document.activeElement;
  host().append(dialogEl);
  dialogEl.addEventListener('close', () => {
    dialogEl.remove();
    onClose?.();
    if (opener && typeof opener.focus === 'function' && document.contains(opener)) opener.focus();
  });
  dialogEl.addEventListener('click', (e) => { if (e.target === dialogEl) dialogEl.close(); }); // backdrop click
  dialogEl.showModal();
  return dialogEl;
}

const head = (title, subtitle, dlg) => h('div.dlg-head',
  h('div', h('h2', title), subtitle ? h('p.muted.small', subtitle) : null),
  h('button.quiet', { type: 'button', 'aria-label': 'Close', onClick: () => dlg.close() }, '✕'));

/* ------------------------------------------------------------ moment player */

/**
 * Moment detail. Subscribes to the store so a recording moment becomes playable when its
 * `moment.saved` arrives (or shows the failure), while unrelated state updates leave an
 * already-playing <video> untouched. A deleted moment closes the dialog.
 * @param {string} momentId
 * @param {{getMoment: () => object|null, subscribe: (fn: () => void) => () => void, onDelete?: (m) => void, profiles?: object}} deps
 */
export function openMomentDialog(momentId, { getMoment, subscribe, onDelete, profiles = {} }) {
  const first = getMoment();
  if (!first) return null;
  const dlg = h('dialog', { 'aria-labelledby': 'moment-title' });
  const body = h('div.dlg-body');
  let video = null;
  let signature = null;

  const sig = (m) => (m ? `${m.status}|${m.clip?.url ?? ''}|${m.failure_reason ?? ''}` : 'gone');

  function teardownVideo() {
    if (!video) return;
    video.pause(); video.removeAttribute('src'); video.querySelector('source')?.remove(); video.load?.();
    video = null;
  }

  function renderBody(m) {
    teardownVideo();
    const parts = [];
    if (m.status === 'saved' && m.clip?.url) {
      const err = h('div.clip-error', { hidden: true, role: 'alert' });
      video = h('video', { controls: true, preload: 'metadata', playsInline: true, poster: m.clip.poster_url ?? null, 'aria-label': `Clip: ${m.title}` },
        h('source', { src: m.clip.url, type: m.clip.mime ?? 'video/mp4' }));
      video.addEventListener('error', () => { err.hidden = false; err.textContent = `The clip could not be loaded from ${m.clip.url}. If this is a fresh checkout, the fixture video has not been generated yet.`; }, true);
      parts.push(video, err);
      if (m.clip.coverage === 'partial') parts.push(h('p.muted.small', coverageText(m)));
    } else if (m.status === 'recording') {
      parts.push(h('p.muted', { 'aria-live': 'polite' }, 'Still capturing the 5 seconds after the event. The clip becomes playable here as soon as that finishes.'));
    } else {
      parts.push(h('div.clip-error', `No clip. ${m.failure_reason ?? 'The recording did not complete.'}`));
    }
    const who = (m.profile_ids ?? []).map((id) => profiles[id]?.name).filter(Boolean).join(', ');
    parts.push(
      m.summary ? h('p', m.summary) : null,
      h('dl.meta-grid',
        h('dt', 'Event'), h('dd', full(m.event_at)),
        h('dt', 'Requested'), h('dd', '5 s before · 5 s after'),
        h('dt', 'Clip'), h('dd', m.clip ? `${clockS(m.clip.start_at)} – ${clockS(m.clip.end_at)} · ${m.clip.duration_s} s${m.clip.coverage === 'complete' ? ' · full window' : ' · partial window'}` : m.status === 'recording' ? 'capturing…' : '—'),
        who ? h('dt', 'With') : null, who ? h('dd', who) : null,
        m.location ? h('dt', 'Where') : null, m.location ? h('dd', m.location) : null,
        h('dt', 'Saved'), h('dd', m.saved_at ? full(m.saved_at) : (m.status === 'saved' ? 'yes' : m.status === 'recording' ? 'not yet' : 'not saved')),
        h('dt', 'Source'), h('dd', sourceLabel(m))),
      h('div.dlg-actions',
        onDelete ? h('button.danger.left', { type: 'button', onClick: async () => { if (await confirmDialog('Delete this moment and its clip?', 'Delete')) { onDelete(m); dlg.close(); } } }, 'Delete') : null,
        h('button', { type: 'button', onClick: () => dlg.close() }, 'Close')));
    replaceChildren(body, parts);
    signature = sig(m);
  }

  dlg.append(head(first.title, when(first.event_at), dlg), body);
  dlg.querySelector('h2').id = 'moment-title';
  renderBody(first);
  const unsubscribe = subscribe(() => {
    const m = getMoment();
    if (!m) { dlg.close(); return; }
    if (sig(m) !== signature) renderBody(m); // status/clip changed; otherwise leave playback alone
  });
  open(dlg, { onClose: () => { unsubscribe(); teardownVideo(); } });
  return dlg;
}

function coverageText(m) {
  const before = (Date.parse(m.event_at) - Date.parse(m.clip.start_at)) / 1000;
  const after = (Date.parse(m.clip.end_at) - Date.parse(m.event_at)) / 1000;
  return `Footage covers ${before.toFixed(1)} s before and ${after.toFixed(1)} s after the event; 5 s each was requested. The rest was not in the buffer.`;
}

function sourceLabel(m) {
  const k = m.clip?.provenance?.kind ?? m.source;
  if (k === 'demo-fixture' || m.source === 'demo-fixture') return `Demo fixture${m.clip?.provenance?.detail ? ` — ${m.clip.provenance.detail}` : ''}`;
  if (k === 'live-ring-buffer') return `Hub frame ring buffer${m.clip?.provenance?.detail ? ` — ${m.clip.provenance.detail}` : ''}`;
  return String(k);
}

/* ------------------------------------------------------------ reminder form */

export function openReminderDialog({ reminder, profiles, defaultProfileId, onSave, storageNote = null }) {
  const dlg = h('dialog', { 'aria-labelledby': 'rem-title' });
  const people = profiles.filter((p) => p.kind === 'person');
  const select = h('select', { id: 'rem-person', required: true },
    ...people.map((p) => h('option', { value: p.id, selected: (reminder?.profile_id ?? defaultProfileId) === p.id }, p.name)));
  const text = h('textarea', { id: 'rem-text', required: true, maxLength: 240, placeholder: 'What should Remember bring up next time you see them?' });
  text.value = reminder?.text ?? '';
  const err = h('p.form-error', { role: 'alert' });
  const form = h('form', { method: 'dialog', onSubmit: (e) => {
    e.preventDefault();
    const t = text.value.trim();
    if (!t) { err.textContent = 'Write the reminder first.'; text.focus(); return; }
    if (!select.value) { err.textContent = 'Pick a person.'; select.focus(); return; }
    onSave({ profile_id: select.value, text: t });
    dlg.close();
  } },
    h('label', { for: 'rem-person' }, 'Person', select),
    h('label', { for: 'rem-text' }, 'Reminder', text),
    h('p.muted.small', storageNote ? `Shown above their profile the next time they are recognised. ${storageNote}` : 'Shown above their profile the next time they are recognised.'),
    err,
    h('div.dlg-actions', h('button', { type: 'button', onClick: () => dlg.close() }, 'Cancel'), h('button.primary', { type: 'submit' }, reminder ? 'Save changes' : 'Add reminder')));
  dlg.append(head(reminder ? 'Edit reminder' : 'New reminder', people.length ? null : 'No people yet — meet someone first.', dlg), h('div.dlg-body', form));
  dlg.querySelector('h2').id = 'rem-title';
  open(dlg);
  text.focus();
  return dlg;
}

/* ---------------------------------------------------------------- note form */

export function openNoteDialog({ note, profileName, onSave, storageNote = 'Kept in this browser’s demo data.' }) {
  const dlg = h('dialog', { 'aria-labelledby': 'note-title' });
  const text = h('textarea', { id: 'note-text', required: true, maxLength: 400 });
  text.value = note?.text ?? '';
  const err = h('p.form-error', { role: 'alert' });
  const form = h('form', { method: 'dialog', onSubmit: (e) => {
    e.preventDefault();
    const t = text.value.trim();
    if (!t) { err.textContent = 'Write something first.'; text.focus(); return; }
    onSave(t); dlg.close();
  } },
    h('label', { for: 'note-text' }, `Note about ${profileName}`, text),
    err,
    h('div.dlg-actions', h('button', { type: 'button', onClick: () => dlg.close() }, 'Cancel'), h('button.primary', { type: 'submit' }, note ? 'Save' : 'Add note')));
  dlg.append(head(note ? 'Edit note' : 'Add note', storageNote, dlg), h('div.dlg-body', form));
  dlg.querySelector('h2').id = 'note-title';
  open(dlg);
  text.focus();
  return dlg;
}

/* ------------------------------------------------------------------ confirm */

export function confirmDialog(message, confirmLabel = 'OK') {
  return new Promise((resolve) => {
    let result = false;
    const dlg = h('dialog', { 'aria-labelledby': 'confirm-title' });
    dlg.append(head('Are you sure?', null, dlg), h('div.dlg-body', h('p#confirm-title', message),
      h('div.dlg-actions', h('button', { type: 'button', onClick: () => dlg.close() }, 'Cancel'),
        h('button.primary', { type: 'button', onClick: () => { result = true; dlg.close(); } }, confirmLabel))));
    open(dlg, { onClose: () => resolve(result) });
    dlg.querySelector('button.primary').focus();
  });
}
