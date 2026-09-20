export type TextProvider = 'codex' | 'responses';
export type VisionProvider = TextProvider | 'baseten';

/** Vision can use a different provider without changing the text memory writer. */
export function resolveVisionModel(options: {
  provider: TextProvider; model: string; visionProvider?: VisionProvider; visionModel?: string;
}, env: NodeJS.ProcessEnv): { provider: VisionProvider; model: string } {
  const provider = options.visionProvider ?? env.MEMORY_VISION_PROVIDER ?? options.provider;
  if (provider !== 'codex' && provider !== 'responses' && provider !== 'baseten')
    throw new Error('Unsupported MEMORY_VISION_PROVIDER');
  const model = options.visionModel ?? env.MEMORY_VISION_MODEL ??
    (provider === 'baseten' ? 'Qwen/Qwen3.5-4B' : options.model);
  if (!model.trim()) throw new Error('Configure a nonempty MEMORY_VISION_MODEL');
  return { provider, model };
}

export function basetenVisionConfig(env: NodeJS.ProcessEnv) {
  if (env.KAWK_BASETEN_ENABLED === '0')
    throw new Error('Baseten vision is disabled by KAWK_BASETEN_ENABLED=0');
  if (!env.BASETEN_API_KEY?.trim()) throw new Error('Baseten vision needs BASETEN_API_KEY');
  const modelId = env.BASETEN_VLM_MODEL_ID;
  const deploymentId = env.BASETEN_VLM_DEPLOYMENT_ID;
  if (!modelId || !/^[a-zA-Z0-9]+$/.test(modelId))
    throw new Error('Configure BASETEN_VLM_MODEL_ID');
  if (deploymentId !== undefined && !/^[a-zA-Z0-9]+$/.test(deploymentId))
    throw new Error('Invalid BASETEN_VLM_DEPLOYMENT_ID');
  const maxTokens = Number(env.BASETEN_VLM_MAX_TOKENS ?? 2048);
  if (!Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > 8192)
    throw new Error('BASETEN_VLM_MAX_TOKENS must be 1–8192');
  // Custom vLLM server: Baseten forwards /predict to /v1/chat/completions.
  // https://docs.baseten.co/development/model/custom-server#endpoint-mapping
  const route = deploymentId ? `deployment/${deploymentId}` : 'environments/production';
  return { url: `https://model-${modelId}.api.baseten.co/${route}/predict`,
    apiKey: env.BASETEN_API_KEY, maxTokens };
}

export function basetenVisionBody(input: {
  model: string; instructions: string; prompt: string; image: Buffer; schema: unknown; maxTokens: number;
}) {
  return {
    model: input.model, stream: false, temperature: 0, max_tokens: input.maxTokens,
    chat_template_kwargs: { enable_thinking: false },
    messages: [
      { role: 'system', content: input.instructions },
      { role: 'user', content: [
        { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${input.image.toString('base64')}` } },
        { type: 'text', text: input.prompt },
      ] },
    ],
    response_format: { type: 'json_schema', json_schema: {
      name: 'scene_observation', strict: true, schema: input.schema,
    } },
  };
}

export class BasetenVisionError extends Error {
  constructor(readonly code: string) { super(`Baseten vision failed: ${code}`); }
}

/** Reject partial/tool/refusal replies before the interpreter's normal evidence validation. */
export function decodeBasetenVision(raw: Record<string, unknown>) {
  function fail(code: string): never { throw new BasetenVisionError(code); }
  if (!Array.isArray(raw.choices) || raw.choices.length !== 1) fail('incomplete_output');
  const choice = raw.choices[0];
  if (!choice || typeof choice !== 'object') fail('malformed_output');
  const message = choice.message;
  if (!message || typeof message !== 'object' || message.role !== 'assistant') fail('malformed_output');
  if (message.refusal || choice.finish_reason === 'content_filter') fail('model_refusal');
  if (message.function_call != null || (message.tool_calls != null &&
      (!Array.isArray(message.tool_calls) || message.tool_calls.length > 0))) fail('tool_call_rejected');
  if (choice.finish_reason !== 'stop') fail('incomplete_output');
  if (typeof message.content !== 'string') fail('malformed_output');
  let value: unknown;
  try { value = JSON.parse(message.content); } catch { fail('invalid_json'); }
  const usage = raw.usage && typeof raw.usage === 'object' ? raw.usage as Record<string, unknown> : {};
  return { value, usage: { input_tokens: usage.prompt_tokens, output_tokens: usage.completion_tokens } };
}
