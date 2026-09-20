import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BrowseController, DEFAULT_FILTER, browseUrl, describeBrowse, describeStatus, filterFromForm, isSuperseded, itemFacts, kindsFor, mergeItems, parseBrowsePage, type BrowseItem, type BrowseState } from '../src/memoryBrowse.ts';

const item = (kind: BrowseItem['kind'], id: string, at: number, extra: Partial<BrowseItem> = {}): BrowseItem => ({ id, kind, at, title: `${kind} ${id}`, text: '', status: null, captureId: null, entityId: null, data: {}, ...extra });
const page = (kind: BrowseItem['kind'], items: BrowseItem[], nextCursor: string | null = null, total: number | null = items.length) => ({ kind, items, nextCursor, total });

test('filterFromForm: category normalised, literal query trimmed, local dates parsed, inverted range swapped, entityKind only for entities', () => {
  const f = filterFromForm({ category: 'entities', query: '  blue bowl ', from: '2026-09-20T10:00', to: '2026-09-20T08:00', history: true, entityKind: 'person' });
  assert.equal(f.category, 'entities'); assert.equal(f.query, 'blue bowl'); assert.equal(f.history, true); assert.equal(f.entityKind, 'person');
  assert.equal(f.from, Date.parse('2026-09-20T08:00')); assert.equal(f.to, Date.parse('2026-09-20T10:00'));
  const g = filterFromForm({ category: 'bogus', query: '', from: 'garbage', to: '', history: false, entityKind: 'person', limit: '999' });
  assert.deepEqual(g, { ...DEFAULT_FILTER, category: 'all', limit: 40 });
  assert.equal(filterFromForm({ category: 'observations', query: '', from: '', to: '', history: false, entityKind: 'person' }).entityKind, null);
});

test('browseUrl routes memory kinds and agent kinds to their endpoints with the contract parameters only', () => {
  const f = { ...DEFAULT_FILTER, category: 'observations' as const, query: 'keys', from: 1000, to: 2000, history: true };
  const u = new URL(browseUrl('observations', f, 'c1'), 'http://x');
  assert.equal(u.pathname, '/api/memory/browse');
  assert.deepEqual(Object.fromEntries(u.searchParams), { kind: 'observations', limit: '40', history: 'true', query: 'keys', from: '1000', to: '2000', cursor: 'c1' });
  const a = new URL(browseUrl('facts', DEFAULT_FILTER), 'http://x');
  assert.equal(a.pathname, '/api/agent/memory/browse');
  assert.deepEqual(Object.fromEntries(a.searchParams), { kind: 'facts', limit: '40', history: 'false' });
  const e = new URL(browseUrl('entities', { ...DEFAULT_FILTER, entityKind: 'place' }), 'http://x');
  assert.equal(e.searchParams.get('entityKind'), 'place');
  assert.equal(new URL(browseUrl('captures', { ...DEFAULT_FILTER, entityKind: 'place' }), 'http://x').searchParams.get('entityKind'), null);
  assert.deepEqual(kindsFor('all'), ['observations', 'captures', 'transcripts', 'entities', 'state', 'facts', 'reminders']);
});

test('parseBrowsePage drops unreadable items and counts them; page shape errors throw', () => {
  const { page: p, dropped } = parseBrowsePage({ kind: 'transcripts', items: [{ id: 't1', kind: 'transcripts', at: 5, title: 'x', text: 'hello', status: 'final', captureId: null, entityId: null, data: { revision: 2 } }, { id: 'no-at' }, null, 'junk', { id: 7, at: 3 }], nextCursor: '', total: 12.7 }, 'transcripts');
  assert.equal(p.items.length, 2); assert.equal(dropped, 3);
  assert.equal(p.items[0]!.data.revision, 2); assert.equal(p.items[1]!.id, '7'); assert.equal(p.items[1]!.kind, 'transcripts');
  assert.equal(p.nextCursor, null); assert.equal(p.total, 12);
  assert.throws(() => parseBrowsePage([], 'facts'), /not an object/);
  assert.throws(() => parseBrowsePage({ items: 'x' }, 'facts'), /no items array/);
});

test('mergeItems: newest first across kinds, duplicates by kind+id collapse', () => {
  const merged = mergeItems([[item('observations', 'a', 10), item('observations', 'b', 30)], [item('facts', 'a', 20), item('observations', 'a', 10)]]);
  assert.deepEqual(merged.map((i) => `${i.kind}:${i.id}@${i.at}`), ['observations:b@30', 'facts:a@20', 'observations:a@10']);
});

