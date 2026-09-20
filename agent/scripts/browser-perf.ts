import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Harness } from "../src/harness";
import { Store } from "../src/store";
import { Jev } from "../src/jev";
import { createModels } from "../src/providers";
import { LocalRunner } from "../src/runner";
import { serve } from "../src/server";
import { KawkClient } from "../client";
import { Telemetry, type TelemetryEvent } from "../src/telemetry";
import { ACTIVE, type PerceptionEvent } from "../src/contracts";
import { browserSite, salesCsv } from "../test/fixtures/browser-site";

if (!process.argv.includes("--live"))
  throw new Error(
    "Use --live for actual OpenAI/Jev agent tasks; optional --only files,upload,roundtrip,form,recovery,public,location",
  );
const dir = resolve("data/browser-perf", new Date().toISOString().replaceAll(":", "-"));
mkdirSync(dir, { recursive: true, mode: 0o700 });
const onlyAt = process.argv.indexOf("--only"),
  only = onlyAt < 0 ? null : new Set((process.argv[onlyAt + 1] ?? "").split(","));
const spans: TelemetryEvent[] = [];
const record = (item: unknown) =>
  appendFileSync(join(dir, "trace.jsonl"), JSON.stringify(item) + "\n", { mode: 0o600 });
const models = createModels({
  ...process.env,
  KAWK_MODEL_PROVIDER: "openai",
  BASETEN_API_KEY: undefined,
});
const store = new Store(join(dir, "evidence.sqlite"));
const runner = new LocalRunner();
const harness = new Harness({
  store,
  runner,
  artifactDir: join(dir, "artifacts"),
  transcriptDir: join(dir, "transcripts"),
  browserInteraction: true,
  timeZone: "America/Toronto",
  gate: new Jev({ apiKey: process.env.TYPESAFE_API_KEY!, fetch: async (url, init) => {
    const response = await fetch(url, init);
    record({ type: "jev.exchange", at: Date.now(), request: JSON.parse(String(init?.body)), status: response.status, response: await response.clone().json() });
    return response;
  } }),
  telemetry: new Telemetry((e) => {
    spans.push(e);
    record({ type: "telemetry", ...e });
  }),
  model: {
    async complete(messages, tools, signal) {
      record({ type: "model.request", at: Date.now(), messages });
      const result = await models.model.complete(messages, tools, signal);
      record({
        type: "model.response",
        at: Date.now(),
        message: result.message,
        diagnostics: result.diagnostics,
      });
      return result;
    },
  },
});
const site = browserSite();
type Case = {
  id: string;
  prompt: string;
  tools: string[];
  files?: string[];
  verify: (files: Record<string, string>, answer: string) => void;
};
const assert = (ok: unknown, message: string) => {
  if (!ok) throw new Error(message);
};
const report = (text: string) => {
  const value = JSON.parse(text);
  assert(Math.abs(value.total - 94.4) < 0.001, "Incorrect calculated total");
  assert(value.largestLineItem === "keyboard", "Incorrect largest line item");
};
const cases: Case[] = [
  {
    id: "files",
    prompt: `Create sales.csv with these exact contents:\n${salesCsv}\nUse code to calculate total quantity*price and the item with the largest line total. Save report.json with keys total (number) and largestLineItem (item name), export the JSON file for me, and tell me the total.`,
    tools: ["write_file", "run_code", "poll_process", "export_file"],
    files: ["report.json"],
    verify: (f) => report(f["report.json"]!),
  },
  {
    id: "upload",
    prompt: `Use the browser to upload two files at ${site.url}/upload. Create names.csv containing exactly "name\\nAda\\nMina\\n" (real newlines), and notes.txt containing exactly "Demo upload only.". Set project to multi-upload and category to Research. Submit the form and confirm the site's receipt.`,
    tools: ["browser_goto", "write_file", "browser_upload", "browser_select", "browser_click"],
    verify: () => {
      const row = site.uploads.find((u) => u.project === "multi-upload");
      assert(
        row?.category === "Research" && row.files.length === 2,
        "Multipart form did not arrive",
      );
      assert(
        row!.files.some((f) => f.name === "names.csv" && f.text === "name\nAda\nMina\n"),
        "CSV upload bytes differ",
      );
      assert(
        row!.files.some((f) => f.name === "notes.txt" && f.text === "Demo upload only."),
        "Text upload bytes differ",
      );
    },
  },
  {
    id: "roundtrip",
    prompt: `Using the browser, download the sales CSV at ${site.url}/downloads. Use code to calculate total quantity*price and the item with the largest line total. Save summary.json with keys total (number) and largestLineItem (item name). Then use the browser to import that JSON file at ${site.url}/upload under project roundtrip, category Research. Verify the import receipt and export summary.json for me.`,
    tools: ["browser_download", "run_code", "browser_upload", "browser_click", "export_file"],
    files: ["summary.json"],
    verify: (f) => {
      report(f["summary.json"]!);
      const row = site.uploads.find((u) => u.project === "roundtrip");
      assert(row?.category === "Research", "Processed JSON not imported");
      const uploaded = row!.files.find((f) => f.name === "summary.json");
      assert(uploaded, "Missing uploaded JSON");
      report(uploaded!.text);
    },
  },
  {
    id: "form",
    prompt: `Use the browser at ${site.url}/catalog. Search for headphones, compare the results, and reserve the cheapest IN-STOCK pair under $60. Choose Blue, quantity 1, name Demo Tester. Leave the newsletter unchecked. This is a local test site with no actual purchases. Submit the demo reservation and tell me its reference and total.`,
    tools: ["browser_goto", "browser_type", "browser_click", "browser_select"],
    verify: (_, answer) => {
      assert(site.reservations.length === 1, "Expected exactly one demo reservation");
      const row = site.reservations[0]!;
      assert(
        row.product === "trail" &&
          row.name === "Demo Tester" &&
          row.color === "Blue" &&
          row.quantity === "1" &&
          !row.newsletter,
        "Wrong submitted reservation fields",
      );
      assert(/DEMO-1/.test(answer) && /49/.test(answer), "Missing actual confirmation");
    },
  },
  {
    id: "recovery",
    prompt: `Test upload recovery in the browser at ${site.url}/upload. Set project recovery. First create bad.txt containing "name\\nAda\\n" and submit it so we exercise rejection. After reading the site's error, correct the file to names.csv with the same content, submit again, and confirm the successful receipt. Do not claim success from just attaching the file.`,
    tools: ["browser_upload", "browser_click"],
    verify: () => {
      assert(site.rejections.includes("recovery"), "Never exercised rejected upload");
      const rows = site.uploads.filter((u) => u.project === "recovery");
      assert(
        rows.length === 1 && rows[0]!.files[0]?.name === "names.csv",
        "Did not recover exactly once",
      );
    },
  },
  {
    id: "public",
    prompt:
      "Use your browser to open https://docs.python.org/3/library/statistics.html and find what the Python statistics documentation says about median versus mean, including median's behavior on even-sized input. Save a concise cited note with an example in statistics-note.md and export the file for me. Use the browser as the source, not a shell HTTP request.",
    tools: ["browser_goto", "write_file", "export_file"],
    files: ["statistics-note.md"],
    verify: (f) => {
      const text = f["statistics-note.md"]!;
      assert(
        /median/i.test(text) && /mean/i.test(text) && /https:\/\/docs.python.org\//.test(text),
        "Missing sourced documentation note",
      );
      assert(/even/i.test(text), "Missing even-sized median behavior");
    },
  },
  {
    id: "location",
    prompt: "hi what is the weather",
    tools: [],
    verify: (_, answer) => {
      assert(/city|location|where|area/i.test(answer), "Did not ask for missing location");
      assert(
        !/Toronto|°|celsius|fahrenheit|overcast/i.test(answer),
        "Invented location/weather from timezone",
      );
    },
  },
];
if (only && [...only].some((id) => !cases.some((c) => c.id === id)))
  throw new Error("Unknown --only case");
