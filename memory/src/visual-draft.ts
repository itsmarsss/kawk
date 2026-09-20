import { z } from 'zod';
import { ObjectEvidenceSchema } from './object-identity.js';
import type { FaceEvidence } from './contracts.js';

/** Image-only local structure. Canonical IDs, audio and history belong to binding. */
const sourceIndex = z.number().int().min(0).max(30);
const entityIndex = z.number().int().min(0).max(29);
const faceIndex = z.number().int().min(0).max(99).nullable();
const text = (max: number) => z.string().min(1).max(max).refine(value => value.trim().length > 0);
const kind = z.enum(['person', 'object', 'place']);
const confidence = z.enum(['observed', 'uncertain']);
const anchorKind = ObjectEvidenceSchema.shape.anchors.element.shape.kind;

export const VisualDraftSchema = z.object({
  entities: z.array(z.object({
    kind, label: text(200), descriptionSourceIndex: sourceIndex, faceIndex,
  }).strict()).max(30),
  facts: z.array(z.object({
    entityIndexes: z.array(entityIndex).max(10), sourceIndex,
    text: text(2000).nullable(), attribute: text(100).nullable(),
    value: z.string().max(1000).nullable(), confidence,
  }).strict()).max(60),
  objects: z.array(z.object({
    entityIndex, sourceIndex,
    anchors: z.array(z.object({ kind: anchorKind, sourceIndex, quote: text(1000) }).strict()).max(6),
  }).strict()).max(30),
}).strict();
export type VisualDraft = z.infer<typeof VisualDraftSchema>;

/** Compact names are provider-only; stored Vision uses VisualDraft instead. */
export const VisualDraftWireSchema = z.object({
  n: z.array(z.object({ k: kind, l: text(200), v: sourceIndex, face: faceIndex }).strict()).max(30),
  f: z.array(z.object({
    r: z.array(entityIndex).max(10), v: sourceIndex, t: text(2000).nullable(),
    a: text(100).nullable(), value: z.string().max(1000).nullable(), c: confidence,
  }).strict()).max(40),
  m: z.array(z.object({
    r: entityIndex, v: sourceIndex,
    a: z.array(z.object({ k: anchorKind, v: sourceIndex, q: text(1000) }).strict()).max(6),
  }).strict()).max(30),
}).strict();
export type VisualDraftWire = z.infer<typeof VisualDraftWireSchema>;

/** Generation constraints only; the legacy decoder keeps its specific rejection codes. */
const wireFact = VisualDraftWireSchema.shape.f.element;
export const VisualDraftModelWireSchema = VisualDraftWireSchema.extend({
  f: z.array(z.union([
    wireFact.extend({ a: z.null(), value: z.null() }).strict(),
    wireFact.extend({ r: z.array(entityIndex).length(1),
      a: wireFact.shape.a.unwrap(), value: wireFact.shape.value.unwrap() }).strict(),
  ])).max(40),
}).strict();

export interface VisualDraftSources { scene: string; observations: string[] }
const nestedAnchor = z.object({ kind: anchorKind, quote: text(1000) }).strict();
const nestedEntity = z.object({
  label: text(200), description: text(1500), confidence,
  location: z.object({ value: text(1000), confidence }).strict().nullable(),
});
/** Source ownership is structural here: no provider-written entity/source indexes. */
export const NestedVisionModelSchema = z.object({
  scene: z.string().max(2000),
  entities: z.array(z.union([
    nestedEntity.extend({ kind: z.literal('person'), faceIndex,
      anchors: z.array(nestedAnchor).max(0) }).strict(),
    nestedEntity.extend({ kind: z.literal('object'), faceIndex: z.null(),
      anchors: z.array(nestedAnchor).max(6) }).strict(),
    nestedEntity.extend({ kind: z.literal('place'), faceIndex: z.null(),
      anchors: z.array(nestedAnchor).max(0) }).strict(),
  ])).max(30),
  readableText: z.array(z.string().max(1000)).max(20),
  uncertainties: z.array(z.string().max(1000)).max(10),
}).strict();
export type NestedVisionModel = z.infer<typeof NestedVisionModelSchema>;
export interface NestedVision extends VisualDraftSources {
  readableText: string[]; uncertainties: string[]; visualDraft: VisualDraft;
}
const sourcesSchema = z.object({ scene: z.string().max(2000), observations: z.array(z.string().max(2000)).max(30) });
const normalizeWhitespace = (value: string) => value.trim().replace(/\s+/gu, ' ');

