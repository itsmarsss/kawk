import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSearchBody, normalizeSearchMode, scoreLabel, searchResultNote } from '../src/searchMode.ts';

test('keyword is the default mode; semantic only when selected explicitly', () => {
  assert.equal(normalizeSearchMode(undefined), 'keyword');
  assert.equal(normalizeSearchMode('anything'), 'keyword');
  assert.equal(normalizeSearchMode('semantic'), 'semantic');
  assert.deepEqual(buildSearchBody({ query: ' keys ', mode: '', entityId: '', from: '', to: '', limit: '10' }), { query: 'keys', mode: 'keyword', limit: 10 });
  assert.deepEqual(buildSearchBody({ query: 'keys', mode: 'semantic', entityId: 'e1', from: '2026-09-20T10:00', to: 'garbage', limit: '999' }),
    { query: 'keys', mode: 'semantic', entityId: 'e1', from: Date.parse('2026-09-20T10:00'), limit: 50 });
  assert.equal(buildSearchBody({ query: '   ', mode: 'semantic', entityId: '', from: '', to: '', limit: '' }), null);
});

test('result notes and per-row score labels name the mode honestly', () => {
  assert.match(searchResultNote('keyword', 3, 12.4), /^3 result\(s\) in 12 ms · keyword mode/);
  assert.match(searchResultNote('semantic', 0, 8), /semantic mode · distance shown/);
  assert.equal(scoreLabel('semantic', 0.1234), 'distance 0.123');
  assert.equal(scoreLabel('keyword', 0.1234), 'keyword match');
  assert.equal(scoreLabel('semantic', undefined), 'keyword match');
});