test('status honesty: server status shown as-is; superseded / candidate / partial flags surfaced from data', () => {
  assert.deepEqual(describeStatus(item('observations', 'o', 1, { status: 'committed' })), { label: 'committed', tone: 'ok' });
  assert.deepEqual(describeStatus(item('observations', 'o', 1, { data: { superseded: true } })), { label: 'superseded', tone: 'muted' });
  assert.equal(describeStatus(item('observations', 'o', 1, { data: { candidateEntityIds: ['e2'] } })).label, 'possible match — identity unconfirmed');
  assert.deepEqual(describeStatus(item('transcripts', 't', 1, { data: { isFinal: false } })), { label: 'partial', tone: 'warn' });
  assert.equal(describeStatus(item('captures', 'c', 1, { status: 'failed' })).tone, 'bad');
  assert.equal(isSuperseded(item('state', 's', 1, { status: 'superseded' })), true);
  assert.equal(isSuperseded(item('state', 's', 1, { status: 'current' })), false);
});

test('itemFacts: readable labels, timestamps typed, sources listed, blobs summarised and bounded', () => {
  const facts = itemFacts(item('facts', 'f', 1, { data: { key: 'person:kenny', kind: 'entity', refs: ['x', 'y'], observedAt: 1_758_000_000_000, sources: [{ eventId: 'evt-1', revision: 2, text: 'tell Kenny about vitamin B', sourceStart: 1_758_000_000_000, sourceEnd: 1_758_000_004_000 }], nested: { a: 1, b: { c: 2 } }, big: Array.from({ length: 3 }, (_, i) => ({ i })), empty: [], nothing: null, id: 'ignored' } }));
  const byLabel = Object.fromEntries(facts.map((f) => [f.label, f]));
  assert.match(byLabel['sources (1)']!.list![0]!, /^event evt-1 r2 · \d\d:\d\d:\d\d–\d\d:\d\d:\d\d UTC: “tell Kenny about vitamin B”$/);
  assert.equal(byLabel['key']!.text, 'person:kenny');
  assert.deepEqual(byLabel['refs']!.list, ['x', 'y']);
  assert.equal(byLabel['observed']!.time, 1_758_000_000_000);
  assert.match(byLabel['nested']!.text!, /a = 1 · \(\+1 more, see raw data\)/);
  assert.equal(byLabel['big']!.text, '3 item(s) — see raw data');
  assert.equal('empty' in byLabel, false); assert.equal('nothing' in byLabel, false); assert.equal('id' in byLabel, false);
  const longText = itemFacts(item('state', 's', 1, { data: { summary: 'x'.repeat(900) } }))[0]!.text!;
  assert.match(longText, /^x{600}… \(truncated: 900 characters; full value in raw data\)$/);
  const many = itemFacts(item('state', 's', 1, { data: Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`k${i}`, i])) }), 10);
  assert.equal(many.length, 10);
});

function harness() {
  const pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>();
  const urls: string[] = [];
  const states: BrowseState[] = [];
  const ctl = new BrowseController({
    fetchPage: (url) => { urls.push(url); return new Promise((resolve, reject) => pending.set(url, { resolve, reject })); },
    onState: (s) => states.push(s), now: () => 1000,
  });
  const settle = () => new Promise((r) => setTimeout(r, 0));
  const kindOf = (url: string) => new URL(url, 'http://x').searchParams.get('kind')!;
  const resolveKind = async (kind: string, body: unknown, nth = 0) => { const u = urls.filter((x) => kindOf(x) === kind)[nth]!; pending.get(u)!.resolve(body); pending.delete(u); await settle(); };
  const rejectKind = async (kind: string, err: Error, nth = 0) => { const u = urls.filter((x) => kindOf(x) === kind)[nth]!; pending.get(u)!.reject(err); pending.delete(u); await settle(); };
  return { ctl, urls, states, pending, settle, resolveKind, rejectKind, kindOf, last: () => states.at(-1)! };
}

