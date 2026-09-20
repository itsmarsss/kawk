import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createServer } from "node:net";

// Run from agent/: Bun loads the private agent/.env before this script starts.
const root = resolve(import.meta.dir, "../..");
const data = resolve(process.env.KAWK_DATA_DIR ?? resolve(root, "agent/data"));
const agentPort = Number(process.env.KAWK_PORT ?? 8091);
const memoryPort = Number(process.env.PORT ?? 8082);
const perception = process.env.MEMORY_PERCEPTION_URL ?? "http://127.0.0.1:8081";
if (!process.env.OPENAI_API_KEY || !process.env.TYPESAFE_API_KEY)
  throw new Error("Configure OPENAI_API_KEY and TYPESAFE_API_KEY in private agent/.env");
if (Boolean(process.env.MEMORY_TLS_CERT) !== Boolean(process.env.MEMORY_TLS_KEY))
  throw new Error('Set both MEMORY_TLS_CERT and MEMORY_TLS_KEY');
const ports = [agentPort, memoryPort, ...(process.env.MEMORY_TLS_CERT ? [Number(process.env.MEMORY_TLS_PORT ?? 8443)] : [])];
if (new Set(ports).size !== ports.length) throw new Error('Demo ports must be distinct');
for (const port of ports) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid demo port");
  await new Promise<void>((ok, fail) => {
    const probe = createServer();
    probe.once("error", () => fail(new Error(`Port ${port} is already in use; stop its old service before starting the demo`)));
    probe.listen(port, "0.0.0.0", () => probe.close(() => ok()));
  });
}
const status = await fetch(new URL("/api/status", perception), { signal: AbortSignal.timeout(5000) })
  .then(async r => { if (!r.ok) throw new Error("Perception status unavailable"); return await r.json() as any; })
  .catch(() => { throw new Error("Start local perception first with make serve-ui (or reuse the running perception server)"); });
if (!status.face?.ready || !status.backends?.speech?.local?.configured)
  throw new Error("Local face and speech backends must be ready before starting the demo");
await mkdir(data, { recursive: true, mode: 0o700 });
const tokenFile = resolve(data, "client-token");
let token = process.env.KAWK_CLIENT_TOKEN;
if (!token) {
  try { token = (await readFile(tokenFile, "utf8")).trim(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}
token ||= crypto.randomUUID() + crypto.randomUUID();
if (token.length < 32) throw new Error("Invalid local client token");
await writeFile(tokenFile, token + "\n", { mode: 0o600 });
const env = { ...process.env, KAWK_DATA_DIR: data, KAWK_CLIENT_TOKEN: token,
  KAWK_BROWSER_INTERACTION: process.env.KAWK_BROWSER_INTERACTION ?? '1',
  KAWK_BASETEN_ENABLED: "0", MEMORY_SPEECH_BACKEND: "local", MEMORY_PERCEPTION_URL: perception,
  KAWK_AGENT_URL: `http://127.0.0.1:${agentPort}`, KAWK_AGENT_TOKEN_FILE: tokenFile,
  KAWK_SCENE_MEMORY_URL: `http://127.0.0.1:${memoryPort}` };
const children: ReturnType<typeof Bun.spawn>[] = [];
let stopping = false;
async function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) if (child.exitCode === null) child.kill("SIGTERM");
  const deadline = setTimeout(() => { for (const child of children) if (child.exitCode === null) child.kill("SIGKILL"); }, 15000);
  await Promise.all(children.map(c => c.exited));
  clearTimeout(deadline);
  process.exit(code);
}
process.once("SIGINT", () => void stop());
process.once("SIGTERM", () => void stop());
try {
  children.push(Bun.spawn([process.execPath, "src/main.ts"], { cwd: resolve(root, "agent"), env, stdout: "inherit", stderr: "inherit" }));
  children.push(Bun.spawn(["node", "--import", "tsx", "src/main.ts"], { cwd: resolve(root, "memory"), env, stdout: "inherit", stderr: "inherit" }));
  console.log(`Demo UI: http://localhost:${memoryPort} — choose camera and microphone, then press Start. Natural speech activates Jev automatically.`);
  console.log("Local perception is reused; stopping this command leaves it running.");
  if (process.env.MEMORY_TLS_CERT) console.log(`Phone PWA: https://<certificate hostname>:${ports[2]} — use the same Wi-Fi and trust the certificate on the phone.`);
  const exit = await Promise.race(children.map(c => c.exited));
  if (!stopping) await stop(exit || 1);
} catch (error) {
  console.error(error instanceof Error ? error.message : "Demo startup failed");
  await stop(1);
}
