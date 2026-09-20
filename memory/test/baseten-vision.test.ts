import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createInterpreter, type ModelTiming } from '../src/interpreter.js';
import { basetenVisionConfig, resolveVisionModel } from '../src/vision-provider.js';
import type { CaptureRecord, MemoryContext, Packet } from '../src/contracts.js';

const image = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 0xff, 0xd9]);
const notes = { scene: 'A desk.', observations: ['Brass keys lie beside a blue mug.'],
  readableText: [], uncertainties: ['The speaker is unknown.'] };
const delta = { state: { location: 'office', activity: null, summary: 'Keys on a desk.', uncertainties: [] },
  entities: [], facts: [], events: [], objectMatches: [] };
const context: MemoryContext = { state: { version: 0, observedAt: 0, location: null, activity: null,
  summary: '', uncertainties: [], packetId: null }, entities: [], related: [] };
const env = { OPENAI_API_KEY: 'fixture-openai', BASETEN_API_KEY: 'fixture-baseten',
  MEMORY_VISION_PROVIDER: 'baseten', BASETEN_VLM_MODEL_ID: 'testmodel', BASETEN_VLM_DEPLOYMENT_ID: 'testdeploy' };
const completion = (value: unknown = notes) => ({ choices: [{ finish_reason: 'stop',
  message: { role: 'assistant', content: JSON.stringify(value) } }], usage: { prompt_tokens: 900, completion_tokens: 120 } });
