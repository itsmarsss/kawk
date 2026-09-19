// Bootstrap: store + provider + router + render loop. The only module that knows about all of them.
// Two modes (config.js): Live V1 (default) and Demo. Each mode has its own provider and store
// namespace; switching modes reloads the page so the two are never mixed.
import { createStore } from './store/store.js';
import { createPersistence, memoryStorage, namespaceFor, RESET_SIGNAL_KEY } from './store/persist.js';
import { createProvider, CONFIG, currentMode, setMode, LIVE_SETTINGS_KEY } from './config.js';
import { newId, SCHEMA_VERSION } from './contracts/envelope.js';
import { h, renderPreservingFocus, toast } from './ui/dom.js';
import { ROUTES, onRoute, parseHash, navigate } from './ui/router.js';
import { statusChip } from './ui/components.js';
import { openMomentDialog, openReminderDialog, openNoteDialog, confirmDialog } from './ui/dialogs.js';
import { renderNow } from './ui/views/now.js';
import { renderProfiles } from './ui/views/profiles.js';
import { renderMoments } from './ui/views/moments.js';
import { renderReminders } from './ui/views/reminders.js';
import { renderLiveNow, createStage } from './ui/views/live_now.js';

const mode = currentMode();
const isLive = mode === 'live';

// Persistence policy: Demo keeps its data in localStorage under its own namespace. Live V1 is
// never hydrated from a browser cache — the server snapshot is authoritative — so it gets an
// in-memory store; only the temporary session id is kept per tab (sessionStorage) by the provider.
const persistence = isLive ? createPersistence(memoryStorage(), namespaceFor('live')) : createPersistence(undefined, namespaceFor('demo'));
const store = createStore({ persistence });
let provider = null;
let unsubscribe = null;
let route = parseHash();
let bootError = null;
let tick = 0;

const main = document.getElementById('main');
const stageSlot = document.getElementById('stage');
const pageEl = document.getElementById('page');
const navEl = document.getElementById('nav');
const statusEl = document.getElementById('status');
const modeEl = document.getElementById('mode-switch');

/* ------------------------------------------------------------- live plumbing */

const liveCtx = { stage: null, capture: null, lcd: null, status: null, notices: [], devices: null, apiStatus: null, settings: null, busy: false, liveMod: null };

async function setupLive() {
  const [capMod, percMod, lcdMod, v1Mod] = await Promise.all([
    import('./live/capture.js'), import('./live/perception.js'), import('./live/lcd.js'), import('./live/v1_provider.js'),
  ]);
  liveCtx.stage = createStage();
  stageSlot.append(liveCtx.stage.root);
  liveCtx.capture = capMod.createCapture({ videoEl: liveCtx.stage.video });
  liveCtx.lcd = lcdMod.createDeviceDisplay(liveCtx.stage.canvas, {
    resolveClip: (clipId) => { const m = store.getState().moments[clipId]; return m?.status === 'saved' && m.clip?.url ? { url: m.clip.url, poster_url: m.clip.poster_url } : null; },
  });
  liveCtx.lcd.onChange((text) => { liveCtx.stage.lcdText.textContent = text; });
  liveCtx.liveMod = { capture: liveCtx.capture, streams: { faces: percMod.createFacesStream, objects: percMod.createObjectsStream, speech: percMod.createSpeechStream }, createV1Provider: v1Mod.createV1Provider };
  liveCtx.settings = loadLiveSettings();
  refreshDevices();
  fetch('/api/status', { headers: { accept: 'application/json' } }).then((r) => (r.ok ? r.json() : null)).then((s) => { liveCtx.apiStatus = s; render(); }).catch(() => { liveCtx.apiStatus = null; });
}

