import { test, expect } from "bun:test";
import { Store } from "../src/store";
import { Harness } from "../src/harness";
import { TaskContext } from "../src/task-context";
import { Capture } from "../src/capture";
import { KnowledgeGraph } from "../src/knowledge";
import { PushDelivery } from "../src/push";
import { Jev } from "../src/jev";
import { refOf } from "../src/contracts";
import { event, model, call, decision, until } from "./helpers";

const silent = {
  async decide() {
    return decision({ remember: false, act: false, route: "observe" });
  },
};
test("related due reminders wake one LLM turn, do not sleep or directly notify, and survive source invalidation", async () => {
  let now = Date.now(),
    turns = 0;
  const s = new Store(":memory:", () => now);
  const h = new Harness({
    store: s,
    gate: silent,
    tickMs: 5,
    model: model((messages) => {
      turns++;
      const wake = JSON.parse(messages[1]!.content!).trigger;
      expect(wake.provenance).toBe("reminder-wake");
      expect(wake.text).toContain("Vitamin B");
      expect(wake.text).toContain("trip");
      return call("finish", {
        text: "Ask Kenny about Vitamin B and his trip.",
        refs: [refOf(wake)],
        confidence: 0.95,
        notify: true,
      });
    }),
  });
  try {
    const source = event("r", "Tell Kenny about Vitamin B when I see him", {
      sourceStart: now,
      sourceEnd: now,
    });
    s.ingest("o", source, false);
    const task = s.createTask({
      owner: "o",
      goal: source.text,
      refs: [refOf(source)],
      capabilities: [],
    });
    s.setTask(task.id, "completed");
    for (const [id, text] of [
      ["a", "Vitamin B"],
      ["b", "his trip"],
    ])
      h.reminders.create(task, id!, { text: text!, personId: "kenny", refs: [refOf(source)] });
    h.start();
    now += 1000;
    h.ingest(
      "o",
      event("seen", "Kenny appeared", {
        kind: "observation",
        sourceStart: now,
        sourceEnd: now,
        personIds: ["kenny"],
        timing: { method: "capture", clockSessionId: "test", uncertaintyMs: 40 },
      }),
    );
    expect(s.notifications("o")).toHaveLength(0);
    await until(() => s.notifications("o").length === 1);
    h.reminders.fire();
    expect(turns).toBe(1);
    expect(s.all("SELECT * FROM reminders WHERE state='delivered'")).toHaveLength(2);
    expect(s.notifications("o")[0]!.expiresAt - now).toBe(86400000);
    s.deleteEvidence("o", source.id);
    expect(s.notifications("o")).toHaveLength(0);
  } finally {
    await h.stop();
    s.close();
  }
});

test("two independent parents run concurrently and receive current shared peer state", async () => {
  const s = new Store(":memory:");
  let started = 0,
    peak = 0,
    inFlight = 0;
  let release!: () => void;
  const blocked = new Promise<void>((r) => (release = r));
  const h = new Harness({
    store: s,
    gate: {
      async decide() {
        return decision();
      },
    },
    tickMs: 5,
    model: model(async (messages) => {
      started++;
      inFlight++;
      peak = Math.max(peak, inFlight);
      expect(messages[0]!.content).toContain("FRESH SHARED CONTEXT");
      if (started === 1) await blocked;
      else release();
      inFlight--;
      return call("finish", { text: "", refs: [], confidence: 1, notify: false });
    }),
  });
  try {
    h.start();
    h.ingest("o", event("one", "Long task"));
    h.ingest("o", event("two", "Quick task"));
    await until(() => s.tasks().filter((t) => t.status === "abstained").length === 2);
    expect(peak).toBe(2);
  } finally {
    release();
    await h.stop();
    s.close();
  }
});

