import { expect, test } from 'bun:test';
import { Store } from '../src/store';
import { browseAgentMemory } from '../src/memory-browser';
import { Harness } from '../src/harness';
import { serve } from '../src/server';
import { KnowledgeGraph } from '../src/knowledge';
import { call, event, gate, model } from './helpers';

test('agent memory browser pages all facts, excludes other owners and invalid evidence', () => {
  const s = new Store(':memory:', () => 1000);
  try {
    s.ingest('one', event('e', 'blue notes'), false); s.ingest('two', event('e', 'private other'), false);
    for (let i = 0; i < 110; i++) s.remember('one', `key-${i}`, `fact ${i}`, 'fact', [{ eventId: 'e', revision: 0 }]);
    s.remember('two', 'secret', 'private other', 'fact', [{ eventId: 'e', revision: 0 }]);
    const first = browseAgentMemory(s, 'one', { limit: '17' }); const ids = first.items.map(i => i.id);
    s.remember('one', 'new', 'new after browsing', 'fact', [{ eventId: 'e', revision: 0 }]);
    let cursor = first.nextCursor;
    while (cursor) { const page = browseAgentMemory(s, 'one', { limit: '17', cursor });
      expect(page.total).toBe(110); ids.push(...page.items.map(i => i.id)); cursor = page.nextCursor; }
    expect(ids.length).toBe(110); expect(new Set(ids).size).toBe(110);
    expect(() => browseAgentMemory(s, 'two', { cursor: first.nextCursor! })).toThrow('filters changed');
    expect(first.items[0]!.data.sources[0]!.text).toBe('blue notes');
    s.ingest('one', event('e', 'corrected source', { revision: 1 }), false);
    expect(browseAgentMemory(s, 'one', { history: 'true' }).total).toBe(0);
    expect(browseAgentMemory(s, 'two', {}).total).toBe(1);
  } finally { s.close(); }
});

test('fact revisions, literal filters and all reminder states remain inspectable until evidence deletion', () => {
  let now = 1000; const s = new Store(':memory:', () => now);
  try {
    s.ingest('one', event('e', 'source'), false);
    const refs = [{ eventId: 'e', revision: 0 }];
    s.remember('one', 'key', '100% blue_old', 'fact', refs); now = 2000;
    s.remember('one', 'key', '100% blue_new', 'fact', refs);
    expect(browseAgentMemory(s, 'one', {}).total).toBe(1);
    expect(browseAgentMemory(s, 'one', { history: 'true', from: '900', to: '1500', query: '% blue_' }).items[0]!.status).toBe('superseded');
    for (const state of ['pending', 'completed', 'cancelled'])
      s.run('INSERT INTO reminders(id,owner,task_id,text,due_at,refs,created_at,expires_at,state) VALUES(?,?,?,?,?,?,?,?,?)',
        state, 'one', 'task', state, 3000, JSON.stringify(refs), now, 4000, state);
    expect(browseAgentMemory(s, 'one', { kind: 'reminders' }).total).toBe(3);
    s.deleteEvidence('one', 'e');
    expect(browseAgentMemory(s, 'one', { history: 'true' }).total).toBe(0);
    expect(browseAgentMemory(s, 'one', { kind: 'reminders' }).total).toBe(0);
  } finally { s.close(); }
});

test('agent browse endpoint requires authentication and does not enqueue work', async () => {
  const s = new Store(':memory:');
  const h = new Harness({ store: s, gate, model: model(() => call('finish', { text: '', refs: [], confidence: 1, notify: false })) });
  const token = 't'.repeat(48), server = serve(h, { token, owner: 'owner', port: 0 });
  try {
    const url = server.url + '/v1/memory/browse';
    expect((await fetch(url)).status).toBe(401);
    const headers = { Authorization: `Bearer ${token}` };
    const response = await fetch(url, { headers }); expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ kind: 'facts', total: 0, items: [], nextCursor: null });
    for (const query of ['limit=101', 'from=3&to=1', 'cursor=bad', 'owner=other'])
      expect((await fetch(url + '?' + query, { headers })).status).toBe(400);
    expect(s.all('SELECT * FROM gate_jobs')).toHaveLength(0); expect(s.tasks('owner')).toHaveLength(0);
  } finally { await server.stop(); await h.stop(); s.close(); }
});

test('graph cards resolve readable labels while preserving exact structured claims and sources', () => {
  const s = new Store(':memory:'); const graph = new KnowledgeGraph(s);
  try {
    s.ingest('owner', event('e', 'Tell Kenny about Vitamin B'), false);
    const refs = [{ eventId: 'e', revision: 0 }];
    const kenny = graph.entity('owner', { key: 'kenny', kind: 'person', label: 'Kenny', refs });
    graph.relation('owner', { key: 'vitamin', subjectId: kenny.id, predicate: 'discuss', value: 'Vitamin B',
      validFrom: Date.now(), certainty: 'reported', refs });
    const page = browseAgentMemory(s, 'owner', {});
    expect(page.items.some(i => i.text === 'Kenny · discuss · Vitamin B')).toBe(true);
    expect(page.items.some(i => i.text === 'person · Kenny')).toBe(true);
    const claim = page.items.find(i => i.title === 'Relation · discuss')!;
    expect(claim.data.structured).toMatchObject({ subjectId: kenny.id, value: 'Vitamin B' });
    expect(claim.data.sources[0]!.text).toBe('Tell Kenny about Vitamin B');
  } finally { s.close(); }
});
