import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createNativeTextRecognizer, TextEvidenceSchema, type TextEvidence } from '../src/text-recognition.js';

const jpeg = Buffer.from([255, 216, 255, 224, 1, 255, 217]);
const input = () => ({ frameId: 'exact-frame', capturedAt: 12345,
  sha256: createHash('sha256').update(jpeg).digest('hex'), jpeg: Buffer.from(jpeg) });
const line = { box: [.1, .2, .3, .1], candidates: [{ text: 'Room 4A', confidence: 1 }] };
const native = (lines: unknown[] = [line]) => ({ revision: 3, durationMs: 12, lines, error: null });
const ready = (): TextEvidence => ({ frameId: input().frameId, capturedAt: input().capturedAt, sha256: input().sha256,
  engine: 'apple-vision', revision: 3, status: 'ready', durationMs: 20, lines: [], error: null });
async function fixture(body: string) {
  const directory = await mkdtemp(join(tmpdir(), 'kawk-ocr-test-'));
  const binaryPath = join(directory, 'helper'), recordPath = join(directory, 'record.json');
  const script = `#!${process.execPath}\nconst fs = require('node:fs');
const path = require('node:path');
const image = process.argv[2];
fs.writeFileSync(${JSON.stringify(recordPath)}, JSON.stringify({image, bytes: fs.readFileSync(image).toString('hex'),
 fileMode: fs.statSync(image).mode & 511, directoryMode: fs.statSync(path.dirname(image)).mode & 511,
 secret: process.env.KAWK_OCR_SECRET ?? null, args: process.argv.slice(2)}));
${body}\n`;
  await writeFile(binaryPath, script); await chmod(binaryPath, 0o700);
  return { binaryPath, async record() { return JSON.parse(await readFile(recordPath, 'utf8')) as {
    image: string; bytes: string; fileMode: number; directoryMode: number; secret: string | null; args: string[];
  }; }, async cleanup() { await rm(directory, { recursive: true, force: true }); } };
}
const emit = (value: unknown) => `process.stdout.write(${JSON.stringify(JSON.stringify(value))});`;
const macOnly = { skip: process.platform !== 'darwin' };

test('text schema distinguishes an empty successful result from unavailable OCR', () => {
  assert.equal(TextEvidenceSchema.parse(ready()).status, 'ready');
  assert.equal(TextEvidenceSchema.parse({ ...ready(), revision: null, status: 'unavailable', error: 'binary_unavailable' }).status, 'unavailable');
  for (const bad of [
    { ...ready(), revision: null }, { ...ready(), error: 'failure' },
    { ...ready(), status: 'unavailable' }, { ...ready(), status: 'unavailable', error: 'failure', lines: [line] },
    { ...ready(), lines: [{ ...line, box: [.9, .2, .3, .1] }] },
    { ...ready(), lines: [{ ...line, candidates: [{ text: 'bad', confidence: 1.1 }] }] },
    { ...ready(), lines: Array.from({ length: 201 }, () => line) },
    { ...ready(), lines: [{ ...line, candidates: Array.from({ length: 4 }, () => line.candidates[0]) }] },
  ]) assert.equal(TextEvidenceSchema.safeParse(bad).success, false);
});

test('hash mismatch and invalid configuration fail without a native process', async () => {
  const result = await createNativeTextRecognizer({ binaryPath: '/not/a/binary' })({ ...input(), sha256: '0'.repeat(64) });
  assert.equal(result.status, 'unavailable'); assert.equal(result.error, 'image_integrity');
  assert.equal(result.sha256, '0'.repeat(64)); assert.deepEqual(result.lines, []);
  for (const timeoutMs of [0, -1, 30001, .5, NaN]) assert.throws(() => createNativeTextRecognizer({ timeoutMs }), /Invalid OCR timeout/);
  await assert.rejects(createNativeTextRecognizer()({ ...input(), capturedAt: -1 }), /Invalid OCR source metadata/);
});

test('missing binary or unsupported platform is explicit and returns exact source metadata', async () => {
  const result = await createNativeTextRecognizer({ binaryPath: '/does-not-exist/kawk-ocr' })(input());
  assert.equal(result.status, 'unavailable');
  assert.equal(result.error, process.platform === 'darwin' ? 'binary_unavailable' : 'unsupported_platform');
  assert.equal(result.frameId, input().frameId); assert.equal(result.capturedAt, input().capturedAt);
  assert.equal(result.sha256, input().sha256); assert.equal(result.engine, 'apple-vision');
  assert.equal(result.revision, null); assert.ok(result.durationMs >= 0); TextEvidenceSchema.parse(result);
});

