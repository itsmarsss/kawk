import { createHash } from 'node:crypto';
import type { CaptureRecord, FaceEvidence } from './contracts.js';

/** Gallery UUIDs are durable; unknown tracks exist only in their session/stream namespace. */
export function faceEntityId(capture: Pick<CaptureRecord, 'sessionId' | 'faces'>,
  face: FaceEvidence['faces'][number]): string {
  if (face.identityStatus === 'confirmed') {
    if (!face.personId) throw new Error('Confirmed face requires a gallery identity');
    return face.personId;
  }
  const digest = createHash('sha256').update(JSON.stringify([
    capture.sessionId, capture.faces.streamId, face.trackId,
  ])).digest('hex').slice(0, 32);
  return `person-track:${digest}`;
}
