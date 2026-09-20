import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sortPeople, countPeople, deleteButtonLabel, confirmDeleteButtonLabel } from '../src/people.ts';
import type { Person } from '../src/api.ts';

const p = (id: string, over: Partial<Person> = {}): Person => ({ id, name: '', enrolled: false, lastSeenAt: null, ...over });

test('enrolled people sort first even when never seen; provisional follow by recency; never-seen last within a group', () => {
  const list = [
    p('prov-old', { lastSeenAt: 1_000 }),
    p('enrolled-never-seen', { name: 'Maya', enrolled: true, lastSeenAt: null }),
    p('prov-new', { lastSeenAt: 5_000 }),
    p('enrolled-seen', { name: 'Sam', enrolled: true, lastSeenAt: 2_000 }),
    p('prov-never-seen', { lastSeenAt: null }),
  ];
  assert.deepEqual(sortPeople(list).map((x) => x.id), ['enrolled-seen', 'enrolled-never-seen', 'prov-new', 'prov-old', 'prov-never-seen']);
});

test('sortPeople keeps every row and does not mutate the input', () => {
  const list = Array.from({ length: 256 }, (_, i) => p(`id-${i}`, { lastSeenAt: i % 7 === 0 ? null : i, enrolled: i % 50 === 0 }));
  const before = list.map((x) => x.id);
  const sorted = sortPeople(list);
  assert.equal(sorted.length, 256, 'all returned rows are kept; nothing truncated');
  assert.deepEqual(list.map((x) => x.id), before);
  assert.deepEqual(countPeople(list), { total: 256, enrolled: 6, provisional: 250 });
});

test('ties break deterministically on name then id', () => {
  const sorted = sortPeople([p('b', { name: 'Zed', lastSeenAt: 9 }), p('a', { name: 'Amy', lastSeenAt: 9 }), p('c', { name: 'Amy', lastSeenAt: 9 })]);
  assert.deepEqual(sorted.map((x) => x.id), ['a', 'c', 'b']);
});

test('delete labels are person-specific and distinguish same-named people by id suffix', () => {
  const a = p('person-000000aaaaaaaa', { name: 'Maya', enrolled: true });
  const b = p('person-000000bbbbbbbb', { name: 'Maya' });
  assert.equal(deleteButtonLabel(a), 'Delete Maya (enrolled, id aaaaaaaa)');
  assert.equal(deleteButtonLabel(b), 'Delete Maya (provisional, id bbbbbbbb)');
  assert.notEqual(deleteButtonLabel(a), deleteButtonLabel(b));
  assert.equal(deleteButtonLabel(p('x1')), 'Delete unnamed person (provisional, id x1)');
  assert.equal(confirmDeleteButtonLabel(a), 'Confirm delete Maya (enrolled, id aaaaaaaa)');
});