const results: Record<string, unknown>[] = [];
async function runCase(spec: Case) {
  const began = Date.now(),
    owner = `browser-${spec.id}`,
    token = crypto.randomUUID() + crypto.randomUUID();
  const api = serve(harness, { owner, token, port: 0 });
  const client = new KawkClient(api.url, token);
  const received: { text: string; at: number; taskId: string }[] = [];
  const abort = new AbortController();
  const stream = (async () => {
    for await (const n of client.watch(abort.signal))
      received.push({ text: n.text, taskId: n.taskId, at: Date.now() });
  })().catch((error) => {
    if (!abort.signal.aborted) record({ type: "sse.error", case: spec.id, message: String(error) });
  });
  const event: PerceptionEvent = {
    id: spec.id,
    revision: 0,
    deviceId: "browser-test",
    streamId: spec.id,
    kind: "transcript",
    final: true,
    sourceStart: began,
    sourceEnd: began,
    text: spec.prompt,
    confidence: 1,
    speakerId: null,
    personIds: [],
    provenance: "synthetic-browser-agent-task",
  };
  console.log(JSON.stringify({ case: spec.id, state: "started" }));
  try {
    await client.send([event]);
    let task = store.tasks(owner)[0];
    while (Date.now() - began < 190000) {
      task = store.tasks(owner).find((t) => !t.parentId);
      if (task && !ACTIVE.includes(task.status)) break;
      const gate = store.one<{ state: string }>("SELECT state FROM gate_jobs WHERE owner=?", owner);
      if (!task && gate && ["done", "failed"].includes(gate.state)) break;
      await Bun.sleep(50);
    }
    await Bun.sleep(250);
    const errors: string[] = [];
    if (!task || !["completed", "abstained"].includes(task.status))
      errors.push(task?.error ?? `Task ${task?.status ?? "not activated"}`);
    const receipts = task
      ? store.all<{ name: string; state: string; args: string; result: string }>(
          "SELECT name,state,args,result FROM receipts WHERE task_id=?",
          task.id,
        )
      : [];
    const names = receipts.filter((r) => r.state === "done").map((r) => r.name);
    for (const name of spec.tools)
      if (!names.includes(name)) errors.push(`Missing actual tool: ${name}`);
    if (spec.id === "location" && names.some((n) => n.startsWith("browser_") || n === "run_code"))
      errors.push("Queried a location-dependent source before learning location");
    const notification = received.find((n) => n.taskId === task?.id);
    if (!notification) errors.push("No user-visible SSE answer");
    const files: Record<string, string> = {};
    if (task && !ACTIVE.includes(task.status)) await runner.close(task.id);
    for (const artifact of store.all<{ id: string; filename: string }>(
      "SELECT id,filename FROM artifacts WHERE owner=? AND deleted=0",
      owner,
    )) {
      const response = await fetch(api.url + "/v1/artifacts/" + artifact.id, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!response.ok) {
        errors.push(`Artifact inaccessible after cleanup: ${artifact.filename}`);
        continue;
      }
      const bytes = await response.arrayBuffer();
      mkdirSync(join(dir, spec.id), { recursive: true });
      writeFileSync(join(dir, spec.id, artifact.filename), Buffer.from(bytes), { mode: 0o600 });
      files[artifact.filename] = new TextDecoder().decode(bytes);
    }
    for (const name of spec.files ?? [])
      if (!files[name]) errors.push(`Missing exported file: ${name}`);
    try {
      spec.verify(files, notification?.text ?? "");
    } catch (e) {
      errors.push(String(e));
    }
    const taskSpans = spans.filter((s) => s.taskId === task?.id);
    const row = {
      case: spec.id,
      passed: errors.length === 0,
      errors,
      elapsedMs: Date.now() - began,
      notificationMs: notification ? notification.at - began : null,
      answer: notification?.text ?? null,
      taskId: task?.id,
      status: task?.status,
      steps: task?.steps,
      tokens: task?.tokens,
      tools: names,
      files: Object.keys(files),
      telemetry: taskSpans,
    };
    results.push(row);
    record({ type: "case.result", ...row, receipts });
    console.log(JSON.stringify({ ...row, telemetry: undefined }));
    writeFileSync(
      join(dir, "report.json"),
      JSON.stringify(
        {
          provider: models.provider,
          model: models.modelName,
          reasoning: models.reasoning,
          baseten: false,
          scope:
            "Actual Jev/OpenAI agent tool choices, real Playwright/files/HTTP/SSE; local synthetic workflow site plus public Python docs. No personal account login, CAPTCHA, actual purchase, or private upload.",
          results,
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );
  } finally {
    abort.abort();
    await stream;
    await api.stop();
  }
}
harness.start();
try {
  const chosen = cases.filter((c) => !only || only.has(c.id));
  for (let i = 0; i < chosen.length; i += 2) await Promise.all(chosen.slice(i, i + 2).map(runCase));
} finally {
  await harness.stop();
  store.close();
  await site.server.stop(true);
}
console.log(
  JSON.stringify({ dir, passed: results.filter((r) => r.passed).length, total: results.length }),
);
if (results.some((r) => !r.passed)) process.exitCode = 1;
