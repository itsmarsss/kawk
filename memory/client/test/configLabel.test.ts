import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatModelLabel } from '../src/configLabel.ts';

test('missing writerModel keeps the single-model label', () => {
  assert.equal(formatModelLabel({ provider: 'openai', model: 'gpt-5' }), 'provider openai gpt-5');
  assert.equal(formatModelLabel({ provider: 'openai', model: 'gpt-5', writerModel: '' }), 'provider openai gpt-5');
  assert.equal(formatModelLabel({ provider: 'openai', model: 'gpt-5', writerModel: '   ' }), 'provider openai gpt-5');
});

test('identical writerModel is not shown twice', () => {
  const label = formatModelLabel({ provider: 'openai', model: 'gpt-5', writerModel: 'gpt-5' });
  assert.equal(label, 'provider openai gpt-5');
  assert.ok(!label.includes('memory writer'));
});

test('different writerModel names vision and memory writer separately', () => {
  assert.equal(formatModelLabel({ provider: 'openai', model: 'gpt-5', writerModel: 'gpt-5-mini' }),
    'provider openai · vision gpt-5 · memory writer gpt-5-mini');
});

test('missing provider/model never print undefined', () => {
  assert.equal(formatModelLabel({}), 'provider ?');
  assert.equal(formatModelLabel({ provider: 'openai' }), 'provider openai');
  assert.equal(formatModelLabel({ provider: 'openai', writerModel: 'gpt-5-mini' }), 'provider openai · memory writer gpt-5-mini');
  for (const c of [{}, { provider: 'x', writerModel: 'y' }, { model: 'a', writerModel: 'b' }]) assert.ok(!formatModelLabel(c).includes('undefined'));
});

test('main.ts renders the config line through formatModelLabel (no inline provider/model template left)', async () => {
  const { readFile } = await import('node:fs/promises');
  const src = await readFile(new URL('../src/main.ts', import.meta.url), 'utf8');
  assert.match(src, /import \{ formatModelLabel \} from '\.\/configLabel\.ts'/);
  assert.match(src, /\$\{formatModelLabel\(config\)\}/);
  assert.ok(!src.includes("provider ${config.provider ?? '?'}"), 'old inline label must not coexist with the helper');
  assert.match(src, /writerModel: c\.writerModel/, 'boot copies writerModel into the client config');
});