export class VisualDraftError extends Error {
  constructor(readonly code: string) {
    super(`Visual draft rejected: ${code}`);
    this.name = 'VisualDraftError';
  }
}
function requireValid(value: unknown, code: string): asserts value {
  if (!value) throw new VisualDraftError(code);
}

/**
 * Revalidate persisted structure against its original image description and face packet.
 * The caller supplies the exact capture's FaceEvidence; this draft contains no identity IDs
 * with which to substitute another frame. This checks geometry, not recognition accuracy.
 * Returns a parsed copy and never rewrites source text or repairs a wrong source index.
 */
export function validateVisualDraft(domain: unknown, visionText: VisualDraftSources, faces: FaceEvidence): VisualDraft {
  const parsed = VisualDraftSchema.safeParse(domain);
  requireValid(parsed.success, 'schema_validation');
  const input = sourcesSchema.safeParse(visionText);
  requireValid(input.success, 'invalid_visual_sources');
  const sources = [input.data.scene, ...input.data.observations];
  const draft = parsed.data;
  function source(index: number): string {
    const value = sources[index];
    requireValid(value !== undefined, 'unknown_source');
    return value;
  }
  function entity(index: number): VisualDraft['entities'][number] {
    const value = draft.entities[index];
    requireValid(value !== undefined, 'unknown_entity');
    return value;
  }

  const faceSlots = new Set<number>();
  for (const declaration of draft.entities) {
    // Binding copies this source into the canonical description; never truncate it.
    requireValid(source(declaration.descriptionSourceIndex).length <= 1500, 'description_source_too_long');
    if (declaration.faceIndex === null) continue;
    requireValid(declaration.kind === 'person', 'face_owner_kind');
    requireValid(!faceSlots.has(declaration.faceIndex), 'duplicate_face_slot');
    faceSlots.add(declaration.faceIndex);
    const face = faces?.faces?.[declaration.faceIndex];
    requireValid(faces?.status === 'ready' && face, 'unknown_face_slot');
    requireValid(Number.isInteger(faces.width) && faces.width > 0 && Number.isInteger(faces.height) && faces.height > 0,
      'invalid_face_geometry');
    const box = face.box;
    requireValid(Array.isArray(box) && box.length === 4 && box.every(Number.isFinite), 'invalid_face_geometry');
    const [x1, y1, x2, y2] = box;
    requireValid(x1 >= 0 && y1 >= 0 && x2 > x1 && y2 > y1 && x2 <= faces.width && y2 <= faces.height,
      'invalid_face_geometry');
  }

  for (const fact of draft.facts) {
    fact.entityIndexes.forEach(entity);
    requireValid(new Set(fact.entityIndexes).size === fact.entityIndexes.length, 'duplicate_fact_entity');
    requireValid((fact.attribute === null) === (fact.value === null), 'attribute_pair');
    requireValid(fact.attribute === null || fact.entityIndexes.length === 1, 'attribute_owner');
    const evidence = source(fact.sourceIndex);
    // Non-null text may summarize the source. Quotes alone require exact matching.
    const copied = fact.text ?? evidence;
    requireValid(copied.length <= 2000 && copied.trim().length > 0, 'fact_source_copy_bounds');
  }

  const objectSlots = new Set<number>();
  for (const object of draft.objects) {
    requireValid(entity(object.entityIndex).kind === 'object', 'object_owner_kind');
    requireValid(!objectSlots.has(object.entityIndex), 'duplicate_object');
    objectSlots.add(object.entityIndex);
    const copied = source(object.sourceIndex);
    requireValid(copied.length <= 2000 && copied.trim().length > 0, 'object_source_copy_bounds');
    for (const anchor of object.anchors) {
      const evidence = source(anchor.sourceIndex);
      requireValid(normalizeWhitespace(evidence).includes(normalizeWhitespace(anchor.quote)), 'anchor_quote_mismatch');
    }
  }
  draft.entities.forEach((declaration, index) => {
    requireValid(declaration.kind !== 'object' || objectSlots.has(index), 'missing_object');
  });
  return draft;
}