const responses = (value: unknown) => Response.json({ status: 'completed', output: [{ type: 'message',
  role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: JSON.stringify(value) }] }] });
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'kawk-baseten-vision-'));
  const imagePath = join(dir, 'frame.jpg'); await writeFile(imagePath, image);
  const capture: CaptureRecord = { id: 'photo', sessionId: 'session', sequence: 1, capturedAt: 5000,
    width: 640, height: 480, faces: { frameId: 'photo', streamId: 'faces', capturedAt: 5000,
      status: 'ready', width: 640, height: 480, faces: [{ trackId: 'track', personId: 'gallery-maya', name: 'Maya',
        similarity: .8, identityStatus: 'confirmed', box: [10, 10, 100, 100] }] },
    imagePath, sha256: createHash('sha256').update(image).digest('hex'), audioStatus: 'unavailable',
    receivedAt: 5001, status: 'ready', vision: null, error: null };
  return { capture, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

test('default vision remains OpenAI even with Baseten credentials; dormant settings need no validation', async () => {
  const f = await fixture(); let calls = 0;
  try {
    const interpreter = createInterpreter({ provider: 'responses', model: 'gpt-5.6-terra', updateFormat: 'simple',
      env: { OPENAI_API_KEY: 'fixture-openai', BASETEN_API_KEY: 'present-but-unused',
        BASETEN_VLM_MODEL_ID: 'unused/invalid', BASETEN_VLM_MAX_TOKENS: 'bad', KAWK_BASETEN_ENABLED: '0' },
      fetch: async (url, init) => {
        calls++; assert.equal(url, 'https://api.openai.com/v1/responses');
        assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer fixture-openai');
        assert.equal(JSON.parse(String(init?.body)).model, 'gpt-5.6-terra');
        return responses(notes);
      } });
    assert.equal(calls, 0);
    assert.equal((await interpreter.observe(f.capture)).scene, notes.scene); assert.equal(calls, 1);
  } finally { await f.cleanup(); }
});

test('explicit Qwen vision preserves photo/face evidence while single and batch writers stay on GPT', async () => {
  const f = await fixture(); const timings: ModelTiming[] = []; const providers: string[] = [];
  try {
    const interpreter = createInterpreter({ provider: 'responses', model: 'gpt-5.6-terra', writerModel: 'gpt-5.6-sol',
      updateFormat: 'simple', env, onTiming: timing => timings.push(timing), fetch: async (url, init) => {
        const body = JSON.parse(String(init?.body)), headers = new Headers(init?.headers);
        if (String(url).includes('.baseten.co/')) {
          providers.push('baseten');
          assert.equal(url, 'https://model-testmodel.api.baseten.co/deployment/testdeploy/predict');
          assert.equal(headers.get('Authorization'), 'Api-Key fixture-baseten'); assert.equal(init?.redirect, 'error');
          assert.equal(body.model, 'Qwen/Qwen3.5-4B'); assert.equal(body.stream, false);
          assert.equal(body.max_tokens, 2048); assert.deepEqual(body.chat_template_kwargs, { enable_thinking: false });
          assert.match(body.messages[0].content, /untrusted data/);
          const [photo, prompt] = body.messages[1].content;
          assert.equal(photo.image_url.url, `data:image/jpeg;base64,${image.toString('base64')}`);
          assert.ok(prompt.text.endsWith(JSON.stringify(f.capture.faces)));
          assert.doesNotMatch(JSON.stringify(body), /frame\.jpg|fixture-openai|fixture-baseten/);
          assert.equal(body.response_format.json_schema.strict, true);
          assert.deepEqual(Object.keys(body.response_format.json_schema.schema.properties).sort(),
            ['observations', 'readableText', 'scene', 'uncertainties']);
          return Response.json(completion());
        }
        providers.push('responses');
        assert.equal(url, 'https://api.openai.com/v1/responses');
        assert.equal(headers.get('Authorization'), 'Bearer fixture-openai');
        assert.equal(body.model, 'gpt-5.6-sol'); assert.equal(body.input[0].content.length, 1);
        assert.ok(body.input[0].content[0].text.includes(notes.observations[0]));
        return responses(body.text.format.name === 'memory_batch'
          ? { updates: [{ packetId: 'photo', packetVersion: 1, delta, reuse: [] }] } : delta);
      } });
    assert.deepEqual(await interpreter.observe(f.capture), { ...notes, interpretation: 'model' });
    const packet: Packet = { ...f.capture, version: 1, vision: notes, createdAt: 5001, correction: false,
      audio: { text: '', wordCount: 0, segments: [], status: 'unavailable', throughAt: 5000 } };
    await interpreter.update(packet, context); await interpreter.updateBatch!([packet], context);
    assert.deepEqual(providers, ['baseten', 'responses', 'responses']);
    assert.deepEqual(timings.map(t => [t.operation, t.provider, t.model, t.success]), [
      ['observe', 'baseten', 'Qwen/Qwen3.5-4B', true], ['update', 'responses', 'gpt-5.6-sol', true],
      ['updateBatch', 'responses', 'gpt-5.6-sol', true] ]);
    assert.deepEqual(timings[0].usage, { inputTokens: 900, outputTokens: 120 });
    assert.doesNotMatch(JSON.stringify(timings), /fixture-openai|fixture-baseten/);
    await assert.rejects(interpreter.observe({ ...f.capture, faces: { ...f.capture.faces, frameId: 'wrong' } }), /face_packet_mismatch/);
    await assert.rejects(interpreter.observe({ ...f.capture, sha256: 'wrong' }), /image_integrity/);
    assert.equal(providers.length, 3);
  } finally { await f.cleanup(); }
});

test('Baseten selection fails closed for global disable, missing credentials and invalid IDs/limits', () => {
  const options = { provider: 'responses' as const, model: 'gpt-5.6-terra', updateFormat: 'simple' as const };
  for (const [override, error] of [
    [{ KAWK_BASETEN_ENABLED: '0' }, /disabled/], [{ BASETEN_API_KEY: '' }, /BASETEN_API_KEY/],
    [{ BASETEN_VLM_MODEL_ID: '' }, /BASETEN_VLM_MODEL_ID/],
    [{ BASETEN_VLM_MODEL_ID: 'model.evil.example/path' }, /BASETEN_VLM_MODEL_ID/],
    [{ BASETEN_VLM_DEPLOYMENT_ID: '../redirect' }, /BASETEN_VLM_DEPLOYMENT_ID/],
    [{ BASETEN_VLM_MAX_TOKENS: '0' }, /MAX_TOKENS/], [{ BASETEN_VLM_MAX_TOKENS: '8193' }, /MAX_TOKENS/],
    [{ MEMORY_VISION_PROVIDER: 'typo' }, /MEMORY_VISION_PROVIDER/],
    [{ MEMORY_VISION_MODEL: ' ' }, /MEMORY_VISION_MODEL/],
  ] as [NodeJS.ProcessEnv, RegExp][])
    assert.throws(() => createInterpreter({ ...options, env: { ...env, ...override } }), error);
  assert.equal(basetenVisionConfig({ ...env, BASETEN_VLM_DEPLOYMENT_ID: undefined }).url,
    'https://model-testmodel.api.baseten.co/environments/production/predict');
  assert.deepEqual(resolveVisionModel({ provider: 'responses', model: 'gpt-5.6-terra' }, {}),
    { provider: 'responses', model: 'gpt-5.6-terra' });
});

test('Qwen rejects malformed, truncated, refused and tool replies; output size stays bounded', async () => {
  const f = await fixture();
  try {
    for (const [body, code, limit] of [
      [{ choices: [] }, 'incomplete_output'],
      [{ choices: [{ finish_reason: 'length', message: { role: 'assistant', content: JSON.stringify(notes) } }] }, 'incomplete_output'],
      [{ choices: [{ finish_reason: 'stop', message: { role: 'assistant', refusal: 'no', content: '{}' } }] }, 'model_refusal'],
      [{ choices: [{ finish_reason: 'stop', message: { role: 'assistant', tool_calls: [{}], content: '{}' } }] }, 'tool_call_rejected'],
      [{ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'not json' } }] }, 'invalid_json'],
      [completion({ hallucinatedSchema: true }), 'schema_validation'],
      [completion(), 'output_limit', 128],
    ] as [unknown, string, number?][]) {
      const timings: ModelTiming[] = [];
      const interpreter = createInterpreter({ provider: 'responses', model: 'gpt-5.6-terra', env,
        updateFormat: 'simple', maxOutputBytes: limit, fetch: async () => Response.json(body),
        onTiming: t => timings.push(t) });
      await assert.rejects(interpreter.observe(f.capture), new RegExp(code));
      assert.equal(timings[0].success, false); assert.equal(timings[0].errorCode, code);
    }
  } finally { await f.cleanup(); }
});

