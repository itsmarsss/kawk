// Binds a raw /ws/faces reply to the exact photo it was computed from. Identity comes ONLY from the
// stabilizer's stable_id/stable_name; the raw gallery match (match.id) is informational and never confirms.
import type { FaceEvidence, FaceEvidenceFace } from './types.ts';

export interface RawFace {
  track_id?: number | string; box?: unknown; stable_id?: unknown; stable_name?: unknown;
  match?: { id?: unknown; name?: unknown; similarity?: unknown } | null; detection_score?: unknown;
}
export interface RawFaceReply {
  type: 'frame'; frame_id?: number; faces?: RawFace[]; input_wh?: unknown; timings_ms?: Record<string, number>;
  detected_count?: number; accepted_count?: number;
  /** Server-side enrollment progress riding on a frame reply (see introductions.ts parseEnrollmentReply). */
  enrollment?: unknown;
}
/** What the client knew about the JPEG it sent (the 640-side derivative of one specific photo). */
export interface SentFrameMeta { id: string; capturedAt: number; width: number; height: number; streamId: string }

export type GeometryCheck = { ok: true } | { ok: false; reason: string };

export function verifyReplyGeometry(reply: RawFaceReply, meta: SentFrameMeta): GeometryCheck {
  const wh = reply.input_wh;
  if (!Array.isArray(wh) || wh.length !== 2) return { ok: false, reason: 'reply has no input_wh' };
  const [w, h] = wh as unknown[];
  if (typeof w !== 'number' || typeof h !== 'number' || !Number.isFinite(w) || !Number.isFinite(h))
    return { ok: false, reason: 'reply input_wh is not numeric' };
  if (Math.round(w) !== meta.width || Math.round(h) !== meta.height)
    return { ok: false, reason: `reply geometry ${w}x${h} does not match sent ${meta.width}x${meta.height}` };
  return { ok: true };
}

/** Finite box clamped to the image; null when degenerate or non-numeric. */
export function sanitizeBox(box: unknown, width: number, height: number): [number, number, number, number] | null {
  if (!Array.isArray(box) || box.length < 4) return null;
  const nums = box.slice(0, 4).map((v) => (typeof v === 'number' ? v : Number.NaN));
  if (nums.some((v) => !Number.isFinite(v))) return null;
  const x1 = Math.min(Math.max(0, nums[0]!), width), y1 = Math.min(Math.max(0, nums[1]!), height);
  const x2 = Math.min(Math.max(0, nums[2]!), width), y2 = Math.min(Math.max(0, nums[3]!), height);
  if (x2 <= x1 || y2 <= y1) return null;
  return [x1, y1, x2, y2];
}

const asId = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 && v.length <= 160 ? v : null);

export interface BoundFaces { evidence: FaceEvidence; rejectedBoxes: number }

/** Reply → FaceEvidence for the sent frame. Caller must have verified geometry first. */
export function faceEvidenceFromReply(reply: RawFaceReply, meta: SentFrameMeta): BoundFaces {
  const faces: FaceEvidenceFace[] = [];
  let rejectedBoxes = 0;
  for (const raw of Array.isArray(reply.faces) ? reply.faces : []) {
    const box = sanitizeBox(raw.box, meta.width, meta.height);
    if (!box) { rejectedBoxes += 1; continue; }
    const personId = asId(raw.stable_id);
    const stableName = typeof raw.stable_name === 'string' ? raw.stable_name.slice(0, 100) : null;
    const sim = raw.match?.similarity;
    faces.push({
      trackId: String(raw.track_id ?? `t${faces.length}`),
      personId,
      name: personId ? stableName : null,
      similarity: typeof sim === 'number' && Number.isFinite(sim) ? Math.max(-1, Math.min(1, sim)) : null,
      box,
      identityStatus: personId ? 'confirmed' : 'unknown',
    });
    if (faces.length >= 100) break;
  }
  return {
    evidence: { frameId: meta.id, streamId: meta.streamId, capturedAt: meta.capturedAt, status: 'ready',
      width: meta.width, height: meta.height, faces },
    rejectedBoxes,
  };
}

export function unavailableFaceEvidence(meta: SentFrameMeta): FaceEvidence {
  return { frameId: meta.id, streamId: meta.streamId, capturedAt: meta.capturedAt, status: 'unavailable',
    width: meta.width, height: meta.height, faces: [] };
}

/** Display label for a live face: confirmed stable name, otherwise Unknown (a raw match never shows as a name). */
export function displayName(face: { identityStatus: 'confirmed' | 'unknown'; name: string | null }): string {
  return face.identityStatus === 'confirmed' && face.name ? face.name : 'Unknown';
}