test("compaction checkpoints complete history and keeps exact final tool pairing; deletion purges checkpoints", async () => {
  const s = new Store(":memory:");
  try {
    const e = event("source", "Keys were on the desk");
    s.ingest("o", e, false);
    const t = s.createTask({ owner: "o", goal: "Find keys", refs: [refOf(e)], capabilities: [] });
    const messages = [
      { role: "system" as const, content: "sys" },
      { role: "user" as const, content: "trigger" },
      { role: "assistant" as const, content: "x".repeat(5000) },
      call("read_evidence", { id: e.id }, "00000000-0000-0000-0000-000000000001"),
      {
        role: "tool" as const,
        tool_call_id: "00000000-0000-0000-0000-000000000001",
        content: "source revision0",
      },
    ];
    const context = new TaskContext(
      s,
      model(() => ({
        role: "assistant",
        content: "Keys last seen on desk; source revision0. Still need to finish.",
      })),
      500,
    );
    const compacted = await context.compact(t, messages, new AbortController().signal);
    expect(compacted.at(-1)?.tool_call_id).toBe("00000000-0000-0000-0000-000000000001");
    expect(compacted.at(-2)?.tool_calls?.[0]?.id).toBe("00000000-0000-0000-0000-000000000001");
    expect(s.all("SELECT * FROM task_checkpoints")).toHaveLength(1);
    s.deleteEvidence("o", e.id);
    expect(s.all("SELECT * FROM task_checkpoints")).toHaveLength(0);
  } finally {
    s.close();
  }
});

test("Jev sees previous speech gap across hours and local dates in delivery review", async () => {
  const now = Date.now(),
    previous = {
      ...event("old", "Class was yesterday", {
        sourceStart: now - 7200000,
        sourceEnd: now - 7100000,
      }),
      owner: "o",
      receivedAt: now - 7000000,
    };
  let state: any;
  const jev = new Jev({
    apiKey: "test",
    fetch: async (_u, init) => {
      state = JSON.parse(JSON.parse(String(init?.body)).state);
      return Response.json({
        model: "jev-1.13.0",
        answers: {
          verdict: {
            type: "choice",
            choice: "supported",
            confidence: 0.9,
            probabilities: { supported: 0.9, unsupported: 0.1, uncertain: 0 },
          },
        },
      });
    },
  });
  await jev.review(
    {
      goal: "Today's class?",
      text: "Class was yesterday",
      evidence: [previous],
      now,
      timeZone: "America/Toronto",
    },
    new AbortController().signal,
  );
  expect(state.sources[0].sourceStart).toBe(new Date(previous.sourceStart).toISOString());
  expect(state.sources[0].ageMs).toBe(7100000);
  expect(state.timeZone).toBe("America/Toronto");
  const s = new Store(":memory:", () => now);
  try {
    const { owner, receivedAt, ...oldEvent } = previous;
    s.ingest("o", oldEvent, false);
    const fresh = {
      ...event("new", "What was said?", { sourceStart: now, sourceEnd: now }),
      owner: "o",
      receivedAt: now,
    };
    expect(s.previousTranscript("o", fresh)?.id).toBe("old");
  } finally {
    s.close();
  }
});

