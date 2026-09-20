import type { Express } from 'express';
import { z } from 'zod';
import type { MemoryPipeline } from './pipeline.js';

const gallerySchema = z.object({ people: z.array(z.object({ id: z.string().min(1), name: z.string() })) });

/** One reset surface for the recognition gallery and this service's active people.
 * Source evidence remains available in packets; this is not an erase-media API.
 */
export function peopleRoutes(app: Express, pipeline: MemoryPipeline, upstream: URL): void {
  async function galleryRequest(path = '/api/gallery', method = 'GET') {
    const response = await fetch(new URL(path, upstream), { method, signal: AbortSignal.timeout(8000) });
    if (!response.ok && !(method === 'DELETE' && response.status === 404))
      throw new Error(`People service unavailable (HTTP ${response.status}); nothing was reset in memory`);
    return response;
  }
  async function people() {
    const gallery = gallerySchema.parse(await (await galleryRequest()).json()).people;
    const enrolled = new Map(gallery.map(p => [p.id, p]));
    const rows = new Map(pipeline.store.entities().filter(e => e.kind === 'person').map(e => [e.id,
      { id: e.id, name: enrolled.get(e.personId ?? e.id)?.name ?? e.label,
        enrolled: enrolled.has(e.personId ?? e.id), lastSeenAt: e.lastSeenAt as number | null }]));
    for (const p of gallery) if (!rows.has(p.id))
      rows.set(p.id, { id: p.id, name: p.name, enrolled: true, lastSeenAt: null });
    return [...rows.values()].sort((a, b) => Number(b.enrolled)-Number(a.enrolled) || (b.lastSeenAt ?? 0)-(a.lastSeenAt ?? 0));
  }
  app.get('/api/people', async (_req, res) => {
    res.json({ people: await people(), resetBefore: pipeline.store.peopleResetBefore() });
  });
  app.delete('/api/people/:id', async (req, res) => {
    const id = req.params.id;
    if (id.length > 160) { res.status(400).json({ error: 'Invalid person ID' }); return; }
    const known = pipeline.store.entity(id);
    if (known && known.kind !== 'person') { res.status(400).json({ error: 'Only people can be reset' }); return; }
    if (!known && !(await people()).some(p => p.id === id)) { res.status(404).json({ error: 'Unknown person' }); return; }
    // Perception owns embeddings and invalidates in-flight naming even when this
    // provisional memory person has no gallery entry (404 is safe on retry).
    await galleryRequest(`/api/gallery/${encodeURIComponent(known?.personId ?? id)}`, 'DELETE');
    pipeline.removePeople([id]);
    res.json({ deleted: true });
  });
  app.delete('/api/people', async (_req, res) => {
    const current = await people();
    await galleryRequest('/api/gallery', 'DELETE');
    pipeline.removePeople(current.map(p => p.id), true);
    res.json({ deleted: true, count: current.length });
  });
}
