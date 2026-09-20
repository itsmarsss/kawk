import { createHash } from 'node:crypto';
import { mkdir, appendFile, statfs } from 'node:fs/promises';
import writeFileAtomic from 'write-file-atomic';
import { join } from 'node:path';
import { CaptureInputSchema, TranscriptSchema, VisionSchema, MemoryDeltaSchema, MemoryBatchSchema,
  transcriptKey, type CaptureRecord, type Embedder, type Interpreter, type Packet, type MemoryContext } from './contracts.js';
import { Store } from './store.js';
import { audioSignature, transcriptWindow } from './transcripts.js';
import { jpegDimensions } from './jpeg.js';
import { buildMemoryContext } from './memory-context.js';

export interface PipelineOptions {
  dataDir: string; transcriptWords?: number; visionConcurrency?: number; maxPending?: number; updateBatchSize?: number;
  batchWaitMs?: number;
  contextRetrieval?: 'keyword' | 'semantic';
  now?: () => number; autoStart?: boolean;
}
export class MemoryPipeline {
  private observing = new Set<string>();
  private reducing = new Set<string>();
  private dirty = new Set<string>();
  private indexing = false;
  private running = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private tasks = new Set<Promise<unknown>>();
  private lastError: string | null = null;
  private latencies: { id: string; stage: string; ms: number; at: number }[] = [];
  private nextIndexAttemptAt = 0;
  private readySince = new Map<string, number>();
  private contextInvalidationGeneration = 0;
  private accepting = 0;
  private now: () => number;
  readonly transcriptWords: number;
  constructor(readonly store: Store, private model: Interpreter, readonly embedder: Embedder, private options: PipelineOptions) {
    for (const [name, value, limit] of [['visionConcurrency', options.visionConcurrency ?? 4, 8],
      ['updateBatchSize', options.updateBatchSize ?? 4, 4], ['maxPending', options.maxPending ?? 120, 1000]] as const)
      if (!Number.isInteger(value) || value < 1 || value > limit) throw new Error(`Invalid ${name}`);
    if (!Number.isInteger(options.batchWaitMs ?? 0) || (options.batchWaitMs ?? 0) < 0 || (options.batchWaitMs ?? 0) > 5000)
      throw new Error('Invalid batchWaitMs');
    this.now = options.now ?? Date.now;
    this.transcriptWords = options.transcriptWords ?? 200;
    if (options.autoStart !== false) this.start();
  }
  start() {
    if (this.running) return;
    // Jobs are durable; an interrupted external call can be safely repeated.
    for (const c of this.store.pendingCaptures()) {
      if (c.status === 'observing' || c.status === 'reducing')
        this.store.setCaptureStatus(c.id, c.vision ? 'ready' : 'queued');
    }
    // Recovered ready jobs flush immediately: restarting must not reset a wait budget.
    this.readySince.clear();
    this.running = true;
    // Final ingestion queues historical corrections transactionally with its ledger row.
    this.timer = setInterval(() => this.pump(), 100);
    this.pump();
  }
  async stop() {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await Promise.allSettled([...this.tasks]);
  }
  snapshot() {
    const pending = this.store.pendingCaptures();
    const counts = this.store.db.prepare('SELECT status,count(*) AS n FROM captures GROUP BY status').all() as { status: string; n: number }[];
    const state = this.store.currentState();
    return { running: this.running, queue: pending.length,
      failed: counts.find(row => row.status === 'failed')?.n ?? 0,
      committed: counts.find(row => row.status === 'committed')?.n ?? 0,
      accepted: counts.reduce((sum, row) => sum + row.n, 0),
      latestMemoryAgeMs: state.packetId ? Math.max(0, this.now() - state.observedAt) : null,
      oldestPendingMs: pending.length ? Math.max(0, this.now() - Math.min(...pending.map(c => c.receivedAt))) : 0,
      observing: this.observing.size, reducing: [...this.reducing][0] ?? null, reducingBatch: [...this.reducing], indexing: this.indexing,
      lastError: this.lastError, latencies: this.latencies.slice(-30) };
  }
  removePeople(ids: string[], reset = false) {
    this.store.removePeople(ids, reset, this.now());
    this.contextInvalidationGeneration += 1;
  }
  private record(id: string, stage: string, ms: number) {
    this.latencies.push({ id, stage, ms, at: this.now() });
    this.latencies = this.latencies.slice(-200);
  }
  async capture(raw: unknown) {
    const input = CaptureInputSchema.parse(raw);
    if (!this.store.listSessions().some(s => s.id === input.sessionId)) throw new Error('Unknown session');
    if (input.capturedAt > this.now() + 30_000) throw new Error('Capture timestamp is in the future');
    const bytes = Buffer.from(input.jpegBase64, 'base64');
    if (bytes.length > 8_000_000) throw new Error('JPEG exceeds 8 MB');
    const dimensions = jpegDimensions(bytes);
    if (dimensions.width !== input.width || dimensions.height !== input.height) throw new Error('JPEG dimensions do not match metadata');
    const digest = createHash('sha256').update(bytes).digest('hex');
    const existing = this.store.getCapture(input.id);
    if (existing) {
      if (existing.sha256 !== digest || existing.sessionId !== input.sessionId || existing.sequence !== input.sequence ||
          existing.capturedAt !== input.capturedAt || JSON.stringify(existing.faces) !== JSON.stringify(input.faces))
        throw new Error('Capture ID was reused with different evidence');
      return existing;
    }
    if (this.store.pendingCaptures().length + this.accepting >= (this.options.maxPending ?? 120) + (input.requestId ? 4 : 0)) {
      await mkdir(this.options.dataDir, { recursive: true });
      await appendFile(join(this.options.dataDir, 'capture-gaps.jsonl'), JSON.stringify({
        sessionId: input.sessionId, sequence: input.sequence, capturedAt: input.capturedAt, reason: 'queue_full',
      }) + '\n');
      throw new Error('Memory queue is full; this capture was not accepted');
    }
    this.accepting++;
    try {
      const frameDir = join(this.options.dataDir, 'frames');
      await mkdir(frameDir, { recursive: true });
      const disk = await statfs(frameDir);
      if (disk.bavail * disk.bsize < 256 * 1024 * 1024 + bytes.length)
        throw new Error('Insufficient disk space; capture was not accepted');
      const imagePath = join(frameDir, digest + '.jpg');
      // Repeated identical camera frames share a hash/path. Never truncate that
      // existing image while another vision worker is reading it.
      await writeFileAtomic(imagePath, bytes, { mode: 0o600 });
      const { jpegBase64: _, ...metadata } = input;
      const capture: CaptureRecord = { ...metadata, imagePath, sha256: digest, receivedAt: this.now(),
        status: 'queued', error: null, vision: null };
      this.store.insertCapture(capture);
      this.record(input.id, 'capture_to_upload', this.now() - input.capturedAt);
      this.pump();
      return capture;
    } finally { this.accepting--; }
  }
  transcript(raw: unknown) {
    const t = TranscriptSchema.parse(raw);
    if (!this.store.listSessions().some(s => s.id === t.sessionId)) throw new Error('Unknown session');
    const previous = t.isFinal ? this.store.transcripts(t.sessionId).find(old =>
      old.streamId === t.streamId && old.segmentId === t.segmentId) : undefined;
    if (!this.store.saveTranscript(t)) return false;
    if (!t.isFinal) return true;
    // A correction invalidates retrieved notes/state even when its old utterance
    // has fallen outside an active packet's last-N window. Ordinary new finals
    // do not invalidate existing context and must not starve live interpretation.
    if (previous?.isFinal && t.revision > previous.revision) this.contextInvalidationGeneration++;
    // A final can change a prepared packet while its interpretation is in flight.
    for (const id of this.reducing) {
      const c = this.store.getCapture(id);
      if (c?.sessionId === t.sessionId && c.capturedAt >= t.startAt)
        this.dirty.add(c.id);
    }
    this.pump(); return true;
  }
  retry(id: string) {
    const c = this.store.getCapture(id);
    if (!c) throw new Error('Unknown capture');
    if (this.observing.has(id) || this.reducing.has(id)) throw new Error('Capture is already processing');
    this.store.setCaptureStatus(id, c.vision ? 'ready' : 'queued'); this.pump();
  }
  private window(c: CaptureRecord) {
    const audio = transcriptWindow(this.store.transcripts(c.sessionId), c.capturedAt, this.transcriptWords, c.audioStatus);
    const captures = this.store.capturesForSession(c.sessionId);
    audio.contexts = audio.segments.map(segment => {
      const preceding = captures.filter(other => other.capturedAt <= segment.startAt && other.capturedAt >= segment.startAt - 5000).at(-1);
      const during = captures.filter(other => other.capturedAt > segment.startAt && other.capturedAt <= segment.endAt);
      const evidence = [...(preceding ? [preceding] : []), ...during];
      const sets = evidence.map(other => other.faces.faces.filter(f => f.identityStatus === 'confirmed').map(f => f.personId!).sort());
      return { transcriptKey: transcriptKey(segment), captureIds: evidence.map(other => other.id),
        personIds: [...new Set(sets.flat())], ambiguous: !evidence.length || evidence.some(other => other.faces.status !== 'ready') ||
          sets.some(set => JSON.stringify(set) !== JSON.stringify(sets[0])) };
    });
    return audio;
  }
  private run(task: Promise<unknown>) {
    this.tasks.add(task);
    void task.finally(() => { this.tasks.delete(task); if (this.running) this.pump(); }).catch(() => {});
  }
  private pump() {
    if (!this.running) return;
    const pending = this.store.pendingCaptures().sort((a,b) => a.capturedAt - b.capturedAt || a.sequence - b.sequence);
    // Interrupts get the next vision slot; ordered memory commits still use source time.
    for (const c of [...pending].sort((a,b) => Number(Boolean(b.requestId)) - Number(Boolean(a.requestId)) || a.capturedAt - b.capturedAt)) {
      if (this.observing.size >= (this.options.visionConcurrency ?? 4)) break;
      if (c.status === 'queued' && !this.observing.has(c.id)) {
        this.observing.add(c.id); this.store.setCaptureStatus(c.id, 'observing');
        this.run(this.observe(c));
      }
    }
    const first = pending[0];
    if (!this.reducing.size && first?.status === 'ready') {
      const batch = [first];
      // Catch up using an already-ready prefix. Optional coalescing waits only for
      // the adjacent capture already being observed, never for a future upload.
      // Corrections stay independent because they have their own historical context.
      if (this.model.updateBatch && this.batchable(first)) {
        for (const c of pending.slice(1)) {
          if (batch.length >= (this.options.updateBatchSize ?? 4) || c.status !== 'ready' ||
            c.sessionId !== first.sessionId || !this.batchable(c)) break;
          batch.push(c);
        }
      }
      if (!this.waitForBatch(batch, pending)) {
        for (const c of batch) {
          this.readySince.delete(c.id);
          this.reducing.add(c.id); this.store.setCaptureStatus(c.id, 'reducing');
        }
        this.run(this.reduce(batch));
      }
    }
    if (!this.indexing && this.now() >= this.nextIndexAttemptAt && this.store.pendingEmbeddings(1).length) {
      this.indexing = true; this.run(this.index());
    }
  }
  private waitForBatch(batch: CaptureRecord[], pending: CaptureRecord[]): boolean {
    const first = batch[0], readyAt = this.readySince.get(first.id), next = pending[batch.length];
    const wait = this.options.batchWaitMs ?? 0;
    return wait > 0 && Boolean(this.model.updateBatch) && batch.length < (this.options.updateBatchSize ?? 4) &&
      readyAt !== undefined && this.now() < readyAt + wait && this.batchable(first) && Boolean(next) &&
      next.sessionId === first.sessionId && this.batchable(next) && this.observing.has(next.id);
  }
  private async observe(c: CaptureRecord) {
    const started = this.now();
    this.record(c.id, 'vision_queue', started - c.receivedAt);
    try {
      this.store.saveVision(c.id, VisionSchema.parse(await this.model.observe(c)));
      this.readySince.set(c.id, this.now());
      // Preserve the joined evidence independently of the slower interpretation.
      // A failed update must not make a complete photo/face/speech packet disappear.
      this.packet(this.store.getCapture(c.id)!);
    }
    catch (e) { this.fail(c.id, e); }
    finally { this.record(c.id, 'vision', this.now() - started); this.observing.delete(c.id); }
  }
  private batchable(c: CaptureRecord): boolean {
    // A refreshed, uncommitted draft is still eligible. Historical corrections
    // to already-saved interpretations use the individual update path.
    return !c.singleUpdate && !this.store.hasCommittedPacket(c.id);
  }
  private packet(c: CaptureRecord): Packet {
    if (!c.vision) throw new Error('Missing vision result');
    const previous = this.store.getPacket(c.id);
    const audio = this.window(c);
    if (previous && !this.store.isPacketCommitted(c.id, previous.version) &&
      audioSignature(previous.audio) === audioSignature(audio)) return previous;
    const version = this.store.nextPacketVersion(c.id);
    const packet: Packet = { id: c.id, version, sessionId: c.sessionId, sequence: c.sequence,
      capturedAt: c.capturedAt, imagePath: c.imagePath, sha256: c.sha256, faces: c.faces,
      audio, vision: c.vision, createdAt: this.now(), correction: version > 1 };
    this.store.savePacket(packet);
    this.record(c.id, 'capture_to_packet', this.now() - c.capturedAt);
    return packet;
  }
  private async context(packets: Packet[]): Promise<MemoryContext> {
    return buildMemoryContext(this.store, this.embedder, packets, () => {
      this.lastError = 'Memory context retrieval unavailable; durable evidence retained';
    }, this.options.contextRetrieval ?? 'keyword');
  }
  private async reduce(captures: CaptureRecord[]) {
    const started = this.now();
    try {
      const packets = captures.map(c => this.packet(c));
      const contextGeneration = this.contextInvalidationGeneration;
      const contextStarted = this.now();
      const context = await this.context(packets);
      this.record(captures[0].id, 'memory_context', this.now() - contextStarted);
      if (contextGeneration !== this.contextInvalidationGeneration) {
        this.requeue(captures); return;
      }
      const modelStarted = this.now();
      const batch = packets.length > 1 && this.model.updateBatch
        ? MemoryBatchSchema.parse(await this.model.updateBatch(packets, context))
        : { updates: [{ packetId: packets[0].id, packetVersion: packets[0].version, reuse: [],
          delta: MemoryDeltaSchema.parse(await this.model.update(packets[0], context)) }] };
      this.record(captures[0].id, 'memory_model', this.now() - modelStarted);
      // An ordinary final can arrive while the model is producing an answer. Never
      // commit stale state/event assertions just because they did not cite a fact.
      if (contextGeneration !== this.contextInvalidationGeneration ||
        packets.some((p, i) => audioSignature(p.audio) !== audioSignature(this.window(captures[i])))) {
        this.requeue(captures);
        return;
      }
      const commitStarted = this.now();
      this.store.commitBatch(packets, batch);
      this.record(captures[0].id, 'memory_commit', this.now() - commitStarted);
      for (const c of captures) {
        this.dirty.delete(c.id);
        this.record(c.id, 'capture_to_memory', this.now() - c.capturedAt);
      }
    } catch (e) {
      // Invalid cross-row references never commit. Retry the preserved packets separately;
      // each still goes through full source/identity validation and normal attempt limits.
      if (captures.length > 1 && e instanceof Error &&
          /invalid_batch_reuse|batch_reuse_conflict|duplicate_batch_reuse|batch_row_count|batch_row_mismatch|invalid_object_match_ref|object_match_without_target|incomplete_attribute|schema_validation/.test(e.message)) {
        this.lastError = 'Batch output failed validation; retrying saved packets individually';
        for (const c of captures) this.store.forceSingleUpdate(c.id);
      } else for (const c of captures) this.fail(c.id, e);
    }
    finally {
      for (const c of captures) this.record(c.id, 'memory_update', this.now() - started);
      this.reducing.clear();
    }
  }
  private requeue(captures: CaptureRecord[]) {
    for (const c of captures) { this.dirty.delete(c.id); this.store.setCaptureStatus(c.id, 'ready'); }
  }
  private async index() {
    const started = this.now();
    try {
      const notes = this.store.pendingEmbeddings(16);
      if (!notes.length) return;
      const vectors = await this.embedder.embed(notes.map(n => n.text));
      if (vectors.length !== notes.length) throw new Error('Embedding result count mismatch');
      for (let i = 0; i < notes.length; i++) this.store.putEmbedding(notes[i].id, vectors[i]);
      this.record(notes[0].packetId, 'vector_index_batch', this.now() - started);
    } catch {
      this.lastError = 'Embedding failed; saved memories remain in the retryable index queue';
      this.nextIndexAttemptAt = this.now() + 5000;
    } finally { this.indexing = false; }
  }
  private fail(id: string, e: unknown) {
    // Provider adapters emit sanitized error codes. Avoid leaking arbitrary upstream bodies.
    const message = e instanceof Error ? e.message.slice(0,300) : 'Processing failed';
    this.readySince.delete(id);
    this.lastError = message; this.store.setCaptureStatus(id, 'failed', message);
  }
}
