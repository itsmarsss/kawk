import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import { Store } from "./store";
import { Jev } from "./jev";
import { createModels, ProviderConfig } from "./providers";
import { Harness } from "./harness";
import { LocalRunner, DisabledRunner } from "./runner";
import { PushDelivery } from "./push";
import { perceptionProviders } from "./capture";
import { serve } from "./server";
import { fileTelemetry, Telemetry } from "./telemetry";

const env = z
  .object({
    ...ProviderConfig.shape,
    TYPESAFE_API_KEY: z.string().min(1),
    KAWK_JEV_MODEL: z.string().default("jev-1.13.0"),
    KAWK_TELEMETRY: z.enum(["0", "1"]).default("1"),
    KAWK_DATA_DIR: z.string().default("data"),
    KAWK_OWNER: z.string().min(1).default("local-wearer"),
    KAWK_PORT: z.coerce.number().int().min(0).max(65535).default(8091),
    KAWK_RUNNER: z.enum(["local", "disabled"]).default("local"),
    KAWK_BROWSER_INTERACTION: z.enum(["0", "1"]).default("0"),
    KAWK_CLIENT_TOKEN: z.string().min(32).optional(),
    KAWK_RETENTION_DAYS: z.coerce.number().min(1).max(365).default(7),
    KAWK_TRANSCRIPT_RETENTION_DAYS: z.coerce.number().min(0).max(36500).default(0),
    KAWK_TIME_ZONE: z.string().default(Intl.DateTimeFormat().resolvedOptions().timeZone),
    KAWK_STORAGE_MB: z.coerce.number().min(16).max(100000).default(1024),
  })
  .safeParse(process.env);
if (!env.success) {
  console.error(
    "Invalid agent configuration:",
    env.error.issues.map((i) => i.path.join(".")).join(", "),
  );
  process.exit(1);
}
if (!Bun.which("rg"))
  throw new Error("Install ripgrep (rg) for history search before starting the agent");
const config = env.data,
  data = resolve(config.KAWK_DATA_DIR);
await mkdir(data, { recursive: true, mode: 0o700 });
let token = config.KAWK_CLIENT_TOKEN;
const tokenFile = resolve(data, "client-token");
if (!token) {
  try {
    token = (await readFile(tokenFile, "utf8")).trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    token = crypto.randomUUID() + crypto.randomUUID();
    await writeFile(tokenFile, token + "\n", { mode: 0o600, flag: "wx" });
  }
}
const store = new Store(resolve(data, "kawk.sqlite"));
const providerEnv =
  process.env.KAWK_BASETEN_ENABLED === "0"
    ? { ...process.env, BASETEN_API_KEY: undefined }
    : process.env;
const models = createModels(providerEnv, config.KAWK_TELEMETRY === "1");
if (!models.fallback)
  console.warn("Baseten fallback is disabled or unavailable; OpenAI remains the primary provider.");
const harness = new Harness({
  sceneMemoryUrl: process.env.KAWK_SCENE_MEMORY_URL,
  store,
  perception: perceptionProviders(providerEnv),
  telemetry:
    config.KAWK_TELEMETRY === "1"
      ? fileTelemetry(resolve(data, "telemetry.jsonl"))
      : new Telemetry(),
  gate: new Jev({ apiKey: config.TYPESAFE_API_KEY, model: config.KAWK_JEV_MODEL }),
  model: models.model,
  runner: config.KAWK_RUNNER === "local" ? new LocalRunner() : new DisabledRunner(),
  artifactDir: resolve(data, "artifacts"),
  transcriptDir: resolve(data, "transcripts"),
  transcriptRetentionMs: config.KAWK_TRANSCRIPT_RETENTION_DAYS * 86400000,
  timeZone: config.KAWK_TIME_ZONE,
  browserInteraction: config.KAWK_BROWSER_INTERACTION === "1",
  retentionMs: config.KAWK_RETENTION_DAYS * 86400000,
  maxStorageBytes: config.KAWK_STORAGE_MB * 1024 * 1024,
});
harness.start();
const push = await PushDelivery.open(store, resolve(data, "vapid.json"));
push.start();
const server = serve(harness, {
  token,
  owner: config.KAWK_OWNER,
  port: config.KAWK_PORT,
  push,
  speech: { apiKey: providerEnv.BASETEN_API_KEY, modelId: process.env.BASETEN_STT_MODEL_ID },
});
console.log(`KAWK agent listening on ${server.url}; client token: ${tokenFile}`);
let closing = false;
async function stop() {
  if (closing) return;
  closing = true;
  await server.stop();
  await push.stop();
  await harness.stop();
  store.close();
  process.exit(0);
}
process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());