/** Decode compact provider output without consulting history, audio or an identity model. */
export function decodeVisualDraft(raw: unknown, visionText: VisualDraftSources, faces: FaceEvidence): VisualDraft {
  const parsed = VisualDraftWireSchema.safeParse(raw);
  requireValid(parsed.success, 'wire_schema_validation');
  const wire = parsed.data;
  return validateVisualDraft({
    entities: wire.n.map(n => ({ kind: n.k, label: n.l, descriptionSourceIndex: n.v, faceIndex: n.face })),
    facts: wire.f.map(f => ({ entityIndexes: f.r, sourceIndex: f.v, text: f.t, attribute: f.a, value: f.value, confidence: f.c })),
    objects: wire.m.map(m => ({ entityIndex: m.r, sourceIndex: m.v,
      anchors: m.a.map(a => ({ kind: a.k, sourceIndex: a.v, quote: a.q })) })),
  }, visionText, faces);
}

/** Resolve only a provider's mistaken anchor index, before strict canonical validation. */
export function decodeVisualDraftModel(raw: unknown, visionText: VisualDraftSources, faces: FaceEvidence): VisualDraft {
  const parsed = VisualDraftWireSchema.safeParse(raw);
  requireValid(parsed.success, 'wire_schema_validation');
  const input = sourcesSchema.safeParse(visionText);
  requireValid(input.success, 'invalid_visual_sources');
  const sources = [input.data.scene, ...input.data.observations].map(normalizeWhitespace);
  // Zod parsed a copy. Neither raw provider output nor complete image evidence changes.
  for (const object of parsed.data.m) for (const anchor of object.a) {
    const quote = normalizeWhitespace(anchor.q);
    // A valid explicit citation wins even if another source repeats the same words.
    if (sources[anchor.v]?.includes(quote)) continue;
    const matches = sources.flatMap((source, index) => source.includes(quote) ? [index] : []);
    requireValid(matches.length === 1, 'anchor_quote_mismatch');
    anchor.v = matches[0];
  }
  // No fact/description/object owner, face slot, quote, or OCR source is repaired.
  return decodeVisualDraft(parsed.data, visionText, faces);
}

/** Expand owned descriptions without searching other entities or repairing their evidence. */
export function decodeNestedVisionModel(raw: unknown, faces: FaceEvidence): NestedVision {
  const parsed = NestedVisionModelSchema.safeParse(raw);
  requireValid(parsed.success, 'nested_schema_validation');
  const input = parsed.data;
  const vision = { scene: input.scene, observations: input.entities.map(entity => entity.description),
    readableText: input.readableText, uncertainties: input.uncertainties };
  const draft: VisualDraft = { entities: [], facts: [], objects: [] };
  input.entities.forEach((entity, index) => {
    const sourceIndex = index + 1;
    draft.entities.push({ kind: entity.kind, label: entity.label, descriptionSourceIndex: sourceIndex,
      faceIndex: entity.faceIndex });
    draft.facts.push({ entityIndexes: [index], sourceIndex, text: null, attribute: null,
      value: null, confidence: entity.confidence });
    if (entity.location) {
      // Location is descriptive model evidence, not a verbatim identity anchor.
      // Retain its exact wording/confidence and mechanically bind only this owner.
      draft.facts.push({ entityIndexes: [index], sourceIndex,
        text: `${entity.label}: ${entity.location.value}`, attribute: 'location',
        value: entity.location.value, confidence: entity.location.confidence });
    }
    if (entity.kind === 'object') draft.objects.push({ entityIndex: index, sourceIndex,
      anchors: entity.anchors.map(anchor => ({ ...anchor, sourceIndex })) });
  });
  // Strict validation tests each anchor against its owner's source, and retains
  // the existing face-slot/geometry rules. No legacy cross-source repair is used.
  return { ...vision, visualDraft: validateVisualDraft(draft, vision, faces) };
}
