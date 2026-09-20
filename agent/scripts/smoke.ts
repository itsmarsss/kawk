import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Harness } from "../src/harness";
import { Store } from "../src/store";
import { createModels } from "../src/providers";
import { Jev } from "../src/jev";
import { serve } from "../src/server";
import { KawkClient } from "../client";
import type { PerceptionEvent } from "../src/contracts";

// Default: configured real model, fixture gate. --live-jev also exercises the
// real trigger, configured provider fallback and independent delivery review.
const liveJev = process.argv.includes("--live-jev");
if (liveJev && !process.env.TYPESAFE_API_KEY)
  throw new Error("TYPESAFE_API_KEY is required for --live-jev");
const models = createModels({
  ...process.env,
  ...(!liveJev ? { BASETEN_API_KEY: undefined } : {}),
});
let lastProvider: string = models.provider;
const dir = await mkdtemp(join(tmpdir(), "kawk-model-smoke-"));
const store = new Store(join(dir, "test.sqlite"));
const h = new Harness({
  store,
  model: {
    async complete(messages, tools, signal) {
      const result = await models.model.complete(messages, tools, signal);
      lastProvider = result.diagnostics?.provider ?? models.provider;
      return result;
    },
  },
  gate: liveJev
    ? new Jev({ apiKey: process.env.TYPESAFE_API_KEY!, model: process.env.KAWK_JEV_MODEL })
    : {
        async decide() {
          return { act: true, remember: false, route: "start", targetId: null, confidence: 1 };
        },
      },
  maxSteps: 6,
  maxTokens: 80000,
  taskTimeout: 150000,
});
const source: PerceptionEvent = {
  id: "seen",
  deviceId: "synthetic",
  streamId: "synthetic",
  revision: 0,
  kind: "observation",
  final: true,
  sourceStart: Date.now() - 300000,
  sourceEnd: Date.now() - 300000,
  text: "The wearer's blue keys were observed on the desk beside the lamp.",
  confidence: 0.99,
  speakerId: null,
  personIds: [],
  provenance: "explicit-smoke-fixture",
};
store.ingest("smoke", source, false);
const token = crypto.randomUUID() + crypto.randomUUID();
h.start();
const server = serve(h, { owner: "smoke", token, port: 0 });
const client = new KawkClient(server.url, token);
try {
  await client.send([
    {
      ...source,
      id: "question",
      kind: "transcript",
      sourceStart: Date.now(),
      sourceEnd: Date.now(),
      text: "Where did I leave my blue keys?",
    },
  ]);
  const started = Date.now();
  while (Date.now() - started < 150000) {
    const task = store.tasks()[0];
    const endedGate = store.one("SELECT 1 FROM gate_jobs WHERE state IN ('done','failed')");
    const notifications = await client.notifications();
    if (notifications.notifications.length) {
      const n = notifications.notifications[0]!;
      if (!/desk/i.test(n.text) || !n.refs.some((r) => r.eventId === "seen"))
        throw new Error("Answer did not cite the stored observation");
      await client.ack(n.id);
      console.log(
        JSON.stringify(
          {
            provider: lastProvider,
            gate: liveJev ? "live Jev activation and delivery review" : "fixture",
            answer: n.text,
            refs: n.refs,
            acknowledged: true,
            turns: store.tasks().map((t) => t.steps),
          },
          null,
          2,
        ),
      );
      break;
    }
    if (!task && endedGate) throw new Error("Jev did not start the expected question task");
    if (task && ["failed", "abstained", "cancelled", "completed"].includes(task.status))
      throw new Error(`No notification: ${task.status} ${task.error ?? ""}`);
    await Bun.sleep(250);
  }
  if (store.one<{ n: number }>("SELECT COUNT(*) n FROM notifications WHERE state='acked'")!.n !== 1)
    throw new Error("Smoke timed out");
} finally {
  await server.stop();
  await h.stop();
  store.close();
  await rm(dir, { recursive: true, force: true });
}
