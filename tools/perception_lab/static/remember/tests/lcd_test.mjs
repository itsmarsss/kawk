import { check, eq, fakeClock } from './harness.mjs';
import { layoutCard, createDeviceDisplay, PADDING, TTL_BAR_H } from '../live/lcd.js';

const T0 = '2026-09-19T14:00:00.000Z';
const ms = (iso) => Date.parse(iso);
const iso = (t) => new Date(t).toISOString();

/** Backend-shaped DisplayAction (mirrors product.py `_action`). */
function action(template, title, body, { ttl_ms = 8000, reminder = null, clip_id, issued = T0, priority } = {}) {
  const card = { template, title, body, image_ref: null, reminder };
  if (clip_id) card.clip_id = clip_id;
  const PRIORITY = { idle: 0, profile: 10, enroll_prompt: 20, alert: 20, answer: 30 };
  return {
    schema_version: '1.0', id: `display_${template}`, display: { w: 240, h: 240 }, card, blit: null, ttl_ms,
    priority: priority ?? PRIORITY[template], issued_at: issued, expires_at: ttl_ms ? iso(ms(issued) + ttl_ms) : null,
  };
}

/** Canvas stand-in: records draw calls; measureText mirrors the default 0.55 em approximation. */
function fakeCanvas() {
  const calls = { fillRect: 0, fillText: [], drawImage: 0 };
  const ctx = {
    font: '', fillStyle: '', strokeStyle: '', textBaseline: '', textAlign: '', lineWidth: 1,
    fillRect() { calls.fillRect++; },
    fillText(t) { calls.fillText.push(t); },
    drawImage() { calls.drawImage++; },
    measureText(t) { const size = parseFloat(/(\d+(?:\.\d+)?)px/.exec(this.font)?.[1] ?? '14'); return { width: 0.55 * size * String(t).length }; },
    save() {}, restore() {}, scale() {}, setTransform() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {}, fill() {}, clip() {}, roundRect() {},
  };
  const attrs = {};
  const canvas = { width: 0, height: 0, style: {}, getContext: () => ctx, setAttribute(k, v) { attrs[k] = v; }, removeAttribute(k) { delete attrs[k]; }, getAttribute: (k) => attrs[k] };
  return { canvas, ctx, calls, attrs };
}

function fakeVideo() {
  const v = {
    readyState: 2, videoWidth: 320, videoHeight: 240, ended: false, paused: false, played: 0, loads: 0, attrs: {},
    src: '', muted: false, playsInline: false, loop: true,
    play() { this.played++; this.paused = false; return Promise.resolve(); },
    pause() { this.paused = true; },
    load() { this.loads++; },
    setAttribute(k, v) { this.attrs[k] = v; },
    removeAttribute(k) { if (k === 'src') delete this.src; else delete this.attrs[k]; },
  };
  return v;
}

const titleLine = (L) => L.lines.find((l) => l.role === 'title');
const bodyLines = (L) => L.lines.filter((l) => l.role === 'body');
const fits = (L) => [...(L.reminder?.lines ?? []), ...L.lines].every((l) => l.y + l.size <= L.height - PADDING - (L.ttl ? TTL_BAR_H : 0));

