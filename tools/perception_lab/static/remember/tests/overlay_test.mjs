import { check, eq, fakeClock } from './harness.mjs';
import { mapBox, faceLabel, createFaceOverlay, placeLabel, fitLabel, visibleRect } from '../live/overlay.js';

function fakeCanvas(w = 640, h = 360) {
  const calls = [];
  const ctx = { setTransform() {}, clearRect(...a) { calls.push(['clear', ...a]); }, scale() {}, strokeRect(...a) { calls.push(['box', ...a]); }, fillRect(...a) { calls.push(['tag', ...a]); }, fillText(t, x, y) { calls.push(['label', t, x, y]); }, measureText(t) { return { width: t.length * 7 }; } };
  const canvas = { width: 0, height: 0, clientWidth: w, clientHeight: h, getContext: () => ctx, calls };
  return canvas;
}
const boxes = (c) => c.calls.filter((x) => x[0] === 'box');
const labels = (c) => c.calls.filter((x) => x[0] === 'label').map((x) => x[1]);
const tags = (c) => c.calls.filter((x) => x[0] === 'tag').map((x) => ({ x: x[1], y: x[2], w: x[3], h: x[4] }));
const inside = (t, view) => t.x >= 0 && t.y >= 0 && t.x + t.w <= view.w && t.y + t.h <= view.h;
const ovClock = (base) => ({ nowMs: () => base.now(), setTimeout: base.setTimeout, clearTimeout: base.clearTimeout });