const embedding = (index: number) => Array.from({ length: 512 }, (_, i) => (i === index ? 1 : 0));
const jpeg = Buffer.from([255, 216, 1, 2, 255, 217]).toString("base64");
test("delayed introduction enrolls source-time face, preserves UUID on rename, rejects target replacement", async () => {
  let now = Date.now(),
    face = 0;
  const s = new Store(":memory:", () => now),
    graph = new KnowledgeGraph(s);
  const capture = new Capture(s, graph, (owner, e) => s.ingest(owner, e, false), {
    detect: async () => [
      { box: [0, 0, 100, 100], det_score: 0.98, embedding_512: embedding(face) },
    ],
  });
  const frame = async (id: string, time: number) => {
    capture.accept("o", {
      id,
      deviceId: "test-device",
      streamId: "camera",
      capturedAt: time,
      uncertaintyMs: 30,
      imageBase64: jpeg,
    });
    await until(() => capture.status().processing === 0);
  };
  try {
    await frame("a", now);
    await frame("b", now + 500);
    const speech = event("intro", "Hi, I'm Kenny", {
      sourceStart: now,
      sourceEnd: now + 500,
      timing: { method: "capture", clockSessionId: "test", uncertaintyMs: 30 },
    });
    s.ingest("o", speech, false);
    now += 10000;
    face = 1;
    await frame("replacement", now);
    const candidate = capture.identify("o", speech.id);
    expect(candidate.personId).toBeNull();
    const enrolled = capture.enroll("o", speech.id, "Kenny", candidate.face.trackId);
    expect(capture.people("o")[0]!.id).toBe(enrolled.id);
    face = 0;
    now += 1000;
    await frame("c", now);
    await frame("d", now + 500);
    await frame("e", now + 900);
    const correction = event("rename", "Actually, my name is Kenneth", {
      sourceStart: now + 500,
      sourceEnd: now + 900,
      timing: { method: "capture", clockSessionId: "test", uncertaintyMs: 30 },
    });
    s.ingest("o", correction, false);
    const rename = capture.identify("o", correction.id);
    const renamed = capture.enroll("o", correction.id, "Kenneth", rename.face.trackId);
    expect(renamed.id).toBe(enrolled.id);
    face = 1;
    now += 1000;
    await frame("f", now);
    const bad = event("ambiguous", "My name is X", {
      sourceStart: now - 1000,
      sourceEnd: now,
      timing: { method: "capture", clockSessionId: "test", uncertaintyMs: 30 },
    });
    s.ingest("o", bad, false);
    expect(() => capture.identify("o", bad.id)).toThrow();
    s.deleteEvidence("o", speech.id);
    expect(capture.people("o")).toHaveLength(0);
  } finally {
    await capture.stop();
    s.close();
  }
});

test("push retries transient failures, deduplicates success and removes gone subscriptions", async () => {
  let now = Date.now(),
    calls = 0;
  const s = new Store(":memory:", () => now);
  const push = new PushDelivery(s, { publicKey: "test", privateKey: "test" }, async () => {
    calls++;
    if (calls === 1) throw { statusCode: 503 };
  });
  try {
    const e = event("need", "Hi");
    s.ingest("o", e, false);
    const t = s.createTask({ owner: "o", goal: "hi", refs: [refOf(e)], capabilities: [] });
    s.notify(t, "Useful update", [refOf(e)], 60000);
    push.subscribe("o", {
      endpoint: "https://push.example/a",
      keys: { auth: "1234567890123456", p256dh: "1234567890123456" },
    });
    await push.flush();
    expect(calls).toBe(1);
    await push.flush();
    expect(calls).toBe(1);
    now += 3000;
    await push.flush();
    await push.flush();
    expect(calls).toBe(2);
    const gone = new PushDelivery(s, { publicKey: "test", privateKey: "test" }, async () => {
      throw { statusCode: 410 };
    });
    gone.subscribe("o", {
      endpoint: "https://push.example/b",
      keys: { auth: "1234567890123456", p256dh: "1234567890123456" },
    });
    await gone.flush();
    expect(s.all("SELECT * FROM push_subscriptions")).toHaveLength(1);
  } finally {
    s.close();
  }
});

test("free-form reminder abstention is reconciled without stopping the scheduler", () => {
  let now = Date.now();
  const s = new Store(":memory:", () => now);
  const h = new Harness({
    store: s,
    gate: silent,
    model: model(() => ({ role: "assistant", content: "Nothing to add" })),
  });
  try {
    const e = event("r", "Remind me", { sourceStart: now, sourceEnd: now });
    s.ingest("o", e, false);
    const origin = s.createTask({ owner: "o", goal: e.text, refs: [refOf(e)], capabilities: [] });
    s.setTask(origin.id, "completed");
    h.reminders.create(origin, "r", { text: "Stretch", dueAt: now + 100, refs: [refOf(e)] });
    now += 101;
    h.reminders.fire();
    const row = s.one<{ task_id: string }>("SELECT task_id FROM reminder_wakes")!;
    s.setTask(row.task_id, "abstained", "Nothing to add");
    expect(() => h.reminders.fire()).not.toThrow();
    expect(s.one<{ state: string }>("SELECT state FROM reminders")?.state).toBe("resolved");
  } finally {
    s.close();
  }
});
