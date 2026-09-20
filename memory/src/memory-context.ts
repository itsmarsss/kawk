import { transcriptKey, type Embedder, type Entity, type MemoryContext, type Packet } from './contracts.js';
import { Store } from './store.js';

/** Select useful context without changing, shortening or deleting persistent evidence. */
export async function buildMemoryContext(store: Store, embedder: Embedder, packets: Packet[],
  onRetrievalFailure: () => void = () => {}): Promise<MemoryContext> {
  const state = store.currentState();
  const entities = new Map<string, Entity>();
  const add = (entity: Entity | null) => { if (entity && !store.isPersonRemoved(entity)) entities.set(entity.id, entity); };
  const continuity = (entity: Entity) => entity.kind !== 'person' || entity.personId !== null;

  for (const entity of store.recentContextEntities()) add(entity);
  if (state.packetId) for (const entity of store.packetEntities(state.packetId)) {
    if (continuity(entity)) add(entity);
  }
  for (const event of store.events()) if (event.status === 'ongoing') add(store.entity(event.entityId));
  for (const packet of packets) {
    for (const person of store.faceEntities(packet)) add(person);
    const eligible = new Set(packet.audio.segments.filter(segment => segment.isFinal).map(transcriptKey));
    for (const association of packet.audio.contexts ?? []) if (eligible.has(association.transcriptKey)) {
      for (const personId of association.personIds) add(store.entity(personId));
    }
  }

  const context: MemoryContext = { state, entities: [], related: [] };
  try {
    const queries = [...new Set(packets.flatMap(packet => [packet.vision.scene,
      ...packet.vision.observations, ...packet.audio.segments.filter(segment => segment.isFinal).map(segment => segment.text)])
      .map(text => text.trim()).filter(Boolean))];
    const vectors = queries.length ? await embedder.embed(queries) : [];
    if (vectors.length !== queries.length) throw new Error('Context embedding count mismatch');
    const related = new Map<string, MemoryContext['related'][number]>();
    for (const vector of vectors) for (const note of store.search(vector, { limit: 3 })) related.set(note.id, note);
    context.related = [...related.values()];
    for (const note of context.related) for (const id of [...note.entityIds, ...(note.candidateEntityIds ?? [])]) {
      // Preserve exact face metadata from the incoming image rather than replacing
      // it with an older stored label. Retrieval still brings every missing ID.
      if (!entities.has(id)) add(store.entity(id));
    }
  } catch { onRetrievalFailure(); }
  context.entities = [...entities.values()];
  return context;
}