export function run() {
  console.log('\n# overlay: coordinate mapping');
  const same = mapBox([64, 36, 128, 72], [640, 360], { w: 640, h: 360 });
  eq(same, { x: 64, y: 36, w: 64, h: 36 }, 'identity when sizes match');
  const half = mapBox([64, 36, 128, 72], [640, 360], { w: 320, h: 180 });
  eq(half, { x: 32, y: 18, w: 32, h: 18 }, 'scales with the preview');
  // cover: 16:9 source shown in a 1:1 box → scale by height, crop sides (negative x offset)
  const cover = mapBox([0, 0, 640, 360], [640, 360], { w: 360, h: 360 }, { fit: 'cover' });
  eq(cover, { x: -140, y: 0, w: 640, h: 360 }, 'cover crops horizontally with a centred negative offset');
  const contain = mapBox([0, 0, 640, 360], [640, 360], { w: 360, h: 360 }, { fit: 'contain' });
  eq(contain, { x: 0, y: 78.75, w: 360, h: 202.5 }, 'contain letterboxes vertically');
  const mirrored = mapBox([0, 0, 100, 50], [640, 360], { w: 640, h: 360 }, { mirrored: true });
  eq(mirrored, { x: 540, y: 0, w: 100, h: 50 }, 'mirroring flips x around the preview width');
  eq(mapBox([0, 0, 1, 1], [0, 0], { w: 1, h: 1 }), null, 'bad input size → null');
  eq(mapBox([0, 0, 1, 1], [10, 10], { w: 0, h: 0 }), null, 'zero-size preview → null');
  eq(mapBox('nope', [10, 10], { w: 1, h: 1 }), null, 'malformed box → null');

  console.log('\n# overlay: labels never promote the raw match');
  eq(faceLabel({ stable_name: 'Alex Chen', match: { name: 'Someone Else' } }), 'Alex Chen', 'stable name wins');
  eq(faceLabel({ stable_name: null, match: { id: 'x', name: 'Candidate', similarity: 0.61 } }), 'Unknown', 'raw match candidate is never shown as identity');
  eq(faceLabel({ stable_name: '  ' }), 'Unknown', 'blank stable name → Unknown');
  eq(faceLabel(null), 'Unknown', 'missing face → Unknown');

  console.log('\n# overlay: lifecycle');
  {
    const clock = fakeClock();
    const canvas = fakeCanvas();
    let resize = null;
    const ov = createFaceOverlay(canvas, { measure: () => ({ w: canvas.clientWidth, h: canvas.clientHeight }), clock: ovClock(clock), dpr: () => 1, observeResize: (fn) => { resize = fn; return () => { resize = null; }; } });
    ov.show({ input_wh: [640, 360], faces: [
      { track_id: 1, box: [10, 10, 60, 60], stable_name: 'Alex Chen', match: { name: 'Alex Chen' } },
      { track_id: 2, box: [200, 40, 260, 110], stable_name: null, match: { name: 'Maybe Maya', similarity: 0.5 } },
    ] });
    eq(boxes(canvas).length, 2, 'two faces → two boxes drawn independently');
    eq(labels(canvas), ['Alex Chen', 'Unknown'], 'labels: stable name and Unknown, never the candidate');
    eq(canvas.width, 640, 'canvas sized to the preview');
    canvas.calls.length = 0;
    ov.show({ input_wh: [640, 360], faces: [] });
    eq(boxes(canvas).length, 0, 'empty detections clear the overlay');
    eq(ov.current, null, 'nothing held after an empty frame');
    ov.show({ input_wh: [640, 360], faces: [{ track_id: 3, box: [0, 0, 50, 50], stable_name: null }] });
    canvas.calls.length = 0;
    clock.advance(1400);
    eq(ov.current !== null, true, 'held while fresh');
    clock.advance(200);
    eq(ov.current, null, 'stale reply cleared after the hold window with no newer frame');
    check(canvas.calls.some((x) => x[0] === 'clear') && boxes(canvas).length === 0, 'stale clear repainted with no boxes');
    ov.show({ input_wh: [640, 360], faces: [{ track_id: 4, box: [0, 0, 50, 50], stable_name: 'Bob' }] });
    canvas.calls.length = 0;
    canvas.clientWidth = 320; canvas.clientHeight = 180; resize();
    eq(boxes(canvas)[0].slice(1, 5), [0, 0, 25, 25], 'resize re-maps the held frame to the new preview size');
    ov.clear();
    eq(ov.current, null, 'clear() drops the frame');
    eq(clock.pending(), 0, 'clear() cancels the hold timer');
    ov.show({ input_wh: [640, 360], faces: [{ track_id: 5, box: [0, 0, 50, 50], stable_name: null }] });
    ov.destroy();
    eq(clock.pending(), 0, 'destroy cancels timers');
    canvas.calls.length = 0;
    ov.show({ input_wh: [640, 360], faces: [{ track_id: 6, box: [0, 0, 50, 50], stable_name: 'Late' }] });
    eq(boxes(canvas).length, 0, 'late show after destroy draws nothing');
    check(resize === null, 'resize observer disconnected on destroy');
    const missing = createFaceOverlay(fakeCanvas(), { clock: ovClock(clock), dpr: () => 1 });
    missing.show({ faces: [{ box: [0, 0, 1, 1] }] });
    eq(missing.current, null, 'frame without input_wh draws nothing (cannot map)');
  }

  console.log('\n# overlay: label placement stays inside the preview');
  {
    const view = { w: 640, h: 360 };
    const measure = (t) => t.length * 7;
    // review example: 640x480 sent frame shown 640x360 (cover) → box maps to y=-60, h=480
    const big = mapBox([0, 0, 640, 480], [640, 480], view);
    eq(big, { x: 0, y: -60, w: 640, h: 480 }, 'close-up box maps above and below the viewport');
    const tag = placeLabel(big, measure('Alex Chen') + 10, view);
    check(tag && inside(tag, view), `label for a box spanning the viewport is pinned inside (y=${tag?.y})`);
    // right edge / long name
    const right = { x: 600, y: 100, w: 30, h: 30 };
    const longTag = placeLabel(right, 300, view);
    check(inside(longTag, view), 'wide label near the right edge is shifted left to stay visible');
    eq(placeLabel(right, 2000, view).w, view.w, 'label never wider than the preview');
    check(fitLabel('A very long recognised name indeed', 100, measure).endsWith('…') && measure(fitLabel('A very long recognised name indeed', 100, measure)) <= 100, 'long label truncated with an ellipsis to fit');
    eq(fitLabel('Bob', 100, measure), 'Bob', 'short label untouched');
    // above / below preference
    eq(placeLabel({ x: 10, y: 100, w: 50, h: 50 }, 60, view).y, 80, 'label above the box when there is room');
    eq(placeLabel({ x: 10, y: 5, w: 50, h: 50 }, 60, view).y, 57, 'label below the box when the top is too close to the edge');
    // fully off-screen
    eq(visibleRect({ x: -200, y: 0, w: 100, h: 100 }, view), null, 'box left of the preview is not visible');
    eq(placeLabel({ x: 700, y: 0, w: 50, h: 50 }, 60, view), null, 'no label for a fully off-screen box');
    const canvas = fakeCanvas(640, 360);
    const clock = fakeClock();
    const ov = createFaceOverlay(canvas, { measure: () => ({ w: 640, h: 360 }), clock: ovClock(clock), dpr: () => 1 });
    ov.show({ input_wh: [640, 480], faces: [
      { track_id: 1, box: [0, 0, 640, 480], stable_name: 'Alex Chen' },          // spans the viewport
      { track_id: 2, box: [620, 100, 640, 130], stable_name: 'Maximiliana Featherstonehaugh-Bartholomew of the Very Long Name Institute for Extended Identifiers' }, // right edge, wider than the preview
      { track_id: 3, box: [-300, 0, -100, 100], stable_name: 'Ghost' },          // fully off-screen (cover keeps x scale 1 here)
    ] }, { captureTsMs: clock.now() });
    eq(boxes(canvas).length, 2, 'fully off-screen box skipped, the others drawn');
    check(tags(canvas).every((t) => inside(t, { w: 640, h: 360 })), 'every drawn label sits inside the 640×360 preview');
    check(!labels(canvas).includes('Ghost'), 'no label for the off-screen face');
    check(labels(canvas).some((l) => l.endsWith('…')), 'long name truncated');
  }

  console.log('\n# overlay: freshness is measured from capture time');
  {
    const base = fakeClock();
    const canvas = fakeCanvas();
    const ov = createFaceOverlay(canvas, { measure: () => ({ w: 640, h: 360 }), clock: ovClock(base), dpr: () => 1, holdMs: 1500 });
    const frame = (id) => ({ input_wh: [640, 360], faces: [{ track_id: id, box: [0, 0, 50, 50], stable_name: null }] });
    ov.show(frame(1), { captureTsMs: base.now() - 2000, receivedAtMs: base.now() });
    eq(ov.current, null, 'a reply whose capture is already 2 s old is rejected on arrival');
    ov.show(frame(2), { captureTsMs: base.now() - 1000, receivedAtMs: base.now() });
    check(ov.current !== null, 'a 1 s-old observation is shown');
    base.advance(400);
    check(ov.current !== null, 'still shown at 1.4 s of age');
    base.advance(200);
    eq(ov.current, null, 'expires at 1.5 s after CAPTURE, not 1.5 s after receipt');
    const t0 = base.now();
    ov.show(frame(3), { captureTsMs: t0 });
    ov.show(frame(4), { captureTsMs: t0 - 800 });
    eq(ov.current.faces[0].track_id, 3, 'an older-capture reply arriving late does not replace the newer one');
    base.advance(1400);
    check(ov.current !== null, 'newer frame keeps its own full lifetime');
    ov.show(frame(5));
    check(ov.current.faces[0].track_id === 5, 'a frame without capture metadata is treated as captured now');
    ov.clear();
    eq(base.pending(), 0, 'no timers left');
  }
}
