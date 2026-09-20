import { afterEach, expect, test } from "bun:test";
import { Store } from "../src/store";
import { Harness } from "../src/harness";
import { event, decision, gate, model, call, until } from "./helpers";
import { refOf, type ChatMessage } from "../src/contracts";
import { Telemetry, type TelemetryEvent } from "../src/telemetry";
const instances: Harness[] = [];
const setup = (options: Partial<ConstructorParameters<typeof Harness>[0]> = {}) => {
  const h = new Harness({
    store: new Store(":memory:"),
    gate,
    model: model(() => call("finish", { text: "", refs: [], notify: false, confidence: 0 })),
    tickMs: 5,
    ...options,
  });
  instances.push(h);
  h.start();
  return h;
};
afterEach(async () => {
  for (const h of instances.splice(0)) {
    await h.stop();
    h.store.close();
  }
});

test("always-on service remembers quietly then answers a natural question from evidence", async () => {
  let turns = 0;
  const h = setup({
    gate: {
      async decide({ event }) {
        return event.id === "seen"
          ? decision({ remember: true, act: false, route: "observe" })
          : decision();
      },
    },
    model: model((messages) => {
      turns++;
      const first = JSON.parse(messages.find((m) => m.role === "user")!.content!);
      const last = messages.at(-1)!;
      if (first.mode === "memory") {
        if (last.role !== "tool")
          return call("remember", {
            key: "keys-location",
            text: "Keys were seen on the desk",
            kind: "episode",
            refs: [{ eventId: "seen", revision: 0 }],
          });
        return call("finish", {
          text: "Memory saved",
          refs: [{ eventId: "seen", revision: 0 }],
          notify: false,
          confidence: 0.9,
        });
      }
      if (last.role !== "tool") return call("search_memory", { query: "keys" });
      const result = JSON.parse(last.content!);
      expect(result.evidence.some((e: any) => e.id === "seen")).toBe(true);
      return call("finish", {
        text: "Your keys were last seen on the desk.",
        refs: [{ eventId: "seen", revision: 0 }],
        notify: true,
        confidence: 0.95,
      });
    }),
  });
  const seen = event("seen", "Keys are on the desk", { kind: "observation" });
  h.ingest("owner", seen);
  await until(() => h.store.tasks().some((t) => t.status === "completed"));
  expect(h.store.notifications("owner")).toEqual([]);
  h.ingest("owner", event("question", "Where did I leave my keys?"));
  await until(() => h.store.notifications("owner").length === 1);
  const n = h.store.notifications("owner")[0]!;
  expect(n.text).toContain("desk");
  h.store.ack("owner", n.id);
  const count = turns;
  await Bun.sleep(40);
  expect(turns).toBe(count);
  expect(h.status().running).toBe(true);
});
test("duplicate events start one task and partials start none", async () => {
  const h = setup(),
    e = event("e", "Where are keys?");
  h.ingest("owner", { ...e, final: false });
  await Bun.sleep(20);
  expect(h.store.tasks()).toHaveLength(0);
  const final = { ...e, revision: 1 };
  h.ingest("owner", final);
  h.ingest("owner", final);
  await until(() => h.store.tasks().some((t) => t.status === "abstained"));
  expect(h.store.tasks()).toHaveLength(1);
});
test("correction while model is running prevents a stale notification", async () => {
  let release!: (m: ChatMessage) => void;
  const h = setup({
    model: model(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    ),
    gate: {
      async decide({ event }) {
        return event.revision === 0
          ? decision()
          : decision({ act: false, remember: false, route: "observe" });
      },
    },
  });
  const e = event("e", "keys on desk");
  h.ingest("owner", e);
  await until(() => !!release);
  h.ingest("owner", { ...e, revision: 1, text: "keys on shelf" });
  release(call("finish", { text: "on desk", refs: [refOf(e)], notify: true, confidence: 1 }));
  await until(() => h.status().activeTurns === 0);
  expect(h.store.notifications("owner")).toEqual([]);
  expect(h.store.tasks()[0]?.status).toBe("cancelled");
});
test("Jev failure retains evidence and queues bounded retry without agent work", async () => {
  const h = setup({
    gate: {
      async decide() {
        throw new Error("rate limited");
      },
    },
  });
  h.ingest("owner", event("e", "Where are keys?"));
  await until(() => !!h.store.one("SELECT 1 FROM gate_jobs WHERE attempts=1 AND state='queued'"));
  expect(h.store.latest("owner", "e")).not.toBeNull();
  expect(h.store.tasks()).toHaveLength(0);
});
test("subagents persist and resume the waiting parent without sending their own notification", async () => {
  const events: TelemetryEvent[] = [];
  const h = setup({
    telemetry: new Telemetry((e) => events.push(e)),
    model: model((messages) => {
      const system = messages[0]!.content!,
        last = messages.at(-1)!;
      if (system.includes("You are a subagent"))
        return call("finish", {
          text: "Found keys on desk",
          refs: [{ eventId: "e", revision: 0 }],
          notify: false,
          confidence: 0.9,
        });
      if (messages.some((m) => m.role === "user" && m.content?.includes('"subagent":')))
        return call("finish", {
          text: "Keys on desk",
          refs: [{ eventId: "e", revision: 0 }],
          notify: true,
          confidence: 0.9,
        });
      if (last.role === "tool") return call("wait_for_subagents", {});
      return call("spawn_subagent", {
        goal: "Locate keys",
        context: "Read e revision 0; keys are on desk",
      });
    }),
  });
  h.ingest("owner", event("e", "Where are the keys on my desk?"));
  await until(() => h.store.notifications("owner").length === 1, 5000);
  expect(h.store.tasks().filter((t) => t.parentId)).toHaveLength(1);
  expect(h.store.tasks().every((t) => t.status === "completed")).toBe(true);
  const tasks = h.store.tasks();
  for (const task of tasks) {
    const spans = events.filter((e) => e.name === "model.end" && e.taskId === task.id);
    expect(spans.length).toBeGreaterThan(0);
    expect(spans.every((e) => e.rootId === task.rootId)).toBe(true);
  }
  expect(events.filter((e) => e.name === "notification.created")).toHaveLength(1);
  expect(JSON.stringify(events)).not.toContain("Keys on desk");
});
test("free-form model text is not automatically pushed", async () => {
  const h = setup({ model: model(() => ({ role: "assistant", content: "unsupported guess" })) });
  h.ingest("owner", event("e", "Where are keys?"));
  await until(() => h.store.tasks().some((t) => t.status === "abstained"));
  expect(h.store.notifications("owner")).toEqual([]);
});

