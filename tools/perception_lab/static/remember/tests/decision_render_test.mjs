import { check, eq } from './harness.mjs';

// Minimal fake DOM so ui/dom.js h() can build elements in Node.
class FakeNode {}
function fakeDocument() {
  const mk = (tag) => {
    const el = Object.assign(new FakeNode(), { tagName: tag.toUpperCase(), children: [], attrs: {}, className: '', dataset: {} });
    el.classList = { add(c) { el.className = [el.className, c].filter(Boolean).join(' '); } };
    Object.assign(el, {
      append(...kids) { for (const k of kids) el.children.push(typeof k === 'object' ? k : { text: String(k) }); },
      setAttribute(k, v) { el.attrs[k] = v; }, addEventListener() {} });
    Object.defineProperty(el, 'textContent', { get() { return el.children.map((c) => (c.text !== undefined ? c.text : c.textContent)).join(''); }, set(v) { el.children = [{ text: String(v) }]; } });
    return el;
  };
  return { createElement: mk, createTextNode: (t) => Object.assign(new FakeNode(), { text: t }), createDocumentFragment: () => mk('#fragment') };
}

export async function run() {
  console.log('\n# decision status rendering');
  globalThis.document = fakeDocument();
  globalThis.Node = FakeNode;
  const { decisionItem, componentStatus, effectiveDecisions, heardCopy, renderLiveNow } = await import('../ui/views/live_now.js');
  const text = (el) => el.textContent;
  const cls = (el) => el.children[1].className;
  const rules = decisionItem(null, { backend: 'rules', configured: false, model: null, message: 'V1 command and object rules; Jev is not connected' });
  check(/Decisions.*rules.*Jev is not connected/.test(text(rules)), 'rules default from /api/status');
  const none = decisionItem(null, undefined);
  check(/rules/.test(text(none)) && /Jev is not connected/.test(text(none)), 'rules fallback without any status');
  const conf = decisionItem(null, { backend: 'typesafe', configured: true, model: 'jev-1.13.0', message: 'Environment configured' });
  check(/Jev configured · jev-1\.13\.0/.test(text(conf)) && /not verified live/.test(text(conf)), 'configured is labelled as not verified live');
  const idle = decisionItem({ backend: 'typesafe', phase: 'idle', model: 'jev-1.13.0', message: 'Jev waits for capture' }, { backend: 'typesafe', configured: true });
  check(/Jev idle · jev-1\.13\.0/.test(text(idle)) && /waits for capture/.test(text(idle)), 'runtime status wins over configured');
  const err = decisionItem({ backend: 'typesafe', phase: 'error', model: 'jev-1.13.0', message: 'Unauthorized', requires_reconfiguration: true, reason: 'HTTP 401' }, null);
  eq(cls(err), 'comp-state err', 'error styled as error');
  check(/needs reconfiguration/.test(text(err)) && /HTTP 401/.test(text(err)), 'error shows reconfiguration + reason');
  const back = decisionItem({ backend: 'typesafe', phase: 'backoff', model: 'jev-1.13.0', message: 'Rate limited', retry_after_s: 8.6 }, null);
  eq(cls(back), 'comp-state warn', 'backoff styled as warning');
  check(/Retry in 9 s/.test(text(back)), 'backoff shows retry time');
  const ready = decisionItem({ backend: 'typesafe', phase: 'ready', model: 'jev-1.13.0', message: 'Client ready' }, null);
  eq(cls(ready), 'comp-state ok', 'ready styled ok');
  check(!/verified/.test(text(ready)) || /not verified/.test(text(ready)), 'never claims live verification');

  console.log('\n# component status strip renders through the real path (regression: apiStatus binding)');
  const settings = { camera: true, microphone: true, faces: { enabled: true, backend: 'local' }, objects: { enabled: true, backend: 'local', vocabulary: ['keys'] }, speech: { enabled: false, backend: 'baseten' } };
  const live = { session: 'connected', sessionMessage: '', capture: { camera: 'live', microphone: 'live', errors: {} }, streams: { faces: { phase: 'running', message: 'Running buffalo_l' }, objects: { phase: 'connecting' }, speech: { phase: 'idle' } }, media: { frames_sent: 3, audio_chunks: 9, frames_dropped: 0 }, decision: null };
  let strip = null; let threw = null;
  try { strip = componentStatus(live, settings); } catch (e) { threw = e; }
  check(!threw, `componentStatus renders without apiStatus argument (${threw?.message ?? 'ok'})`);
  check(strip && /Decisions.*rules/.test(strip.textContent), 'strip falls back to rules when /api/status is unknown');
  strip = componentStatus(live, settings, { decisions: { backend: 'typesafe', configured: true, model: 'jev-1.13.0', message: 'Environment configured' } });
  check(/Jev configured · jev-1\.13\.0/.test(strip.textContent), 'strip shows /api/status decisions when passed');
  strip = componentStatus({ ...live, decision: { backend: 'typesafe', phase: 'deciding', model: 'jev-1.13.0', message: 'Deciding' } }, settings, null);
  check(/Jev deciding/.test(strip.textContent) && /Faces.*running/.test(strip.textContent), 'strip shows runtime decision status with the other components');
  eq(componentStatus(null, settings, null), null, 'no live status → nothing rendered');

  console.log('\n# mode-dependent Heard copy + identify phrase (real render path)');
  eq(effectiveDecisions(null, null).backend, 'rules', 'default backend is rules');
  eq(effectiveDecisions(null, { decisions: { backend: 'typesafe', configured: true } }).source, 'configured', 'configured typesafe from /api/status');
  eq(effectiveDecisions({ decision: { backend: 'rules', phase: 'rules' } }, { decisions: { backend: 'typesafe' } }).backend, 'rules', 'runtime status wins over /api/status');
  const rulesCopy = heardCopy(effectiveDecisions(null, null), true);
  check(/V1 command rules/.test(rulesCopy.header) && /match the V1 grammar act/.test(rulesCopy.empty), 'rules copy keeps the honest fixed-grammar wording');
  const confCopy = heardCopy(effectiveDecisions(null, { decisions: { backend: 'typesafe', configured: true } }), true);
  check(/waits for Jev/.test(confCopy.header) && /configured, not verified/.test(confCopy.header), 'configured typesafe says waits for Jev and not verified');
  check(!/connected/.test(confCopy.header + confCopy.empty), 'configured typesafe never claims connected');
  const errCopy = heardCopy(effectiveDecisions({ decision: { backend: 'typesafe', phase: 'error' } }, null), true);
  check(/no actions/.test(errCopy.empty) && /no rules fallback/.test(errCopy.empty), 'typesafe error says no actions and no fallback');
  const offCopy = heardCopy(effectiveDecisions(null, null), false);
  check(/off/.test(offCopy.header), 'speech off copy unchanged');
  // full live Now render, both modes, through renderLiveNow (guards the apiStatus binding regression too)
  const state = { profiles: {}, notes: {}, encounters: {}, reminders: {}, moments: {}, transcript: [], answer: { pending: null, latest: null }, recognition: null, enrollment: null, display: null, active_encounter_id: null, applied_event_ids: [], diagnostics: { duplicates: 0, stale: 0, rejected: [], log: [] }, status: null, scene: { kind: 'idle', caption: '' } };
  const actions = { reminder: {}, live: { switchMode() {}, start() {}, stop() {}, markMoment() {}, clearDisplay() {}, introduce() {}, cancelEnrollment() {}, updateSettings() {}, refreshDevices() {}, reset() {} }, ask() {}, openMoment() {} };
  const base = { state, nowMs: Date.now(), actions, settings, devices: { cameras: [], microphones: [] }, notices: [] };
  const liveOn = { ...live, capturing: false };
  const onSettings = { ...settings, speech: { enabled: true, backend: 'baseten' } };
  let page = null; let renderErr = null;
  try { page = renderLiveNow({ ...base, settings: onSettings, live: liveOn, apiStatus: null }); } catch (e) { renderErr = e; }
  check(!renderErr, `renderLiveNow renders in rules mode without apiStatus (${renderErr?.message ?? 'ok'})`);
  check(/V1 command rules/.test(page.textContent) && /who is this\?/.test(page.textContent), 'rules render shows rules header and the identify phrase in the Ask helper');
  check(/agent harness and durable memory are deferred/.test(page.textContent) && !/No agent or memory service is connected/.test(page.textContent), 'helper no longer says no agent connection exists');
  page = renderLiveNow({ ...base, settings: onSettings, live: { ...liveOn, decision: { backend: 'typesafe', phase: 'idle', model: 'jev-1.13.0', message: 'Jev waits for capture' } }, apiStatus: { decisions: { backend: 'typesafe', configured: true, model: 'jev-1.13.0', message: 'x' } } });
  check(/finalized speech waits for Jev/.test(page.textContent) && /Jev idle · jev-1\.13\.0/.test(page.textContent), 'typesafe render: Heard header waits for Jev and status strip shows runtime status');
  check(!/V1 command rules/.test(page.textContent), 'typesafe render does not claim rules act on speech');
  check(/who is this\?/.test(page.textContent), 'identify phrase present in typesafe mode too');
  page = renderLiveNow({ ...base, settings: onSettings, live: { ...liveOn, decision: { backend: 'typesafe', phase: 'error', model: 'jev-1.13.0', message: 'Unauthorized' } }, apiStatus: null });
  check(/no rules fallback/.test(page.textContent) && /Unauthorized/.test(page.textContent), 'typesafe error render: no fallback stated, error shown');
  delete globalThis.document; delete globalThis.Node;
}
