// Pure formatting for the config line's provider/model segment. GET /api/config carries `model` (the
// vision model) and an optional `writerModel` (memory writer) that the server defaults to `model`.
// Only when the two genuinely differ do we name them separately; otherwise the single-model label stays.
import type { ClientConfig } from './api.ts';

const clean = (v: string | undefined): string => (typeof v === 'string' ? v.trim() : '');

export function formatModelLabel(c: Pick<ClientConfig, 'provider' | 'model' | 'writerModel'>): string {
  const provider = `provider ${clean(c.provider) || '?'}`;
  const model = clean(c.model);
  const writer = clean(c.writerModel);
  if (!writer || writer === model) return model ? `${provider} ${model}` : provider;
  if (!model) return `${provider} · memory writer ${writer}`;
  return `${provider} · vision ${model} · memory writer ${writer}`;
}
