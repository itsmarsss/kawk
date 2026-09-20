import type { Vision } from './contracts.js';

/** These are reader candidates, never verified quotes, even when readers agree. */
export function textReadings(vision: Vision): { text: string; reader: string; score: number | null }[] {
  return [
    ...vision.readableText.map(text => ({ text, reader: 'vision-model', score: null })),
    ...(vision.textEvidence?.status === 'ready' ? vision.textEvidence.lines.flatMap(line =>
      line.candidates.slice(0, 1).map(candidate => ({ text: candidate.text,
        reader: 'apple-vision', score: candidate.confidence }))) : []),
  ];
}

export function visualObservations(vision: Vision): { text: string; confidence: 'observed' | 'uncertain' }[] {
  const sources = [vision.scene, ...vision.observations], draft = vision.visualDraft;
  // A raw copy must not promote an explicitly uncertain full descriptor. An
  // uncertain paraphrased location does not downgrade the descriptor itself.
  // Compare text as well so deduplication cannot promote identical source copies.
  const uncertainDescriptors = new Set(draft?.facts.filter(fact => fact.confidence === 'uncertain' &&
    fact.entityIndexes.some(index => draft.entities[index]?.descriptionSourceIndex === fact.sourceIndex) &&
    (fact.text ?? sources[fact.sourceIndex]) === sources[fact.sourceIndex])
    .map(fact => sources[fact.sourceIndex]));
  return [
    ...sources.map(text => ({ text, confidence: vision.interpretation === 'model' || uncertainDescriptors.has(text) ? 'uncertain' as const : 'observed' as const })),
    ...textReadings(vision).map(reading => ({
      text: `Unverified text reading (${reading.reader}): ${reading.text}`, confidence: 'uncertain' as const,
    })),
    ...vision.uncertainties.map(text => ({ text: `Visual uncertainty: ${text}`, confidence: 'uncertain' as const })),
  ];
}
