import { test } from 'node:test';
import assert from 'node:assert/strict';
import { contentRect, mapBox, fitDimensions } from '../src/overlay.ts';

test('face boxes in 640-derivative space map onto the letterboxed video without mirroring', () => {
  // 1280x720 camera shown in a 400x300 element → content 400x225 at y=37.5
  const rect = contentRect(1280, 720, 400, 300);
  assert.deepEqual(rect, { x: 0, y: 37.5, w: 400, h: 225 });
  const r = mapBox([64, 36, 128, 108], 640, 360, rect); // derivative is 640x360
  assert.deepEqual(r, { x: 40, y: 37.5 + 22.5, w: 40, h: 45 });
  // pillarbox: portrait video in a wide element
  const rect2 = contentRect(720, 1280, 400, 300);
  assert.equal(rect2.h, 300); assert.equal(rect2.x, (400 - 300 * 720 / 1280) / 2);
  const left = mapBox([0, 0, 10, 10], 360, 640, rect2);
  assert.equal(left.x, rect2.x, 'a box at the left edge of the image lands at the left edge of the content, i.e. not mirrored');
});

test('derivative dimensions preserve aspect ratio within the server tolerance and never upscale', () => {
  assert.deepEqual(fitDimensions(1920, 1080, 1280), { width: 1280, height: 720 });
  assert.deepEqual(fitDimensions(1280, 720, 640), { width: 640, height: 360 });
  assert.deepEqual(fitDimensions(640, 480, 1280), { width: 640, height: 480 });
  const full = fitDimensions(1277, 719, 1280), face = fitDimensions(full.width, full.height, 640);
  assert.ok(Math.abs(full.width / full.height - face.width / face.height) <= 0.02);
});
