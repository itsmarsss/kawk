import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hashForView, presentation, viewFromHash } from '../src/views.ts';

test('view from hash: known views selected, anything else falls back to live', () => {
  assert.equal(viewFromHash('#memory'), 'memory');
  assert.equal(viewFromHash('debug'), 'debug');
  assert.equal(viewFromHash(''), 'live');
  assert.equal(viewFromHash('#notification=n1'), 'live');
  assert.equal(viewFromHash('#Memory'), 'live');
  assert.equal(hashForView('memory'), '#memory');
});

test('presentation: the selected view is shown, Live is kept off-stage (never display:none), others hidden', () => {
  assert.equal(presentation('memory', 'memory'), 'shown');
  assert.equal(presentation('memory', 'live'), 'offstage');
  assert.equal(presentation('memory', 'debug'), 'hidden');
  assert.equal(presentation('live', 'live'), 'shown');
  assert.equal(presentation('debug', 'memory'), 'hidden');
});
