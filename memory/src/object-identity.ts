import { z } from 'zod';

const id = z.string().min(1).max(160);
const sourceIndex = z.number().int().min(0).max(30);
const quote = (maximum: number) => z.string().min(1).max(maximum).refine(value => value.trim().length > 0);
const anchorKind = z.enum(['attached_item', 'distinctive_marking', 'distinctive_configuration', 'damage', 'generic']);
const currentAnchorSchema = z.object({ kind: anchorKind, sourceIndex, quote: quote(1000) }).strict();
const anchorReferenceSchema = z.union([
  z.object({ id }).strict(),
  z.object({ packetId: id, ref: id, index: z.number().int().min(0).max(5) }).strict(),
]);
export const ObjectEvidenceSchema = z.object({
  ref: id, sourceIndex, quote: quote(2000), anchors: z.array(currentAnchorSchema).max(6),
  match: z.object({
    assessment: z.enum(['same_instance', 'possible']),
    anchors: z.array(z.object({ anchor: anchorReferenceSchema, sourceIndex, quote: quote(1000) }).strict()).max(6),
    conflictingDetails: z.array(z.string().min(1).max(1000)).max(6),
    competingEntityIds: z.array(id).max(10),
  }).strict().nullable(),
}).strict();
export type ObjectEvidence = z.infer<typeof ObjectEvidenceSchema>;
export interface ObjectAnchor {
  id: string; entityId: string; packetId: string; packetVersion: number;
  ref: string; index: number; sourceIndex: number; kind: ObjectEvidence['anchors'][number]['kind'];
  quote: string; observedAt: number; active: boolean;
}
const storedAnchorSchema = z.object({
  id, entityId: id, packetId: id, packetVersion: z.number().int().positive(),
  ref: id, index: z.number().int().min(0).max(5), sourceIndex, kind: anchorKind,
  quote: quote(1000), observedAt: z.number().finite().nonnegative(), active: z.boolean(),
}).strict();
const packetSchema = z.object({
  id, capturedAt: z.number().finite().nonnegative(),
  vision: z.object({ scene: z.string().max(2000), observations: z.array(z.string().max(2000)).max(30) }),
});
const candidateSightingSchema = z.object({
  packet: packetSchema, packetVersion: z.number().int().positive(), ref: id,
  candidateEntityIds: z.array(id).min(1), evidence: ObjectEvidenceSchema,
}).strict();
/** Unresolved source evidence; it is never an owned canonical object anchor. */
export type CandidateObjectSighting = z.infer<typeof candidateSightingSchema>;
export class ObjectIdentityError extends Error {
  constructor(readonly code: string) {
    super(`Object identity evidence rejected: ${code}`);
    this.name = 'ObjectIdentityError';
  }
}
function requireValid(value: unknown, code: string): asserts value {
  if (!value) throw new ObjectIdentityError(code);
}
const normalize = (value: string) => value.trim().replace(/\s+/gu, ' ');
const signature = (anchor: ObjectAnchor) => JSON.stringify([anchor.kind, normalize(anchor.quote).toLocaleLowerCase('en-US')]);