function loadLiveSettings() {
  try { const raw = localStorage.getItem(LIVE_SETTINGS_KEY); if (raw) return deepMerge(CONFIG.defaultLiveSettings, JSON.parse(raw)); } catch { /* fresh */ }
  return structuredClone(CONFIG.defaultLiveSettings);
}
function deepMerge(base, over) { const out = structuredClone(base); for (const [k, v] of Object.entries(over ?? {})) out[k] = v && typeof v === 'object' && !Array.isArray(v) ? { ...out[k], ...v } : v; return out; }
async function refreshDevices() {
  try { const { listDevices } = await import('./live/capture.js'); liveCtx.devices = await listDevices(); } catch { liveCtx.devices = { cameras: [], microphones: [] }; }
  render();
}

/* ------------------------------------------------------------- provider wiring */

/**
 * Provider lifecycle: create → hydrate from snapshot (if the store is empty) → bind the store to the
 * provider's session → subscribe → start the control side (live: open /ws/v1; demo: nothing yet).
 */
async function attachProvider() {
  unsubscribe?.();
  provider = createProvider({ getState: store.getState, live: liveCtx.liveMod });
  if (!store.getState().hydrated) {
    try {
      const r = store.hydrate(await provider.getSnapshot());
      if (!r.ok) throw new Error(r.reason);
      if (r.dropped?.length) console.warn('[remember] snapshot records dropped', r.dropped);
    } catch (err) { bootError = `Could not load the session: ${err.message}`; render(); return; }
  }
  store.bindSession(provider.sessionId ?? store.getState().session_id);
  unsubscribe = provider.subscribe((envelope) => {
    const r = store.apply(envelope);
    if (!r.applied && r.reason !== 'duplicate event_id') console.warn('[remember] dropped event', r.reason, envelope);
  });
  if (isLive) {
    // Every (re)connect delivers an authoritative snapshot; envelopes queued while disconnected are gone.
    provider.onSnapshot((snap) => {
      const r = store.hydrate(snap);
      if (!r.ok) { console.warn('[remember] hello snapshot rejected', r.reason); return; }
      store.bindSession(provider.sessionId);
      lastDisplayId = null;
    });
    provider.onLiveStatus((s) => { liveCtx.status = s; syncCamera(); render(); });
    provider.onNotice((n) => { liveCtx.notices = [...liveCtx.notices, n].slice(-6); if (n.level === 'error') toast(n.message); render(); });
    try { await provider.start(); } catch (err) { liveCtx.notices.push({ level: 'error', message: err.message }); }
    liveCtx.status = provider.getLiveStatus();
  }
}

function syncCamera() {
  const cap = liveCtx.status?.capture;
  const st = cap?.camera ?? 'off';
  liveCtx.stage?.setCamera(st, st === 'live' ? 'live' : st === 'error' ? 'failed' : 'off');
}

const dispatch = (type, payload) => provider.dispatch({ type, payload }).catch((err) => { console.error(err); toast(`Could not do that: ${err.message}`); throw err; });
const quiet = (p) => p.catch(() => {});

/* --------------------------------------------------------------------- actions */

const nowIso = () => new Date().toISOString();
const STORAGE_NOTE = isLive ? 'Kept in this temporary server session, not in a durable memory.' : 'Kept in this browser’s demo data.';

