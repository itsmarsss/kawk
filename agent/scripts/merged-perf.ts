import { mkdirSync, appendFileSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { createServer } from "node:net";
import { chromium } from "playwright";
import { Store } from "../src/store";
import { Harness } from "../src/harness";
import { Jev } from "../src/jev";
import { createModels } from "../src/providers";
import { LocalRunner } from "../src/runner";
import { serve } from "../src/server";
import { fileTelemetry } from "../src/telemetry";
import { browserSite } from "../test/fixtures/browser-site";

// Isolated sources, real Node memory/Bun agent HTTP bridge, Jev and OpenAI.
// Camera pixels and spoken text are explicit fixtures, not a hardware accuracy test.
if (!process.argv.includes("--live")) throw new Error("Run with --live to authorize the real API benchmark");
if (!process.env.TYPESAFE_API_KEY || !process.env.OPENAI_API_KEY) throw new Error("Load private agent/.env");
const run = new Date().toISOString().replace(/[:.]/g, "-");
const onlyAt = process.argv.indexOf("--only");
const selected = new Set(onlyAt < 0 ? ["recall", "reminder", "camera", "person", "browser", "cancel"] : process.argv[onlyAt + 1]!.split(","));
if ([...selected].some(name => !["recall", "reminder", "camera", "person", "browser", "cancel"].includes(name))) throw new Error("Unknown benchmark case group");
const dir = resolve("data/merged-perf", run), root = resolve(import.meta.dir, "../..");
mkdirSync(dir, { recursive: true, mode: 0o700 });
const owner = "synthetic-merged-wearer", token = crypto.randomUUID() + crypto.randomUUID();
writeFileSync(join(dir, "client-token"), token, { mode: 0o600 });
const port = await new Promise<number>((ok, fail) => {
  const s = createServer(); s.once("error", fail); s.listen(0, "127.0.0.1", () => {
    const p = (s.address() as { port: number }).port; s.close(() => ok(p));
  });
});
const base = `http://127.0.0.1:${port}`;
const store = new Store(join(dir, "agent.sqlite"));
const decisions: any[] = [], results: any[] = [], deliveries: any[] = [];
const jev = new Jev({ apiKey: process.env.TYPESAFE_API_KEY, model: process.env.KAWK_JEV_MODEL });
const models = createModels({ ...process.env, BASETEN_API_KEY: undefined, KAWK_MODEL_PROVIDER: "openai" });
const harness = new Harness({ store, sceneMemoryUrl: base, gate: {
  async decide(input, signal) { const d = await jev.decide(input, signal); decisions.push({ eventId: input.event.id, at: Date.now(), ...d }); return d; },
  review: (input, signal) => jev.review(input, signal),
}, model: models.model, runner: new LocalRunner(), browserInteraction: true,
  artifactDir: join(dir, "artifacts"), transcriptDir: join(dir, "transcripts"), telemetry: fileTelemetry(join(dir, "telemetry.jsonl")) });
const server = serve(harness, { port: 0, owner, token }); harness.start();
const logs = Bun.file(join(dir, "memory.log"));
const memory = Bun.spawn(["node", "--import", "tsx", "src/main.ts"], { cwd: join(root, "memory"),
  env: { ...process.env, HOST: "127.0.0.1", PORT: String(port), MEMORY_DATA_DIR: join(dir, "memory"),
    KAWK_AGENT_URL: server.url, KAWK_AGENT_TOKEN_FILE: join(dir, "client-token"), MEMORY_SPEECH_BACKEND: "local",
    MEMORY_VISION_CONCURRENCY: "2" }, stdout: logs, stderr: logs });
const abort = new AbortController();
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let cameraLoop: Promise<void> | undefined, feed: Promise<void> | undefined;
let site: ReturnType<typeof browserSite> | undefined;
const record = (value: any) => { appendFileSync(join(dir, "results.jsonl"), JSON.stringify(value) + "\n"); console.log(JSON.stringify(value)); };
async function api(path: string, body?: unknown) {
  const r = await fetch(base + path, { ...(body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }), signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(`${path}: HTTP ${r.status} ${await r.text()}`);
  return await r.json() as any;
}
async function until(fn: () => boolean | Promise<boolean>, ms = 60000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return true; await Bun.sleep(100); }
  return false;
}
async function ask(name: string, text: string, expected: RegExp, ms = 60000) {
  const started = Date.now(); const { eventId } = await api("/api/agent/ask", { text });
  const relatedTasks = () => store.tasks(owner).filter(t => t.createdAt >= started && store.refs("task", t.id).some(r => r.eventId === eventId));
  const matchingDeliveries = () => {
    const ids = new Set(relatedTasks().map(t => t.id));
    return deliveries.filter(n => n.at >= started && ids.has(n.taskId));
  };
  await until(() => matchingDeliveries().some(n => expected.test(n.text)) ||
    relatedTasks().some(t => ["failed", "abstained"].includes(t.status)), ms);
  const related = relatedTasks();
  const delivered = matchingDeliveries();
  const result = { name, eventId, pass: delivered.some(n => expected.test(n.text)),
    e2eMs: delivered.find(n => expected.test(n.text))?.at - started || null,
    decision: decisions.find(d => d.eventId === eventId), tasks: related.map(t => ({ id: t.id, status: t.status, error: t.error, result: t.result })), delivered };
  results.push(result); record(result); return result;
}
try {
  if (!await until(async () => { try { return (await api("/api/health")).ok; } catch { return false; } }, 20000)) throw new Error("Memory did not start");
  const { id: sessionId } = await api("/api/sessions", {});
  feed = (async () => {
    const response = await fetch(base + "/api/agent/events", { signal: abort.signal });
    const reader = response.body!.getReader(); const decoder = new TextDecoder(); let pending = "";
    while (!abort.signal.aborted) {
      const chunk = await reader.read(); if (chunk.done) break;
      pending += decoder.decode(chunk.value, { stream: true });
      let split: number;
      while ((split = pending.indexOf("\n\n")) >= 0) {
        const block = pending.slice(0, split); pending = pending.slice(split + 2);
        const data = block.split("\n").find(l => l.startsWith("data: "));
        if (data && block.includes("event: notification")) deliveries.push({ ...JSON.parse(data.slice(6)), at: Date.now() });
      }
    }
  })().catch(error => { if (!abort.signal.aborted) record({ feedError: String(error) }); });
  const sources = [
    "I put the brass house keys in the blue ceramic bowl beside the kitchen door.",
    "Algorithms 101 class notes: today we studied breadth-first search, its FIFO queue, and shortest paths in unweighted graphs. Homework is exercise seven.",
    "Conversation with William Zeng: we discussed his greenhouse sensor project. The prototype measures humidity and uses a solar panel. We agreed to review it on Friday.",
  ];
  for (let i = 0; i < sources.length; i++) {
    const at = Date.now() - (3 - i) * 3600000;
    await api("/api/transcripts", { sessionId, streamId: "fixture-speech", segmentId: `history-${i}`, revision: 0,
      text: sources[i], isFinal: true, startAt: at, endAt: at + 5000, receivedAt: Date.now(), words: [], speakerId: null, timing: "approximate" });
  }
  await until(() => store.all("SELECT id FROM evidence").length >= 3);
  if (selected.has("recall")) {
  await ask("keys-cross-hours", "Where did I put my brass house keys? Search my recorded history.", /blue.*bowl|bowl.*kitchen/i);
  await ask("class-review", "Review my Algorithms 101 class notes from today and tell me the homework.", /breadth.first|exercise seven|exercise 7/i);
  await ask("person-notes", "What did William Zeng and I discuss in our recorded conversation?", /greenhouse|humidity|solar panel/i);
  }
  if (selected.has("reminder")) {
  const reminderStart = Date.now();
  await ask("schedule-reminder", "Remind me in twenty seconds to stretch my shoulders.", /remind|twenty|20 seconds|stretch/i, 25000);
  await ask("parallel-code", "Use code to calculate the sum of squares of integers 1 through 100 and tell me the result.", /338[,. ]?350/);
  await until(() => deliveries.some(n => n.at >= reminderStart + 18000 && /stretch.*shoulder|shoulder.*stretch/i.test(n.text)), 35000);
  const reminderDelivery = deliveries.find(n => n.at >= reminderStart + 18000 && /stretch.*shoulder|shoulder.*stretch/i.test(n.text));
  const wake = { name: "reminder-wake", pass: !!reminderDelivery, e2eMs: reminderDelivery ? reminderDelivery.at - reminderStart : null,
    turns: store.tasks(owner).filter(t => t.createdAt >= reminderStart).map(t => ({ status: t.status, mode: t.mode, createdAt: t.createdAt })) };
  results.push(wake); record(wake);
  }

  if (selected.has("person")) {
    const faces = (present: boolean) => api("/api/agent/faces", { sessionId, evidence: {
      frameId: crypto.randomUUID(), streamId: "fixture-live-face", capturedAt: Date.now(), status: "ready", width: 640, height: 480,
      faces: present ? [{ trackId: "fixture-track", personId: "fixture-kenny-gallery", name: "Kenny", similarity: .9,
        box: [100, 100, 200, 250], identityStatus: "confirmed" }] : [] } });
    await faces(true); await Bun.sleep(1000); await faces(false);
    await ask("person-reminder-set", "Next time I see Kenny, remind me to tell him about Vitamin B.", /remind|Kenny|Vitamin B/i);
    const at = Date.now(); await faces(true);
    await until(() => deliveries.some(n => n.at >= at && /Vitamin B/i.test(n.text)), 30000);
    const delivery = deliveries.find(n => n.at >= at && /Vitamin B/i.test(n.text));
    const result = { name: "person-appearance", pass: !!delivery, e2eMs: delivery ? delivery.at - at : null, delivery };
    results.push(result); record(result);
  }
  if (selected.has("browser")) {
    site = browserSite();
    const result = await ask("browser-files", `Use the browser to download the sales CSV from ${site.server.url}downloads, calculate quantity times price for each row and the grand total using code, create a summary CSV, then upload it through ${site.server.url}upload under project merged-demo and category Research. Tell me the total and the import receipt.`, /IMPORT-\d/i, 100000);
    const received = site.uploads.find(u => u.project === "merged-demo");
    const verification = { name: "browser-server-receipt", pass: !!received && received.category === "Research" && received.files.some(f => /94\.4/.test(f.text)), received };
    results.push(verification); record(verification);
  }
  if (selected.has("cancel")) {
    const at = Date.now();
    const { eventId } = await api("/api/agent/ask", { text: "Run a Python program that waits for thirty seconds, then prints FINISHED. Tell me when it finishes." });
    let taskId: string | undefined;
    await until(() => {
      taskId = store.tasks(owner).find(t => store.refs("task", t.id).some(r => r.eventId === eventId))?.id;
      return !!taskId && store.all("SELECT id FROM receipts WHERE task_id=?", taskId).length > 0;
    }, 20000);
    const cancelAt = Date.now();
    if (taskId) await api(`/api/agent/tasks/${taskId}/cancel`, {});
    await until(() => !!taskId && store.task(taskId)?.status === "cancelled", 3000);
    const result = { name: "cancel-running-code", pass: !!taskId && store.task(taskId)?.status === "cancelled", e2eMs: Date.now() - cancelAt, startToCancelMs: cancelAt - at };
    results.push(result); record(result);
  }

  let sequence = 0;
  if (selected.has("camera")) {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 640, height: 480 } });
  await page.setContent('<html><body style="margin:40px;font:48px sans-serif;background:white;color:black"><p>ROOM 314</p><p>Robotics lab</p><p>Entrance on the left</p></body></html>');
  const jpegBase64 = (await page.screenshot({ type: "jpeg" })).toString("base64");
  cameraLoop = (async () => {
    while (!abort.signal.aborted) {
      const { commands } = await api(`/api/agent/commands?sessionId=${sessionId}`);
      for (const command of commands) {
        if (!(await api(`/api/agent/commands/${command.id}/claim`, { sessionId })).claimed) continue;
        const id = `fixture-camera-${++sequence}`, capturedAt = Date.now();
        await api("/api/captures", { id, sessionId, sequence, capturedAt, requestId: command.id, width: 640, height: 480,
          jpegBase64, audioStatus: "unavailable", faces: { frameId: id, streamId: "fixture-faces", capturedAt, status: "ready", width: 640, height: 480, faces: [] } });
        await api(`/api/agent/commands/${command.id}/result`, { sessionId, captureId: id });
      }
      await Bun.sleep(200);
    }
  })().catch(error => { if (!abort.signal.aborted) record({ cameraError: String(error) }); });
  await Bun.sleep(300);
  await ask("fresh-camera", "Read the room number and lab name on the sign I am looking at right now.", /314.*robotics|robotics.*314/is, 80000);
  }
  record({ summary: { dir, passed: results.filter(r => r.pass).length, total: results.length, captureCount: sequence,
    pendingBridge: (await api("/api/agent/status")).bridge } });
  if (results.some(r => !r.pass)) process.exitCode = 1;
} finally {
  abort.abort(); await Promise.allSettled([feed, cameraLoop]); await browser?.close(); await site?.server.stop(true);
  memory.kill("SIGTERM");
  const force = setTimeout(() => { if (memory.exitCode === null) memory.kill("SIGKILL"); }, 15000);
  await memory.exited; clearTimeout(force); await server.stop(); await harness.stop(); store.close();
}
