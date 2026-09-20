// Keyed list reconciliation: existing nodes are kept (so an open <details> with loaded evidence
// survives a dashboard poll), their summary is updated in place, new nodes are created, removed
// keys are detached, and order follows the new item order. Node-shape is minimal for testability.
export interface NodeLikeList<N> { readonly children: ArrayLike<N>; appendChild(n: N): unknown; insertBefore(n: N, ref: N | null): unknown; removeChild(n: N): unknown }

export function reconcileKeyed<T, N>(container: NodeLikeList<N>, items: T[], keyOf: (t: T) => string, nodes: Map<string, N>,
  create: (t: T) => N, update: (node: N, t: T) => void): { created: number; updated: number; removed: number } {
  const seen = new Set<string>();
  let created = 0, updated = 0, removed = 0;
  for (const t of items) { const k = keyOf(t); if (seen.has(k)) continue; seen.add(k); }
  for (const [k, n] of [...nodes]) if (!seen.has(k)) { nodes.delete(k); try { container.removeChild(n); } catch { /* already detached */ } removed += 1; }
  let index = 0;
  const done = new Set<string>();
  for (const t of items) {
    const k = keyOf(t);
    if (done.has(k)) continue; done.add(k);
    let n = nodes.get(k);
    if (n) { update(n, t); updated += 1; } else { n = create(t); nodes.set(k, n); created += 1; }
    const at = container.children[index] ?? null;
    if (at !== n) container.insertBefore(n, at);
    index += 1;
  }
  return { created, updated, removed };
}