export async function run() {
  console.log('\n# lcd layout: profile + reminder');
  {
    const a = action('profile', 'Alex Chen', 'Last met: yesterday, at the lab.\nWorks on firmware.', { reminder: { id: 'r1', text: 'Ask Alex about the ESP32 board he promised to bring' } });
    const L = layoutCard(a, { nowMs: ms(T0) });
    eq(L.template, 'profile', 'template passes through');
    check(L.reminder && L.reminder.lines.length >= 1 && L.reminder.lines.length <= 2, 'reminder strip has 1–2 lines'); // (1)
    check(L.regions.some((r) => r.kind === 'reminder_strip' && r.fill === '#e9f2ee') && L.regions.some((r) => r.kind === 'reminder_bar' && r.fill === '#1f6f5b'), 'strip uses accent-soft fill and an accent bar');
    const t = titleLine(L);
    check(L.reminder.lines[0].y < t.y, `reminder strip sits above the title (${L.reminder.lines[0].y} < ${t.y})`);
    check(t.y >= L.reminder.height, 'title starts below the strip');
    eq([t.size, t.weight], [22, 700], 'title is 22 px bold');
    eq(bodyLines(L)[0].size, 14, 'body is 14 px');
    check(L.describe.indexOf('Reminder:') !== -1 && L.describe.indexOf('Reminder:') < L.describe.indexOf('Alex Chen'), `describe mentions the reminder before the name: "${L.describe}"`);
    check(fits(L), 'everything fits inside the padded area');
    check(!L.describe.includes('\n'), 'describe is one line');
  }
  {
    const L = layoutCard(action('profile', 'Alex Chen', 'Last met: yesterday.'), { nowMs: ms(T0) }); // (2)
    eq(L.reminder, null, 'no reminder → reminder is null');
    check(!L.regions.some((r) => r.kind.startsWith('reminder')), 'no reminder → no strip regions');
    eq(titleLine(L).y, PADDING, 'title starts at the top padding');
    eq(L.describe, 'Profile: Alex Chen. Last met: yesterday.', 'describe for a plain profile');
  }

  console.log('\n# lcd layout: long body wraps and truncates');
  {
    const words = Array.from({ length: 120 }, (_, i) => `word${i}`).join(' ');
    const L = layoutCard(action('profile', 'Someone With A Rather Long Name Indeed That Wraps', words), { nowMs: ms(T0) }); // (3)
    check(fits(L), 'no line extends past height − padding − ttl bar');
    check(bodyLines(L).length >= 3, `body wrapped to multiple lines (${bodyLines(L).length})`);
    check(bodyLines(L).at(-1).text.endsWith('…'), 'truncated body ends with an ellipsis');
    check(L.lines.filter((l) => l.role === 'title').length <= 2, 'title capped at 2 lines');
    check(L.lines.every((l) => l.x >= PADDING), 'all lines respect the left padding');
    const bodyWidth = Math.max(...bodyLines(L).map((l) => l.text.length * 14 * 0.55));
    check(bodyWidth <= 240 - 2 * PADDING, 'wrapped body lines fit the inner width');
  }
  {
    const L = layoutCard(action('answer', 'q', 'Supercalifragilisticexpialidocious-antidisestablishmentarianism'), { nowMs: ms(T0) });
    check(bodyLines(L).length >= 2 && bodyLines(L).every((l) => l.text.length * 18 * 0.55 <= 240 - 2 * PADDING), 'over-long words are hard-broken to fit');
  }

  console.log('\n# lcd layout: answer + clip region');
  {
    const a = action('answer', 'where are my keys', 'On the desk, next to the laptop.\n6 min ago.', { clip_id: 'm1' });
    const L = layoutCard(a, { nowMs: ms(T0), resolveClip: (id) => (id === 'm1' ? { url: '/static/remember/fixtures/keys-moment.mp4' } : null) }); // (4)
    eq(L.clipRegion, { x: 0, y: 120, w: 240, h: 120 }, 'clip region reserved at the bottom half');
    check(L.lines.length > 0 && L.lines.every((l) => l.y + l.size <= 120), 'text kept above y=120');
    eq(titleLine(L).size, 13, 'answer title (the question) is 13 px');
    eq(titleLine(L).color, '#6f6b63', 'answer title is muted');
    eq([bodyLines(L)[0].size, bodyLines(L)[0].weight], [18, 600], 'answer body is 18 px semibold');
    check(L.describe.startsWith('Answer: On the desk'), `describe leads with the answer: "${L.describe}"`);
    const noClip = layoutCard(a, { nowMs: ms(T0) });
    eq(noClip.clipRegion, null, 'clip_id without an available clip → no region');
    const unresolved = layoutCard(a, { nowMs: ms(T0), resolveClip: () => ({ url: null }) });
    eq(unresolved.clipRegion, null, 'resolveClip without a url → no region');
    check(noClip.contentBottom > L.contentBottom, 'without a clip the text may use the full height');
  }

  console.log('\n# lcd layout: idle, borders, ttl');
  {
    const L = layoutCard(action('idle', '14:03', 'Ready', { ttl_ms: 0 }), { nowMs: ms(T0) }); // (5)
    const t = titleLine(L);
    eq([t.size, t.weight, t.align, t.x], [48, 700, 'center', 120], 'idle clock is 48 px bold centered');
    check(t.y > 40 && t.y + 48 < 200, `idle clock vertically centered (y=${t.y})`);
    const b = bodyLines(L)[0];
    eq([b.size, b.color, b.align], [13, '#6f6b63', 'center'], 'idle body is 13 px muted centered');
    check(b.y > t.y + 48, 'idle body sits below the clock');
    eq(L.ttl, null, 'ttl_ms 0 → no ttl');
    check(!L.regions.some((r) => r.kind.startsWith('ttl_')), 'no ttl bar without expiry');
    eq(L.describe, 'Idle: 14:03, Ready', 'idle describe');
  }
  {
    const e = layoutCard(action('enroll_prompt', 'Who is this?', 'Say just their name'), { nowMs: ms(T0) });
    const border = e.regions.find((r) => r.kind === 'border');
    eq([border?.stroke, border?.lineWidth, border?.x], ['#1f6f5b', 2, 2], 'enroll_prompt has a 2 px accent border inset');
    eq([titleLine(e).size, titleLine(e).weight], [20, 700], 'enroll_prompt title 20 px bold');
    const al = layoutCard(action('alert', 'Low battery', 'Charge soon'), { nowMs: ms(T0) });
    eq(al.regions.find((r) => r.kind === 'border')?.stroke, '#8a6410', 'alert border is warn colored');
    check(al.describe.startsWith('Alert: Low battery'), 'alert describe');
  }
  {
    const a = action('answer', 'q', 'a', { ttl_ms: 8000 }); // issued T0, expires T0+8 s   (6)
    const mid = layoutCard(a, { nowMs: ms(T0) + 2000 });
    check(Math.abs(mid.ttl.fraction - 0.75) < 1e-9 && mid.ttl.expired === false, `ttl fraction 0.75 at +2 s (got ${mid.ttl.fraction})`);
    const bar = mid.regions.find((r) => r.kind === 'ttl_bar');
    eq([bar.y, bar.h, bar.w], [238, 2, 180], '2 px ttl bar at the very bottom, width ∝ remaining');
    const start = layoutCard(a, { nowMs: ms(T0) });
    eq(start.ttl.fraction, 1, 'fraction 1 at issue time');
    const late = layoutCard(a, { nowMs: ms(T0) + 9000 });
    eq([late.ttl.fraction, late.ttl.expired], [0, true], 'fraction clamps to 0 and expired flips after expires_at');
    check(fits(mid), 'text stays clear of the ttl bar');
  }

  console.log('\n# lcd runtime: replaces unconditionally (no priority here)');
  {
    const { canvas } = fakeCanvas();
    const clock = fakeClock(ms(T0));
    const d = createDeviceDisplay(canvas, { clock, now: clock.now });
    d.show(action('answer', 'where are my keys', 'On the desk.'));
    eq(d.current().card.template, 'answer', 'answer shown');
    d.show(action('idle', '14:00', 'Ready', { ttl_ms: 0 })); // lower priority, later → still replaces   (7)
    eq(d.current().card.template, 'idle', 'a later lower-priority action replaces the display');
    eq(d.describe(), 'Idle: 14:00, Ready', 'describe reflects the latest action');
    eq(canvas.getAttribute('role'), 'img', 'canvas role=img');
    eq(canvas.getAttribute('aria-label'), 'Idle: 14:00, Ready', 'aria-label mirrors describe');
    eq([canvas.width, canvas.height, canvas.style.width], [240, 240, '240px'], 'canvas sized for dpr 1 with 240 px CSS size');
    d.destroy();
  }

  console.log('\n# lcd runtime: TTL fallback to a local idle clock');
  {
    const { canvas } = fakeCanvas();
    const clock = fakeClock(ms(T0));
    const d = createDeviceDisplay(canvas, { clock, now: clock.now });
    const texts = [];
    d.onChange((t) => texts.push(t));
    d.show(action('answer', 'where are my keys', 'On the desk.', { ttl_ms: 3000 })); // (8)
    eq(texts.length, 1, 'onChange fired for the answer');
    clock.advance(2900);
    eq(d.current().card.template, 'answer', 'still the answer before expiry');
    clock.advance(200);
    eq(d.current().card.template, 'idle', 'expired with no newer action → local idle');
    check(d.current().local === true && d.current().expires_at === null, 'fallback idle is marked local and has no expiry');
    const expected = `Idle: ${String(new Date(clock.now()).getHours()).padStart(2, '0')}:${String(new Date(clock.now()).getMinutes()).padStart(2, '0')}, Ready`;
    eq(texts.at(-1), expected, 'onChange fired with the idle text from now()');
    eq(texts.length, 2, 'onChange did not fire for repaints with unchanged text');
    // idle clock ticks on the minute
    clock.advance(60_000);
    check(/^Idle: \d\d:\d\d, Ready$/.test(texts.at(-1)) && texts.at(-1) !== expected, 'local idle clock advanced a minute via the internal ticker');
    d.destroy();
  }
  {
    const { canvas } = fakeCanvas();
    const clock = fakeClock(ms(T0));
    const d = createDeviceDisplay(canvas, { clock, now: clock.now });
    d.show(action('answer', 'a', 'first', { ttl_ms: 3000 })); // (9)
    const pendingAfterFirst = clock.pending();
    check(pendingAfterFirst >= 1, `ttl timer pending (${pendingAfterFirst})`);
    clock.advance(1000);
    d.show(action('profile', 'Maya', 'second', { ttl_ms: 5000, issued: iso(clock.now()) }));
    eq(clock.pending(), pendingAfterFirst, 'newer show() cancels the previous TTL timer instead of stacking');
    clock.advance(2500); // past the first action's expiry
    eq(d.current().card.title, 'Maya', 'first action\'s expiry does not clobber the newer action');
    clock.advance(3000);
    eq(d.current().card.template, 'idle', 'second action expires on its own schedule');
    d.destroy();
  }

  console.log('\n# lcd runtime: clip playback');
  {
    const { canvas, calls } = fakeCanvas();
    const clock = fakeClock(ms(T0));
    const videos = [];
    const d = createDeviceDisplay(canvas, {
      clock, now: clock.now,
      resolveClip: (id) => (id === 'm1' ? { url: '/static/remember/fixtures/keys-moment.mp4' } : null),
      createVideo: () => { const v = fakeVideo(); videos.push(v); return v; },
    });
    d.show(action('answer', 'where are my keys', 'On the desk.', { clip_id: 'm1' })); // (10)
    eq(videos.length, 1, 'one video created');
    const v = videos[0];
    check(v.muted === true && v.playsInline === true && v.loop === false && v.played === 1, 'video is muted, playsInline, loop=false and play() was called');
    eq(v.src, '/static/remember/fixtures/keys-moment.mp4', 'video src set from resolveClip');
    check(calls.drawImage >= 1, 'first paint draws the ready video');
    clock.advance(1000);
    check(calls.drawImage <= 11 && calls.drawImage >= 10, `≤ 11 drawImage calls after 1 s (got ${calls.drawImage})`);
    check(/Clip attached/.test(d.describe()), 'describe mentions the clip');
    const before = calls.drawImage;
    d.show(action('idle', '14:00', 'Ready', { ttl_ms: 0 }));
    check(v.paused === true && !('src' in v) && v.loads === 1, 'previous video paused, src removed, load() called');
    clock.advance(1000);
    eq(calls.drawImage, before, 'no further drawImage after the clip was released');
    eq(videos.length, 1, 'idle does not create a video');
    d.destroy();
  }
  {
    const { canvas, calls } = fakeCanvas();
    const clock = fakeClock(ms(T0));
    const d = createDeviceDisplay(canvas, { clock, now: clock.now, resolveClip: () => null, createVideo: () => { throw new Error('must not be called'); } });
    d.show(action('answer', 'q', 'a', { clip_id: 'm-missing' }));
    eq(calls.drawImage, 0, 'unresolvable clip → no video, no drawImage');
    eq(d.current().card.clip_id, 'm-missing', 'action still shown as a text card');
    d.destroy();
  }

  console.log('\n# lcd runtime: destroy');
  {
    const { canvas } = fakeCanvas();
    const clock = fakeClock(ms(T0));
    const videos = [];
    const d = createDeviceDisplay(canvas, { clock, now: clock.now, resolveClip: () => ({ url: '/x.mp4' }), createVideo: () => { const v = fakeVideo(); videos.push(v); return v; } });
    d.show(action('answer', 'q', 'a', { clip_id: 'm1' }));
    check(clock.pending() >= 2, 'ttl + clip timers pending while playing');
    d.destroy(); // (11)
    eq(clock.pending(), 0, 'destroy() leaves no pending timers');
    check(videos[0].paused && !('src' in videos[0]), 'destroy() releases the video');
    eq(d.current(), null, 'current() is null after destroy');
    d.show(action('idle', '14:00', 'Ready', { ttl_ms: 0 }));
    eq(clock.pending(), 0, 'show() after destroy is a no-op');
    clock.advance(5000);
    eq(clock.pending(), 0, 'nothing rescheduled after destroy');
  }
  {
    const { canvas } = fakeCanvas();
    const clock = fakeClock(ms(T0));
    const d = createDeviceDisplay(canvas, { clock, now: clock.now });
    d.clear();
    eq(d.current().card.template, 'idle', 'clear() shows an idle clock');
    eq(clock.pending(), 1, 'idle clock keeps a single 1 s ticker');
    d.destroy();
    eq(clock.pending(), 0, 'ticker cleared on destroy');
  }
}
