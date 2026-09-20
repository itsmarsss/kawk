import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const coordinate = z.number().finite().min(0).max(1);
const lineSchema = z.object({
  // Vision coordinates use the bottom-left origin; do not silently flip them.
  box: z.tuple([coordinate, coordinate, coordinate, coordinate]).refine(
    ([x, y, width, height]) => x + width <= 1.000001 && y + height <= 1.000001, 'Box exceeds image'),
  candidates: z.array(z.object({ text: z.string().max(1000), confidence: coordinate }).strict()).max(3),
}).strict();
export const TextEvidenceSchema = z.object({
  frameId: z.string().min(1).max(160), capturedAt: z.number().finite().nonnegative(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/), engine: z.literal('apple-vision'),
  revision: z.number().int().positive().nullable(), status: z.enum(['ready', 'unavailable']),
  durationMs: z.number().finite().nonnegative(), lines: z.array(lineSchema).max(200),
  error: z.string().min(1).max(200).nullable(),
}).strict().superRefine((value, context) => {
  if (value.status === 'ready' && (value.revision === null || value.error !== null))
    context.addIssue({ code: 'custom', message: 'Ready text evidence needs a revision and no error' });
  if (value.status === 'unavailable' && (value.lines.length !== 0 || value.error === null))
    context.addIssue({ code: 'custom', message: 'Unavailable text evidence needs an error and no lines' });
});
export type TextEvidence = z.infer<typeof TextEvidenceSchema>;
export type TextRecognizer = (input: {
  frameId: string; capturedAt: number; sha256: string; jpeg: Buffer;
}) => Promise<TextEvidence>;

const nativeResultSchema = z.object({
  revision: z.number().int().positive(), durationMs: z.number().finite().nonnegative(),
  lines: z.array(lineSchema).max(200), error: z.string().nullable(),
}).strict();
const maxOutputBytes = 4 * 1024 * 1024;
class RecognitionError extends Error {
  constructor(readonly code: string) { super(code); }
}

function defaultBinaryPath(): string {
  const parent = dirname(dirname(fileURLToPath(import.meta.url)));
  const packageRoot = basename(parent) === 'dist' ? dirname(parent) : parent;
  return join(packageRoot, 'node_modules', '.cache', 'kawk', 'recognize-text');
}

function run(binaryPath: string, imagePath: string, timeoutMs: number): Promise<string> {
  return new Promise((resolveRun, reject) => {
    const child = spawn(binaryPath, [imagePath], {
      shell: false, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
      // OCR needs no API keys or application configuration.
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin:/usr/sbin:/sbin', TMPDIR: tmpdir(), LANG: 'en_US.UTF-8' },
    });
    const chunks: Buffer[] = [];
    let bytes = 0, failure: string | undefined, settled = false;
    const kill = () => {
      try { if (child.pid) process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); }
      catch { /* Already exited. */ }
    };
    const stop = (code: string) => { failure ??= code; kill(); };
    const timer = setTimeout(() => stop('recognition_timeout'), timeoutMs);
    const finish = () => { clearTimeout(timer); if (settled) return false; settled = true; return true; };
    child.on('error', () => { if (finish()) reject(new RecognitionError('recognition_start_failed')); });
    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > maxOutputBytes) { stop('recognition_output_limit'); return; }
      chunks.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      // Drain and count without exposing image paths or arbitrary native messages.
      bytes += chunk.length; if (bytes > maxOutputBytes) stop('recognition_output_limit');
    });
    child.on('close', code => {
      if (!finish()) return;
      if (failure || code !== 0) reject(new RecognitionError(failure ?? 'recognition_process_failed'));
      else resolveRun(Buffer.concat(chunks).toString('utf8'));
    });
  });
}

/** Same-image OCR evidence. Candidate confidence is not factual verification. */
export function createNativeTextRecognizer(options: { binaryPath?: string; timeoutMs?: number } = {}): TextRecognizer {
  const timeoutMs = options.timeoutMs ?? 5000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) throw new Error('Invalid OCR timeout');
  const binaryPath = resolve(options.binaryPath ?? defaultBinaryPath());
  return async input => {
    const started = performance.now();
    const metadata = { frameId: input.frameId, capturedAt: input.capturedAt, sha256: input.sha256, engine: 'apple-vision' as const };
    // Invalid source metadata is a caller error. Runtime failures remain explicit evidence.
    if (!TextEvidenceSchema.safeParse({ ...metadata, revision: null, status: 'unavailable', durationMs: 0, lines: [], error: 'pending' }).success)
      throw new Error('Invalid OCR source metadata');
    const unavailable = (error: string): TextEvidence => ({ ...metadata, revision: null,
      status: 'unavailable', durationMs: performance.now() - started, lines: [], error });
    if (!Buffer.isBuffer(input.jpeg) || input.jpeg.length > 8_000_000) return unavailable('invalid_image_bytes');
    // Snapshot before any await so caller buffer mutation cannot change checked bytes.
    const jpeg = Buffer.from(input.jpeg);
    if (createHash('sha256').update(jpeg).digest('hex') !== input.sha256) return unavailable('image_integrity');
    if (process.platform !== 'darwin') return unavailable('unsupported_platform');
    try { await access(binaryPath, constants.X_OK); }
    catch { return unavailable('binary_unavailable'); }
    let folder: string | undefined;
    try {
      folder = await mkdtemp(join(tmpdir(), 'kawk-ocr-'));
      const imagePath = join(folder, 'capture.jpg');
      await writeFile(imagePath, jpeg, { mode: 0o600 });
      const stdout = await run(binaryPath, imagePath, timeoutMs);
      let raw: unknown;
      try { raw = JSON.parse(stdout); } catch { return unavailable('recognition_invalid_output'); }
      const result = nativeResultSchema.safeParse(raw);
      if (!result.success) return unavailable('recognition_invalid_output');
      if (result.data.error !== null) return unavailable('recognition_failed');
      return { ...metadata, status: 'ready', revision: result.data.revision,
        durationMs: performance.now() - started, lines: result.data.lines, error: null };
    } catch (error) {
      return unavailable(error instanceof RecognitionError ? error.code : 'recognition_io_failed');
    } finally {
      if (folder) await rm(folder, { recursive: true, force: true });
    }
  };
}
