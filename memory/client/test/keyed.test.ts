import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reconcileKeyed } from '../src/keyed.ts';

interface FakeNode { key: string; open: boolean; loaded: string | null; summary: string }
class FakeContainer {
  children: FakeNode[] = [];
  appendChild(n: FakeNode) { this.removeChild(n); this.children.push(n); }
  insertBefore(n: FakeNode, ref: FakeNode | null) { this.removeChild(n); const i = ref ? this.children.indexOf(ref) : -1; if (i < 0) this.children.push(n); else this.children.splice(i, 0, n); }
  removeChild(n: FakeNode) { const i = this.children.indexOf(n); if (i >= 0) this.children.splice(i, 1); }
}
type Item = { id: string; status: string };

test('an open, loaded detail node survives repeated polls; statuses update in place; order and removals apply', () => {
  const c = new FakeContainer(); const nodes = new Map<string, FakeNode>();
  const render = (items: Item[]) => reconcileKeyed(c, items, (i) => i.id, nodes,
    (i) => ({ key: i.id, open: false, loaded: null, summary: i.status }), (n, i) => { n.summary = i.status; });
  render([{ id: 'a', status: 'queued' }, { id: 'b', status: 'queued' }]);
  const a = nodes.get('a')!;
  a.open = true; a.loaded = 'packet v1 evidence'; // user expanded and the detail fetch landed
  const r = render([{ id: 'c', status: 'queued' }, { id: 'a', status: 'committed' }, { id: 'b', status: 'observing' }]);
  assert.deepEqual(r, { created: 1, updated: 2, removed: 0 });
  assert.equal(nodes.get('a'), a, 'same node instance kept');
  assert.equal(a.open, true); assert.equal(a.loaded, 'packet v1 evidence'); assert.equal(a.summary, 'committed');
  assert.deepEqual(c.children.map((n) => n.key), ['c', 'a', 'b']);
  const r2 = render([{ id: 'a', status: 'committed' }]);
  assert.deepEqual(r2, { created: 0, updated: 1, removed: 2 });
  assert.deepEqual(c.children.map((n) => n.key), ['a']);
  assert.equal(c.children[0], a);
  render([{ id: 'a', status: 'committed' }, { id: 'a', status: 'dup' }]);
  assert.equal(c.children.length, 1, 'duplicate keys collapse to one node');
});