test("steering received during inference discards the stale plan", async () => {
  let release!: (m: ChatMessage) => void;
  let turns = 0;
  const h = setup({
    model: model((messages) => {
      if (++turns === 1)
        return new Promise((resolve) => {
          release = resolve;
        });
      expect(messages.at(-1)?.content).toBe("Answer using the updated context");
      return call("finish", { text: "", refs: [], notify: false, confidence: 0 });
    }),
  });
  h.ingest("owner", event("e", "Keys on desk"));
  await until(() => !!release);
  h.store.message(h.store.tasks()[0]!.id, "Answer using the updated context");
  release(
    call("finish", {
      text: "Stale answer",
      refs: [{ eventId: "e", revision: 0 }],
      notify: true,
      confidence: 1,
    }),
  );
  await until(() => h.store.tasks()[0]?.status === "abstained");
  expect(h.store.notifications("owner")).toHaveLength(0);
  expect(turns).toBe(2);
});

test("a one-turn budget permits its final tool and prevents another model call", async () => {
  const h = setup({
    maxSteps: 1,
    model: model(() => call("finish", { text: "Done", refs: [], notify: false, confidence: 1 })),
  });
  h.ingest("owner", event("e", "Question"));
  await until(() => h.store.tasks()[0]?.status === "completed");
  expect(h.store.tasks()[0]?.steps).toBe(1);
});

test("production delivery review can suppress an unsupported model answer", async () => {
  let reviews = 0;
  const h = setup({
    gate: {
      ...gate,
      async review() {
        reviews++;
        return false;
      },
    },
    model: model(() =>
      call("finish", {
        text: "Unsupported confident answer",
        refs: [{ eventId: "e", revision: 0 }],
        notify: true,
        confidence: 1,
      }),
    ),
  });
  h.ingest("owner", event("e", "Where are keys?"));
  await until(() => h.store.tasks()[0]?.status === "completed");
  expect(reviews).toBe(2);
  expect(h.store.notifications("owner")).toHaveLength(0);
});

test("scheduled followups re-enter Jev once and source deletion purges the derived event", async () => {
  let now = Date.now(),
    decisions = 0;
  const s = new Store(":memory:", () => now);
  const h = setup({
    store: s,
    gate: {
      async decide() {
        decisions++;
        return decision({ act: false, remember: false, route: "observe" });
      },
    },
  });
  const e = event("e", "Ask about the trip");
  s.ingest("owner", e, false);
  const task = s.createTask({ owner: "owner", goal: e.text, refs: [refOf(e)], capabilities: [] });
  s.setTask(task.id, "completed");
  s.run(
    "INSERT INTO schedules VALUES(?,?,?,?,?,?,0)",
    "followup",
    "owner",
    task.id,
    now + 1000,
    e.text,
    JSON.stringify([refOf(e)]),
  );
  now += 2000;
  await until(() => decisions === 1);
  await Bun.sleep(30);
  expect(decisions).toBe(1);
  expect(s.latest("owner", "schedule-followup")).not.toBeNull();
  h.deleteEvidence("owner", "e");
  expect(s.latest("owner", "schedule-followup")).toBeNull();
});

test("waiting tasks expire without requiring a model response", async () => {
  let now = Date.now();
  const s = new Store(":memory:", () => now),
    h = setup({ store: s });
  const e = event("e", "Question");
  s.ingest("owner", e, false);
  const task = s.createTask({
    owner: "owner",
    goal: e.text,
    refs: [refOf(e)],
    capabilities: [],
    ttl: 100,
  });
  s.setTask(task.id, "waiting");
  now += 101;
  await until(() => s.task(task.id)?.status === "cancelled");
  expect(h.status().running).toBe(true);
});