test('all: fans out to 7 kinds in parallel; merged newest-first; per-kind totals and cursors; Load more only extends kinds with a cursor', async () => {
  const h = harness();
  void h.ctl.load(DEFAULT_FILTER);
  await h.settle();
  assert.deepEqual(h.urls.map(h.kindOf), ['observations', 'captures', 'transcripts', 'entities', 'state', 'facts', 'reminders']);
  assert.equal(h.last().loading, true);
  await h.resolveKind('observations', page('observations', [item('observations', 'o1', 300), item('observations', 'o2', 100)], 'obs-c2', 5));
  assert.equal(h.last().loading, true); assert.equal(h.last().loaded, 2);
  for (const k of ['captures', 'transcripts', 'entities', 'state', 'reminders'] as const) await h.resolveKind(k, page(k, []));
  await h.resolveKind('facts', page('facts', [item('facts', 'f1', 200)], null, 1));
  const s = h.last();
  assert.equal(s.loading, false); assert.equal(s.hasMore, true); assert.equal(s.total, 6); assert.equal(s.finishedAt, 1000);
  assert.deepEqual(s.items.map((i) => i.id), ['o1', 'f1', 'o2']);
  assert.match(describeBrowse(s, 4000), /^3 shown of 6 · more available · observation 2\/5\+, photo 0\/0, .*refreshed 3 s ago$/);
  void h.ctl.loadMore(); await h.settle();
  const more = h.urls.slice(7);
  assert.equal(more.length, 1); assert.equal(h.kindOf(more[0]!), 'observations'); assert.equal(new URL(more[0]!, 'http://x').searchParams.get('cursor'), 'obs-c2');
  await h.resolveKind('observations', page('observations', [item('observations', 'o3', 50), item('observations', 'o1', 300)], null, 5), 1);
  assert.deepEqual(h.last().items.map((i) => i.id), ['o1', 'f1', 'o2', 'o3']); // duplicate o1 collapsed
  assert.equal(h.last().hasMore, false);
  assert.match(describeBrowse(h.last(), 1000), /end of results/);
});

test('stale async: a page for an older generation is dropped, never merged into the newer list', async () => {
  const h = harness();
  void h.ctl.load({ ...DEFAULT_FILTER, category: 'observations', query: 'keys' }); await h.settle();
  void h.ctl.load({ ...DEFAULT_FILTER, category: 'observations', query: 'bowl' }); await h.settle();
  assert.equal(h.urls.length, 2);
  await h.resolveKind('observations', page('observations', [item('observations', 'keys-1', 1)]), 0); // old request answers late
  assert.equal(h.last().loaded, 0); assert.equal(h.last().stale, 1); assert.equal(h.last().filter.query, 'bowl');
  await h.resolveKind('observations', page('observations', [item('observations', 'bowl-1', 2)]), 1);
  assert.deepEqual(h.last().items.map((i) => i.id), ['bowl-1']);
  assert.equal(h.last().loading, false);
  // a late FAILURE of an older generation is also ignored
  void h.ctl.load({ ...DEFAULT_FILTER, category: 'observations', query: 'cup' }); await h.settle();
  void h.ctl.load({ ...DEFAULT_FILTER, category: 'observations', query: 'mug' }); await h.settle();
  await h.rejectKind('observations', new Error('HTTP 500'), 2);
  assert.equal(h.last().errors.length, 0); assert.equal(h.last().stale, 2);
});

test('errors are per kind and retryable; other kinds keep their results; a bad page shape is an error too', async () => {
  const h = harness();
  void h.ctl.load(DEFAULT_FILTER); await h.settle();
  await h.rejectKind('facts', new Error('GET /api/agent/memory/browse → HTTP 503'));
  for (const k of ['observations', 'captures', 'transcripts', 'entities', 'state'] as const) await h.resolveKind(k, page(k, k === 'observations' ? [item('observations', 'o1', 1)] : []));
  await h.resolveKind('reminders', { nope: true });
  const s = h.last();
  assert.equal(s.loading, false); assert.equal(s.loaded, 1);
  assert.deepEqual(s.errors.map((e) => e.kind), ['facts', 'reminders']);
  assert.match(describeBrowse(s, 1000), /2 category error\(s\): facts: GET .*HTTP 503; reminders: browse response has no items array/);
  assert.equal(s.total, null); // unknown while a kind failed
  void h.ctl.retry(); await h.settle();
  const retried = h.urls.slice(7).map(h.kindOf).sort();
  assert.deepEqual(retried, ['facts', 'reminders']);
  await h.resolveKind('facts', page('facts', [item('facts', 'f1', 9)]), 1);
  await h.resolveKind('reminders', page('reminders', []), 1);
  assert.equal(h.last().errors.length, 0); assert.equal(h.last().loaded, 2); assert.equal(h.last().total, 2);
});

test('empty result set is stated plainly', async () => {
  const h = harness();
  void h.ctl.load({ ...DEFAULT_FILTER, category: 'reminders', history: true, from: 5 }); await h.settle();
  await h.resolveKind('reminders', page('reminders', [], null, 0));
  assert.match(describeBrowse(h.last(), 1000), /^nothing matches this filter · date range on · history on/);
});
