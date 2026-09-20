import type { MemoryContext } from './contracts.js';
import type { VisualDraft } from './visual-draft.js';

/** Share text only. Separate occurrences retain their own evidence and identity status. */
export function bindingRelatedContext(context: MemoryContext, aliases: Map<string, string>) {
  const occurrences = context.related.filter(note => !note.superseded).map((note, rank) => ({
    text: note.text, occurrence: { rank,
      entities: note.entityIds.map(id => aliases.get(id)).filter((id): id is string => id !== undefined),
      candidateEntities: (note.candidateEntityIds ?? []).map(id => aliases.get(id)).filter((id): id is string => id !== undefined),
      observedAt: note.observedAt, endAt: note.endAt, confidence: note.confidence, visual: note.visual,
    },
  }));
  const grouped = new Map<string, { text: string; occurrences: typeof occurrences[number]['occurrence'][] }>();
  for (const row of occurrences) {
    let group = grouped.get(row.text);
    if (!group) { group = { text: row.text, occurrences: [] }; grouped.set(row.text, group); }
    group.occurrences.push(row.occurrence);
  }
  return [...grouped.values()];
}

/** Prompt-only field aliases; no row, source, face slot, quote or confidence is dropped. */
export function bindingDraftContext(draft: VisualDraft) {
  return {
    n: draft.entities.map(entity => ({ k: entity.kind, l: entity.label,
      v: entity.descriptionSourceIndex, face: entity.faceIndex })),
    f: draft.facts.map(fact => ({ r: fact.entityIndexes, v: fact.sourceIndex, t: fact.text,
      a: fact.attribute, value: fact.value, c: fact.confidence })),
    m: draft.objects.map(object => ({ r: object.entityIndex, v: object.sourceIndex,
      a: object.anchors.map(anchor => ({ k: anchor.kind, v: anchor.sourceIndex, q: anchor.quote })) })),
  };
}
