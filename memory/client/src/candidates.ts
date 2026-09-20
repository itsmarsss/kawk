// Candidate (uncertain) entity associations. Backend observations carry canonical `entityIds` and an
// OPTIONAL `candidateEntityIds` list of possible-but-unconfirmed matches. A candidate is never promoted
// into the canonical set; when the entity the user asked about is only a candidate, the observation is
// labelled with this exact text.
export const POSSIBLE_MATCH_LABEL = 'Possible match — identity unconfirmed';

export interface CandidateBearing { entityIds: string[]; candidateEntityIds?: string[] | null }

/** Candidate ids that are not also canonical (canonical wins on overlap). */
export function unresolvedCandidates(o: CandidateBearing): string[] {
  const canonical = new Set(o.entityIds);
  return [...new Set((o.candidateEntityIds ?? []).filter((id) => id && !canonical.has(id)))];
}

/**
 * Relation of an observation to a requested target entity (the entity being viewed, or the search
 * filter captured at submission). `null` target = unfiltered.
 */
export function targetRelation(o: CandidateBearing, targetId: string | null | undefined): 'canonical' | 'possible' | 'none' {
  if (!targetId) return 'none';
  if (o.entityIds.includes(targetId)) return 'canonical';
  return unresolvedCandidates(o).includes(targetId) ? 'possible' : 'none';
}

/** The exact label to show for the requested target, or null when the target is confirmed / absent. */
export function possibleMatchLabel(o: CandidateBearing, targetId: string | null | undefined): string | null {
  return targetRelation(o, targetId) === 'possible' ? POSSIBLE_MATCH_LABEL : null;
}

/** Label for a search row: against the captured filter when filtered, else whenever candidates are unresolved. */
export function searchRowLabel(o: CandidateBearing, filterEntityId: string | null): string | null {
  return filterEntityId ? possibleMatchLabel(o, filterEntityId) : (unresolvedCandidates(o).length ? POSSIBLE_MATCH_LABEL : null);
}