const actions = {
  demo: {
    runSequence: () => quiet(dispatch('demo.run_sequence', {})),
    runScenario: (key) => quiet(dispatch('demo.run_scenario', { scenario: key })),
    stop: () => provider.stop(),
    async reset() {
      if (!(await confirmDialog('Reset the demo? This clears people, notes, reminders and moments stored by this page in your browser. Nothing else on this machine is touched.', 'Reset demo'))) return;
      await provider.stop();
      store.reset();
      await attachProvider();
      try { localStorage.setItem(RESET_SIGNAL_KEY, String(Date.now())); } catch { /* ignore */ }
      toast('Demo data reset');
      navigate('now');
    },
  },
  live: {
    async start() {
      if (liveCtx.busy) return;
      liveCtx.busy = true; render();
      try { await provider.startCapture(liveCtx.settings); }
      catch (err) { if (err.message !== 'cancelled') liveCtx.notices = [...liveCtx.notices, { level: 'error', message: `Could not start: ${err.message}` }].slice(-6); }
      finally { liveCtx.busy = false; liveCtx.status = provider.getLiveStatus(); syncCamera(); render(); }
    },
    /** Stop, or cancel a Start that is still waiting for permission / the server. */
    stop() { provider.stopCapture(); liveCtx.busy = false; liveCtx.status = provider.getLiveStatus(); syncCamera(); render(); },
    markMoment: () => quiet(dispatch('moment.mark', { title: 'Marked moment' }).then(() => toast('Recording 5 s after now…'))),
    clearDisplay: () => quiet(dispatch('display.clear', {})),
    introduce: (name) => quiet(dispatch('enrollment.introduction', { name })),
    cancelEnrollment: () => quiet(dispatch('enrollment.cancel', {})),
    updateSettings(patch) { liveCtx.settings = deepMerge(liveCtx.settings, patch); try { localStorage.setItem(LIVE_SETTINGS_KEY, JSON.stringify(liveCtx.settings)); } catch { /* ignore */ } render(); },
    refreshDevices,
    async reset() {
      if (!(await confirmDialog('Reset the live session? Capture stops and this temporary session (its notes, reminders, encounters and clips) is deleted on the server. Enrolled faces in the gallery are NOT deleted.', 'Reset session'))) return;
      await provider.destroySession();
      liveCtx.lcd?.clear();
      store.reset();
      liveCtx.notices = [];
      await attachProvider();
      toast('Live session reset');
      navigate('now');
    },
    async switchMode(next) {
      if (next === mode) return;
      if (isLive) { provider?.stopCapture?.(); await provider?.stop?.(); } else await provider?.stop?.();
      setMode(next);
      location.hash = '#/now';
      location.reload();
    },
  },
  ask: (text) => quiet(dispatch('ask', { text })),
  openMoment(moment) {
    openMomentDialog(moment.id, {
      getMoment: () => store.getState().moments[moment.id] ?? null,
      subscribe: store.subscribe,
      profiles: store.getState().profiles,
      onDelete: (m) => quiet(dispatch('moment.delete', { moment_id: m.id })),
    });
  },
  reminder: {
    snoozeMinutes: CONFIG.snoozeMinutes,
    complete: (r) => quiet(dispatch('reminder.complete', { reminder_id: r.id })),
    snooze: (r) => quiet(dispatch('reminder.snooze', { reminder_id: r.id, minutes: CONFIG.snoozeMinutes })),
    dismiss: (r, encounter) => quiet(dispatch('reminder.dismiss', { reminder_id: r.id, encounter_id: encounter?.id ?? 'none' })),
    reactivate: (r) => quiet(dispatch('reminder.save', { reminder: { ...r, status: 'active', snoozed_until: undefined, completed_at: undefined, dismissed_for_encounter_id: undefined } })),
    create(defaultProfileId) {
      openReminderDialog({ profiles: Object.values(store.getState().profiles), defaultProfileId, storageNote: isLive ? STORAGE_NOTE : null, onSave: ({ profile_id, text }) => {
        quiet(dispatch('reminder.save', { reminder: { schema_version: SCHEMA_VERSION, id: newId('rem'), profile_id, text, status: 'active', created_at: nowIso(), updated_at: nowIso(), source: 'user' } }).then(() => toast('Reminder added')));
      } });
    },
    edit(r) {
      openReminderDialog({ reminder: r, profiles: Object.values(store.getState().profiles), onSave: ({ profile_id, text }) => quiet(dispatch('reminder.save', { reminder: { ...r, profile_id, text } })) });
    },
    async remove(r) { if (await confirmDialog('Delete this reminder?', 'Delete')) quiet(dispatch('reminder.delete', { reminder_id: r.id })); },
  },
  note: {
    create(profile) {
      openNoteDialog({ profileName: profile.name, storageNote: STORAGE_NOTE, onSave: (text) => quiet(dispatch('note.save', { note: { schema_version: SCHEMA_VERSION, id: newId('note'), profile_id: profile.id, text, created_at: nowIso(), updated_at: nowIso(), source: 'user' } })) });
    },
    edit(note, profile) { openNoteDialog({ note, profileName: profile.name, storageNote: STORAGE_NOTE, onSave: (text) => quiet(dispatch('note.save', { note: { ...note, text } })) }); },
    async remove(note) { if (await confirmDialog('Delete this note?', 'Delete')) quiet(dispatch('note.delete', { note_id: note.id })); },
  },
};

