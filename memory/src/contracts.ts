import { z } from 'zod';
import { TextEvidenceSchema } from './text-recognition.js';
import { ObjectEvidenceSchema, type ObjectAnchor } from './object-identity.js';
import { VisualDraftSchema, validateVisualDraft } from './visual-draft.js';

const id = z.string().min(1).max(160);
const time = z.number().finite().nonnegative();
export const WordSchema = z.object({ text: z.string(), startAt: time, endAt: time });
export const TranscriptSchema = z.object({
  sessionId: id, streamId: id, segmentId: id, revision: z.number().int().nonnegative(),
  text: z.string().max(20000), isFinal: z.boolean(), startAt: time, endAt: time,
  receivedAt: time, words: z.array(WordSchema).max(4000),
  speakerId: z.null(), timing: z.enum(['approximate', 'exact']),
}).refine(t => t.endAt >= t.startAt && t.words.every(w => w.endAt >= w.startAt), 'Invalid speech interval');
export type Transcript = z.infer<typeof TranscriptSchema>;
export const transcriptKey = (t: Transcript) => `${t.streamId}/${t.segmentId}@${t.revision}`;
export const segmentKey = (t: Transcript) => `${t.streamId}/${t.segmentId}`;

export const FaceEvidenceSchema = z.object({
  frameId: id, streamId: id, capturedAt: time,
  status: z.enum(['ready', 'unavailable']), width: z.number().int().positive(),
  height: z.number().int().positive(),
  faces: z.array(z.object({
    trackId: id, personId: id.nullable(), name: z.string().max(100).nullable(),
    similarity: z.number().min(-1).max(1).nullable(),
    box: z.tuple([z.number(), z.number(), z.number(), z.number()]),
    identityStatus: z.enum(['confirmed', 'unknown']),
  })).max(100),
});
export type FaceEvidence = z.infer<typeof FaceEvidenceSchema>;
export const CaptureInputSchema = z.object({
  id, sessionId: id, sequence: z.number().int().nonnegative(), capturedAt: time,
  requestId: id.optional(),
  width: z.number().int().positive().max(4096), height: z.number().int().positive().max(4096),
  jpegBase64: z.string().min(4).max(12_000_000), faces: FaceEvidenceSchema,
  audioStatus: z.enum(['live', 'unavailable']),
}).superRefine((c, ctx) => {
  if (c.faces.frameId !== c.id || c.faces.capturedAt !== c.capturedAt)
    ctx.addIssue({ code: 'custom', message: 'Faces must refer to the exact capture ID and timestamp' });
  if (Math.abs(c.width / c.height - c.faces.width / c.faces.height) > 0.02)
    ctx.addIssue({ code: 'custom', message: 'Face derivative must preserve image geometry' });
  for (const f of c.faces.faces) {
    const [x1,y1,x2,y2] = f.box;
    if (x1 < 0 || y1 < 0 || x2 <= x1 || y2 <= y1 || x2 > c.faces.width || y2 > c.faces.height)
      ctx.addIssue({ code: 'custom', message: 'Invalid face box' });
    if ((f.identityStatus === 'confirmed') !== (f.personId !== null))
      ctx.addIssue({ code: 'custom', message: 'Only confirmed face identities may carry a gallery ID' });
  }
  if(c.faces.status === 'unavailable' && c.faces.faces.length)
    ctx.addIssue({ code: 'custom', message: 'Unavailable face evidence cannot contain identities' });
});
export type CaptureInput = z.infer<typeof CaptureInputSchema>;
export type CaptureStatus = 'queued' | 'observing' | 'ready' | 'reducing' | 'committed' | 'failed';
export interface CaptureRecord extends Omit<CaptureInput, 'jpegBase64'> {
  singleUpdate?: boolean;
  imagePath: string; sha256: string; receivedAt: number; status: CaptureStatus;
  error: string | null; vision: Vision | null;
}

// Only the description schema goes to the model. OCR provenance is attached by
// the host and cannot be supplied or overwritten in a provider response.
export const VisionDescriptionSchema = z.object({
  scene: z.string().max(2000), observations: z.array(z.string().max(2000)).max(30),
  readableText: z.array(z.string().max(1000)).max(20),
  uncertainties: z.array(z.string().max(1000)).max(10),
}).strict();
export const VisionSchema = VisionDescriptionSchema.extend({
  textEvidence: TextEvidenceSchema.optional(), visualDraft: VisualDraftSchema.optional(),
  interpretation: z.literal('model').optional(),
}).strict();
export type Vision = z.infer<typeof VisionSchema>;
export function checkedVision(value: unknown, capture: { id: string; capturedAt: number; sha256: string; faces?: FaceEvidence }): Vision {
  const vision = VisionSchema.parse(value), evidence = vision.textEvidence;
  if (evidence && (evidence.frameId !== capture.id || evidence.capturedAt !== capture.capturedAt || evidence.sha256 !== capture.sha256))
    throw new Error('Text evidence must match the exact capture and image hash');
  if (vision.visualDraft) {
    if (!capture.faces || capture.faces.frameId !== capture.id || capture.faces.capturedAt !== capture.capturedAt)
      throw new Error('Visual draft requires the matching capture face evidence');
    validateVisualDraft(vision.visualDraft, vision, capture.faces);
  }
  return vision;
}
export interface AudioWindow {
  text: string; wordCount: number; segments: Transcript[];
  status: 'live' | 'unavailable'; throughAt: number;
  contexts?: { transcriptKey: string; captureIds: string[]; personIds: string[]; ambiguous: boolean }[];
}
export interface Packet {
  id: string; version: number; sessionId: string; sequence: number; capturedAt: number;
  imagePath: string; sha256: string; faces: FaceEvidence; audio: AudioWindow;
  vision: Vision; createdAt: number; correction: boolean;
}