test('Baseten errors use bounded retries without switching providers or leaking response bodies', async () => {
  const f = await fixture();
  try {
    for (const status of [503, 401]) {
      let calls = 0;
      const interpreter = createInterpreter({ provider: 'responses', model: 'gpt-5.6-terra', env,
        updateFormat: 'simple', maxAttempts: 2, retryDelayMs: 0, fetch: async (url) => {
          assert.match(String(url), /\.baseten\.co/);
          if (++calls === 1) return new Response('PRIVATE_RESPONSE_MUST_NOT_LEAK', { status });
          return Response.json(completion());
        } });
      if (status === 401) {
        await assert.rejects(interpreter.observe(f.capture), error => error instanceof Error &&
          /http_401/.test(error.message) && !error.message.includes('PRIVATE_RESPONSE'));
        assert.equal(calls, 1);
      } else { assert.equal((await interpreter.observe(f.capture)).scene, notes.scene); assert.equal(calls, 2); }
    }
    const interpreter = createInterpreter({ provider: 'responses', model: 'gpt-5.6-terra', env,
      updateFormat: 'simple', timeoutMs: 10, fetch: async (_url, init) => {
        assert.ok(init?.signal);
        // Simulate a stalled request; do not contact a provider.
        await new Promise<void>(resolve => setTimeout(resolve, 20));
        init.signal.throwIfAborted(); return Response.json(completion());
      } });
    await assert.rejects(interpreter.observe(f.capture), /timeout/);
  } finally { await f.cleanup(); }
});