/* ---------------------------------------------------------------------- render */

let lastDisplayId = null;
function render() {
  const state = store.getState();
  const ctx = { state, nowMs: Date.now(), actions, scenarios: provider?.scenarios ?? [], provider, mode, live: liveCtx.status ? { ...liveCtx.status, busy: liveCtx.busy } : null, apiStatus: liveCtx.apiStatus, settings: liveCtx.settings, devices: liveCtx.devices, notices: liveCtx.notices };
  navEl.replaceChildren(...ROUTES.map((r) => h('a', { href: `#/${r.key}`, 'aria-current': route.page === r.key ? 'page' : null }, r.label)));
  statusEl.replaceChildren(statusChip(state.status ?? (isLive ? null : null)));
  modeEl.replaceChildren(isLive ? h('a', { href: '#', onClick: (e) => { e.preventDefault(); actions.live.switchMode('demo'); } }, 'Demo mode') : h('a', { href: '#', onClick: (e) => { e.preventDefault(); actions.live.switchMode('live'); } }, 'Live mode'));
  document.title = `${ROUTES.find((r) => r.key === route.page)?.label ?? 'Now'} · Remember${isLive ? '' : ' (demo)'}`;
  stageSlot.hidden = !(isLive && route.page === 'now' && liveCtx.stage);
  // Device display: render exactly what the server sent; the LCD module keeps its own video/TTL state.
  if (isLive && liveCtx.lcd && state.display && state.display.id !== lastDisplayId) { lastDisplayId = state.display.id; liveCtx.lcd.show(state.display); }
  renderPreservingFocus(pageEl, () => {
    if (bootError) return h('div.empty', h('strong', 'Something went wrong'), bootError, h('div', { style: 'margin-top:12px' }, h('button', { type: 'button', onClick: () => location.reload() }, 'Reload'), ' ', h('button.quiet', { type: 'button', onClick: () => actions.live.switchMode(isLive ? 'demo' : 'live') }, isLive ? 'Use Demo mode' : 'Use Live mode')));
    if (!state.hydrated) return h('p.muted', { 'aria-live': 'polite' }, isLive ? 'Connecting to the V1 session…' : 'Loading memory…');
    switch (route.page) {
      case 'people': return renderProfiles(ctx, 'person', route.id);
      case 'things': return renderProfiles(ctx, 'object', route.id);
      case 'moments': return renderMoments(ctx);
      case 'reminders': return renderReminders(ctx);
      default: return isLive ? renderLiveNow(ctx) : renderNow(ctx);
    }
  });
  scheduleTick(state);
}

/** While something is time-dependent on screen (recording clip, pending answer), re-render every 250 ms. */
function scheduleTick(state) {
  clearTimeout(tick);
  const live = Object.values(state.moments).some((m) => m.status === 'recording') || state.answer.pending;
  tick = setTimeout(render, live ? 250 : 30_000);
}

store.subscribe(render);
onRoute((r) => { route = r; render(); main.focus({ preventScroll: true }); });
// Cross-tab policy (demo): tabs never reload or stop each other; a reset elsewhere only offers a reload.
window.addEventListener('storage', (e) => {
  if (e.key !== RESET_SIGNAL_KEY || !e.newValue || isLive) return;
  toast('Demo data was reset in another tab. Reload this tab to pick it up.');
});
if (isLive) window.addEventListener('pagehide', () => { provider?.stopCapture?.(); });

render();
if (isLive) { try { await setupLive(); } catch (err) { bootError = `Live mode could not load: ${err.message}`; } }
if (!bootError) await attachProvider();
render();