export const EntityKindSchema = z.enum(['person', 'object', 'place', 'event']);
export type EntityKind = z.infer<typeof EntityKindSchema>;
export interface Entity {
  id: string; kind: EntityKind; label: string; description: string; personId: string | null;
  createdAt: number; lastSeenAt: number;
  attributes: Record<string, { value: string; observedAt: number; observationId: string }>;
  identityAnchors?: ObjectAnchor[];
}
export interface CurrentState {
  version: number; observedAt: number; location: string | null; activity: string | null;
  summary: string; uncertainties: string[]; packetId: string | null;
}
// Generation retains the original compact limit. Storage also accepts the
// complete union of image uncertainty and the writer's additional uncertainty.
export const MemoryModelStateSchema = z.object({
  location: z.string().max(500).nullable(), activity: z.string().max(500).nullable(),
  summary: z.string().max(2000), uncertainties: z.array(z.string().max(500)).max(10),
}).strict();
export const MemoryDeltaSchema = z.object({
  state: MemoryModelStateSchema.extend({ uncertainties: z.array(z.string().max(1000)).max(20) }),
  entities: z.array(z.object({
    ref: id, existingId: id.nullable(), kind: EntityKindSchema,
    label: z.string().min(1).max(200), description: z.string().max(1500), personId: id.nullable(),
  }).strict()).max(470),
  facts: z.array(z.object({
    entityRefs: z.array(id).max(10), text: z.string().min(1).max(2000),
    attribute: z.string().max(100).nullable(), value: z.string().max(1000).nullable(),
    visual: z.boolean(), transcriptKeys: z.array(id).max(30),
    confidence: z.enum(['observed', 'reported', 'uncertain']),
  }).strict()).max(130),
  events: z.array(z.object({
    entityRef: id, status: z.enum(['ongoing', 'ended']), summary: z.string().max(2000),
  }).strict()).max(10),
  // Legacy persisted deltas did not carry match evidence. Missing evidence never
  // grants a new visual match; the Store treats it as a candidate for an old object.
  objectEvidence: z.array(ObjectEvidenceSchema).max(30).optional(),
  // The simple AI writer assesses continuity directly; no visual-anchor protocol.
  objectMatches: z.array(z.object({ ref: id, assessment: z.enum(['same_instance', 'possible']),
    reason: z.string().min(1).max(1000),
  }).strict()).max(30).optional(),
}).strict();
export type MemoryDelta = z.infer<typeof MemoryDeltaSchema>;
// Storage accepts complete mechanical expansion; direct model declarations retain
// their smaller generation bounds. Binding may add 30 draft + 30 supplemental
// entities, 400 fact references and 10 event references without losing evidence.
export const MemoryModelDeltaSchema = MemoryDeltaSchema.omit({ objectMatches: true }).extend({
  state: MemoryModelStateSchema,
  entities: MemoryDeltaSchema.shape.entities.max(30), facts: MemoryDeltaSchema.shape.facts.max(40),
  objectEvidence: z.array(ObjectEvidenceSchema).max(30),
}).strict();
// A batch shares one model request, never one source timestamp. Explicit backward
// references allow later rows to reuse an entity created by an earlier row.
export const MemoryBatchSchema = z.object({
  updates: z.array(z.object({
    packetId: id, packetVersion: z.number().int().positive(), delta: MemoryDeltaSchema,
    reuse: z.array(z.object({ ref: id, fromPacketId: id, fromRef: id }).strict()).max(180),
  }).strict()).min(1).max(4),
}).strict();
export type MemoryBatch = z.infer<typeof MemoryBatchSchema>;
export const MemoryModelBatchSchema = MemoryBatchSchema.extend({ updates: z.array(
  MemoryBatchSchema.shape.updates.element.extend({ delta: MemoryModelDeltaSchema,
    reuse: MemoryBatchSchema.shape.updates.element.shape.reuse.max(30),
  }).strict(),
).min(1).max(4) }).strict();
export interface Observation {
  id: string; packetId: string; packetVersion: number; entityIds: string[]; text: string;
  observedAt: number; endAt: number; confidence: string; visual: boolean;
  transcriptKeys: string[]; superseded: boolean;
  candidateEntityIds?: string[];
}
export interface SearchHit extends Observation { distance: number }
export interface MemoryContext { state: CurrentState; entities: Entity[]; related: Observation[] }
export interface SearchFilter { entityId?: string; from?: number; to?: number; limit?: number }
export interface Interpreter {
  observe(capture: CaptureRecord): Promise<Vision>;
  update(packet: Packet, context: MemoryContext): Promise<MemoryDelta>;
  updateBatch?(packets: Packet[], context: MemoryContext): Promise<MemoryBatch>;
}
export interface Embedder { readonly model: string; readonly dimensions: number; embed(texts: string[]): Promise<number[][]> }