/** Mechanical evidence gate, not visual verification or a semantic feature matcher. */
export function evaluateObjectIdentity(input: {
  packet: { id: string; capturedAt: number; vision: { scene: string; observations: string[] } };
  candidateId: string | null; evidence?: ObjectEvidence; anchors: ObjectAnchor[];
  candidateSightings?: CandidateObjectSighting[];
}): {
  status: 'new' | 'supported' | 'candidate'; reason: string;
  matchedAnchorIds: string[]; newAnchors: ObjectEvidence['anchors'];
  resolvedEvidence: ObjectEvidence | null;
} {
  const parsedPacket = packetSchema.safeParse(input.packet);
  const parsedCandidate = id.nullable().safeParse(input.candidateId);
  const parsedAnchors = z.array(storedAnchorSchema).safeParse(input.anchors);
  const parsedSightings = z.array(candidateSightingSchema).safeParse(input.candidateSightings ?? []);
  requireValid(parsedPacket.success && parsedCandidate.success && parsedAnchors.success && parsedSightings.success, 'invalid_input');
  const packet = parsedPacket.data, candidateId = parsedCandidate.data, anchors = parsedAnchors.data;
  requireValid(new Set(anchors.map(anchor => anchor.id)).size === anchors.length, 'duplicate_anchor_id');
  if (input.evidence === undefined) return {
    status: candidateId === null ? 'new' : 'candidate', reason: candidateId === null ? 'new_object' : 'missing_evidence',
    matchedAnchorIds: [], newAnchors: [], resolvedEvidence: null,
  };
  const parsedEvidence = ObjectEvidenceSchema.safeParse(input.evidence);
  requireValid(parsedEvidence.success, 'invalid_evidence');
  const evidence = parsedEvidence.data;
  const sources = [packet.vision.scene, ...packet.vision.observations];
  function resolveCurrent(index: number, text: string): number {
    const exact = normalize(text);
    // A valid explicit citation wins even if another source repeats its words.
    // On an index error, repair only a unique exact quote in this same frame.
    // Never case-fold, search OCR, alter text or choose among ambiguous matches.
    if (sources[index] !== undefined && normalize(sources[index]).includes(exact)) return index;
    const matches = sources.flatMap((source, current) => normalize(source).includes(exact) ? [current] : []);
    requireValid(matches.length > 0, sources[index] === undefined ? 'unknown_current_source' : 'current_quote_mismatch');
    requireValid(matches.length === 1, 'ambiguous_current_quote');
    return matches[0];
  }
  // Zod parsed a new object: input and recorded provider evidence remain intact.
  evidence.sourceIndex = resolveCurrent(evidence.sourceIndex, evidence.quote);
  for (const anchor of evidence.anchors) anchor.sourceIndex = resolveCurrent(anchor.sourceIndex, anchor.quote);
  for (const citation of evidence.match?.anchors ?? []) citation.sourceIndex = resolveCurrent(citation.sourceIndex, citation.quote);
  const result = (status: 'new' | 'supported' | 'candidate', reason: string, matchedAnchorIds: string[] = []) => ({
    status, reason, matchedAnchorIds, resolvedEvidence: evidence,
    // Anchor-array indices stay stable; each visual source index is now resolved.
    newAnchors: evidence.anchors,
  });
  if (candidateId === null) {
    requireValid(evidence.match === null, 'match_without_candidate');
    return result('new', 'new_object');
  }
  if (evidence.match === null) return result('candidate', 'missing_match');

  const eligible = new Map<string, ObjectAnchor>();
  const intrinsicPairs = new Set<string>();
  let unresolvedPrior = false, unpairedCurrent = false;
  for (const citation of evidence.match.anchors) {
    const reference = citation.anchor;
    const matches = anchors.filter(anchor => 'id' in reference ? anchor.id === reference.id :
      anchor.packetId === reference.packetId && anchor.ref === reference.ref && anchor.index === reference.index);
    if (matches.length === 0 && 'packetId' in reference) {
      const candidates = parsedSightings.data.filter(sighting =>
        sighting.packet.id === reference.packetId && sighting.ref === reference.ref);
      if (candidates.length) {
        requireValid(candidates.length === 1, 'ambiguous_anchor_reference');
        const prior = candidates[0];
        requireValid(prior.evidence.ref === reference.ref, 'anchor_owner_mismatch');
        const anchor = prior.evidence.anchors[reference.index];
        requireValid(anchor, 'unknown_anchor');
        requireValid(prior.candidateEntityIds.includes(candidateId), 'anchor_owner_mismatch');
        requireValid(prior.packet.id !== packet.id && prior.packet.capturedAt < packet.capturedAt, 'non_earlier_anchor');
        const priorSources = [prior.packet.vision.scene, ...prior.packet.vision.observations];
        for (const cited of [prior.evidence, anchor]) {
          const source = priorSources[cited.sourceIndex];
          requireValid(source !== undefined, 'unknown_prior_source');
          requireValid(normalize(source).includes(normalize(cited.quote)), 'prior_quote_mismatch');
        }
        // The original triple remains in resolvedEvidence. It establishes only
        // an earlier candidate observation, never proof of canonical identity.
        unresolvedPrior = true;
        continue;
      }
    }
    requireValid(matches.length > 0, 'unknown_anchor');
    // A triple omits packet version: an inactive old revision cannot shadow its active replacement.
    const active = matches.filter(anchor => anchor.active);
    requireValid(active.length > 0, 'inactive_anchor');
    requireValid(active.length === 1, 'ambiguous_anchor_reference');
    const anchor = active[0];
    requireValid(anchor.entityId === candidateId, 'anchor_owner_mismatch');
    requireValid(anchor.packetId !== packet.id && anchor.observedAt < packet.capturedAt, 'non_earlier_anchor');
    if (anchor.kind !== 'generic') {
      // Earlier evidence cannot lend distinctiveness to a generic current view.
      // Pair only exact, resolved declarations owned by this sighting; an
      // unrelated marker elsewhere in the description is not corroboration.
      const current = evidence.anchors.filter(value => value.sourceIndex === citation.sourceIndex &&
        normalize(value.quote) === normalize(citation.quote) && value.kind !== 'generic');
      if (!current.length) { unpairedCurrent = true; continue; }
      eligible.set(anchor.id, anchor);
      if (anchor.kind !== 'distinctive_configuration' && current.some(value => value.kind !== 'distinctive_configuration'))
        intrinsicPairs.add(anchor.id);
    }
  }
  const matchedAnchorIds = [...eligible.keys()];
  if (unresolvedPrior) return result('candidate', 'earlier_candidate_anchor', matchedAnchorIds);
  if (evidence.match.assessment === 'possible') return result('candidate', 'possible_match', matchedAnchorIds);
  if (evidence.match.conflictingDetails.length) return result('candidate', 'conflicting_details', matchedAnchorIds);
  if (evidence.match.competingEntityIds.length) return result('candidate', 'declared_competitors', matchedAnchorIds);
  if (!eligible.size) return result('candidate', unpairedCurrent ? 'unpaired_current_anchor' : 'insufficient_anchors');
  // Common fixtures can share a configuration (for example a black reader with
  // a green light). Configuration supports an intrinsic marker, not uniqueness.
  if (!intrinsicPairs.size)
    return result('candidate', 'configuration_without_intrinsic_marker', matchedAnchorIds);

  const citedSignatures = new Set([...eligible.values()].map(signature));
  const competitors = new Map<string, Set<string>>();
  for (const anchor of anchors) {
    // Host-validated new-object proposals from this same frame also compete.
    // They can disprove uniqueness, but can never supply an earlier match citation.
    if (!anchor.active || anchor.entityId === candidateId || anchor.kind === 'generic' ||
        anchor.observedAt > packet.capturedAt) continue;
    const signatures = competitors.get(anchor.entityId) ?? new Set<string>();
    signatures.add(signature(anchor)); competitors.set(anchor.entityId, signatures);
  }
  for (const signatures of competitors.values()) {
    if ([...citedSignatures].every(value => signatures.has(value)))
      return result('candidate', 'indistinguishable_anchors', matchedAnchorIds);
  }
  // The model still judges whether these intrinsic details correspond physically.
  return result('supported', 'matched_intrinsic_anchors', matchedAnchorIds);
}