test('native wrapper checks immutable bytes, uses private files and preserves bottom-left boxes', macOnly, async () => {
  const f = await fixture(emit(native())); const original = process.env.KAWK_OCR_SECRET;
  try {
    process.env.KAWK_OCR_SECRET = 'must-not-reach-native';
    const data = input(), pending = createNativeTextRecognizer({ binaryPath: f.binaryPath })(data);
    data.jpeg.fill(0); // Mutation after invocation must not alter the hashed snapshot.
    const result = await pending, record = await f.record();
    assert.equal(result.status, 'ready'); assert.equal(result.revision, 3); assert.equal(result.error, null);
    assert.deepEqual(result.lines, [line]); assert.equal(result.sha256, input().sha256);
    assert.equal(record.bytes, jpeg.toString('hex')); assert.equal(record.fileMode, 0o600);
    assert.equal(record.directoryMode, 0o700); assert.equal(record.secret, null);
    assert.deepEqual(record.args, [record.image]);
    await assert.rejects(access(record.image));
    assert.ok(!JSON.stringify(result).includes(record.image)); TextEvidenceSchema.parse(result);
  } finally {
    if (original === undefined) delete process.env.KAWK_OCR_SECRET; else process.env.KAWK_OCR_SECRET = original;
    await f.cleanup();
  }
});

test('successful empty native OCR remains ready', macOnly, async () => {
  const f = await fixture(emit(native([])));
  try {
    const result = await createNativeTextRecognizer({ binaryPath: f.binaryPath })(input());
    assert.equal(result.status, 'ready'); assert.deepEqual(result.lines, []); assert.equal(result.error, null);
    await assert.rejects(access((await f.record()).image));
  } finally { await f.cleanup(); }
});

test('malformed output, schema violations and native errors return sanitized unavailable evidence', macOnly, async () => {
  const bodies = [
    'process.stdout.write("not JSON private-native-detail");',
    emit({ ...native(), revision: null }),
    emit({ ...native(), revision: -1 }),
    emit({ ...native(), lines: [{ ...line, candidates: [{ text: 'x'.repeat(1001), confidence: .5 }] }] }),
    emit({ ...native(), unexpected: 'private-native-detail' }),
    emit({ ...native(), error: 'private-native-detail' }),
    'process.stderr.write("private-native-detail"); process.exit(3);',
  ];
  for (const body of bodies) {
    const f = await fixture(body);
    try {
      const result = await createNativeTextRecognizer({ binaryPath: f.binaryPath })(input());
      assert.equal(result.status, 'unavailable'); assert.deepEqual(result.lines, []);
      assert.ok(result.error); assert.ok(!JSON.stringify(result).includes('private-native-detail'));
      await assert.rejects(access((await f.record()).image)); TextEvidenceSchema.parse(result);
    } finally { await f.cleanup(); }
  }
});

test('timeouts and excessive stdout/stderr are bounded and clean private images', macOnly, async () => {
  const cases = [
    // Leave time for the fixture process to start under the parallel test suite;
    // the timeout still terminates its deliberate hang and verifies image cleanup.
    ['setInterval(() => {}, 1000);', 'recognition_timeout', 2000],
    ['process.stdout.write("x".repeat(5 * 1024 * 1024)); setInterval(() => {}, 1000);', 'recognition_output_limit', 5000],
    ['process.stderr.write("x".repeat(5 * 1024 * 1024)); setInterval(() => {}, 1000);', 'recognition_output_limit', 5000],
  ] as const;
  for (const [body, code, timeoutMs] of cases) {
    const f = await fixture(body);
    try {
      const started = performance.now();
      const result = await createNativeTextRecognizer({ binaryPath: f.binaryPath, timeoutMs })(input());
      assert.equal(result.error, code); assert.ok(performance.now() - started < timeoutMs + 2000);
      assert.equal(result.status, 'unavailable'); await assert.rejects(access((await f.record()).image));
    } finally { await f.cleanup(); }
  }
});
