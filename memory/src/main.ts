import { mkdir, appendFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from './store.js';
import { LocalEmbedder } from './embeddings.js';
import { createInterpreter } from './interpreter.js';
import { MemoryPipeline } from './pipeline.js';
import { createMemoryServer } from './server.js';
import { createNativeTextRecognizer } from './text-recognition.js';
import { AgentBridge } from './agent-bridge.js';

const moduleParent = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packageRoot = existsSync(join(moduleParent, 'package.json')) ? moduleParent : resolve(moduleParent, '..');
const dataDir = resolve(process.env.MEMORY_DATA_DIR ?? join(packageRoot, 'data'));
await mkdir(dataDir, { recursive: true, mode: 0o700 });
const embedder = new LocalEmbedder();
const store = new Store(join(dataDir, 'memory.sqlite'), embedder.dimensions, embedder.model);
const provider = process.env.MEMORY_MODEL_PROVIDER ?? 'responses';
if (provider !== 'codex' && provider !== 'responses') throw new Error('Unsupported MEMORY_MODEL_PROVIDER');
const model = process.env.MEMORY_MODEL ?? process.env.OPENAI_MODEL ?? 'gpt-5.6-terra';
if (!model?.trim()) throw new Error('Configure MEMORY_MODEL or OPENAI_MODEL for the Responses provider');
const writerModel = process.env.MEMORY_WRITER_MODEL ?? model;
const speechBackend = process.env.MEMORY_SPEECH_BACKEND ?? 'local';
if (speechBackend !== 'local' && speechBackend !== 'baseten') throw new Error('Unsupported MEMORY_SPEECH_BACKEND');
if (!writerModel.trim()) throw new Error('Configure a nonempty MEMORY_WRITER_MODEL');
const updateFormat = process.env.MEMORY_UPDATE_FORMAT ?? 'simple';
if (updateFormat !== 'simple' && updateFormat !== 'canonical' && updateFormat !== 'source' && updateFormat !== 'binding')
  throw new Error('Unsupported MEMORY_UPDATE_FORMAT');
const textReader = process.env.MEMORY_TEXT_READER ?? 'off';
if (textReader !== 'off' && textReader !== 'native') throw new Error('MEMORY_TEXT_READER must be off or native');
const interpreter = createInterpreter({ provider, model, writerModel, updateFormat,
  maxAttempts: Number(process.env.MEMORY_MODEL_ATTEMPTS ?? 2),
  textRecognizer: textReader === 'native' ? createNativeTextRecognizer() : undefined, onTiming: timing => {
  void appendFile(join(dataDir, 'model-latency.jsonl'), JSON.stringify(timing) + '\n', { mode: 0o600 }).catch(() => {});
} });
const words = Number(process.env.MEMORY_TRANSCRIPT_WORDS ?? 200);
if (!Number.isInteger(words) || words < 1 || words > 2000) throw new Error('MEMORY_TRANSCRIPT_WORDS must be 1–2000');
const pipeline = new MemoryPipeline(store, interpreter, embedder, { dataDir, transcriptWords: words,
  visionConcurrency: Number(process.env.MEMORY_VISION_CONCURRENCY ?? 4),
  updateBatchSize: Number(process.env.MEMORY_UPDATE_BATCH_SIZE ?? 4),
  batchWaitMs: Number(process.env.MEMORY_BATCH_WAIT_MS ?? 0) });
const bridge = process.env.KAWK_AGENT_TOKEN_FILE ? new AgentBridge(store, {
  url: process.env.KAWK_AGENT_URL ?? 'http://127.0.0.1:8091', tokenFile: process.env.KAWK_AGENT_TOKEN_FILE,
}) : undefined;
const server = createMemoryServer(pipeline, {
  perceptionUrl: process.env.MEMORY_PERCEPTION_URL ?? 'http://127.0.0.1:8081',
  publicDir: join(packageRoot, 'public'), provider, model, writerModel, updateFormat, textReader,
  speechBackend, speechNotice: process.env.MEMORY_SPEECH_NOTICE, bridge,
});
const port = Number(process.env.PORT ?? 8082);
server.listen(port, process.env.HOST ?? '0.0.0.0', () => {
  console.log(`KAWK memory: http://localhost:${port} (${provider}, vision ${model}, writer ${writerModel})`);
});
void embedder.warmup().catch(() => console.error('Embedding model unavailable; indexing will retry when needed'));
let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  server.close(); server.closeAllConnections();
  await pipeline.stop(); await bridge?.stop(); store.close();
  process.exit(0);
}
process.once('SIGINT', () => { void shutdown(); });
process.once('SIGTERM', () => { void shutdown(); });
