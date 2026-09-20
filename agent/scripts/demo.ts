import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store";
import { Harness } from "../src/harness";
import { serve } from "../src/server";
import { KawkClient } from "../client";
import type { ChatMessage, Gate, LanguageModel } from "../src/contracts";

// Explicit fixture providers: this verifies host behavior, not Jev/model intelligence.
const gate: Gate = {
  async decide({ event }) {
    return {
      remember: event.id === "seen",
      act: event.id === "question",
      route: event.id === "question" ? "start" : "observe",
      targetId: null,
      confidence: 1,
    };
  },
};
const call = (name: string, args: unknown): ChatMessage => ({
  role: "assistant",
  content: null,
  tool_calls: [
    {
      id: crypto.randomUUID(),
      type: "function",
      function: { name, arguments: JSON.stringify(args) },
    },
  ],
});
const model: LanguageModel = {
  async complete(messages) {
    const trigger = JSON.parse(messages[1]!.content!);
    const last = messages.at(-1)!;
    let message: ChatMessage;
    if (trigger.mode === "memory")
      message =
        last.role === "tool"
          ? call("finish", {
              text: "Saved source-backed memory",
              refs: [{ eventId: "seen", revision: 0 }],
              notify: false,
              confidence: 1,
            })
          : call("remember", {
              key: "keys",
              text: "Keys seen on desk",
              kind: "episode",
              refs: [{ eventId: "seen", revision: 0 }],
            });
    else
      message =
        last.role === "tool"
          ? call("finish", {
              text: "Your keys were last seen on the desk.",
              refs: [{ eventId: "seen", revision: 0 }],
              notify: true,
              confidence: 1,
            })
          : call("search_memory", { query: "keys" });
    return { message, tokens: 1 };
  },
};
const dir = await mkdtemp(join(tmpdir(), "kawk-demo-")),
  store = new Store(join(dir, "demo.sqlite"));
const h = new Harness({ store, gate, model, tickMs: 10 });
h.start();
const server = serve(h, {
  token: "fixture-only-token-for-local-demo-123456",
  owner: "fixture-wearer",
  port: 0,
});
const client = new KawkClient(server.url, "fixture-only-token-for-local-demo-123456");
try {
  const now = Date.now(),
    base = {
      deviceId: "fixture",
      streamId: "fixture",
      revision: 0,
      final: true,
      sourceStart: now,
      sourceEnd: now,
      confidence: 1,
      speakerId: null,
      personIds: [],
      provenance: "synthetic-demo",
    };
  await client.send([{ ...base, id: "seen", kind: "observation", text: "Keys on the desk" }]);
  const limit = Date.now() + 5000;
  while (!store.search("fixture-wearer", "keys").memories.length) {
    if (Date.now() > limit) throw new Error("Memory demo timed out");
    await Bun.sleep(20);
  }
  await client.send([
    { ...base, id: "question", kind: "transcript", text: "Where did I leave my keys?" },
  ]);
  const abort = AbortSignal.timeout(5000);
  for await (const notification of client.watch(abort)) {
    console.log(
      JSON.stringify({
        fixture: true,
        notification: notification.text,
        evidence: notification.refs,
      }),
    );
    await client.ack(notification.id);
    break;
  }
  if (!store.tasks().some((t) => t.mode === "assist" && t.status === "completed"))
    throw new Error("Answer demo failed");
  console.log(
    "PASS: quiet memory -> Jev fixture trigger -> retrieval -> one acknowledged notification; daemon remained running.",
  );
} finally {
  await server.stop();
  await h.stop();
  store.close();
  await rm(dir, { recursive: true, force: true });
}
