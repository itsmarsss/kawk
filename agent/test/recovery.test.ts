import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store";
import { Harness } from "../src/harness";
import { event, gate, model, call, until } from "./helpers";
import { refOf } from "../src/contracts";
test("a reopened database resumes queued evidence and acknowledges one durable notification", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kawk-test-")),
    db = join(dir, "store.sqlite");
  const e = event("e", "Keys on the desk");
  let store = new Store(db);
  store.ingest("owner", e);
  store.close();
  store = new Store(db);
  const h = new Harness({
    store,
    gate,
    model: model(() =>
      call("finish", { text: "Keys on desk", refs: [refOf(e)], notify: true, confidence: 0.9 }),
    ),
    tickMs: 5,
  });
  h.start();
  try {
    await until(() => store.notifications("owner").length === 1);
    const id = store.notifications("owner")[0]!.id;
    await h.stop();
    store.close();
    store = new Store(db);
    expect(store.notifications("owner")).toHaveLength(1);
    store.ack("owner", id);
    store.close();
    store = new Store(db);
    expect(store.notifications("owner")).toHaveLength(0);
    expect(store.tasks()).toHaveLength(1);
  } finally {
    await h.stop();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
test("completed tool receipts are reused after a crash before transcript checkpoint", async () => {
  const store = new Store(":memory:"),
    e = event("e", "keys on desk");
  store.ingest("owner", e, false);
  const t = store.createTask({
    owner: "owner",
    goal: "remember",
    refs: [refOf(e)],
    capabilities: ["remember", "finish"],
  });
  const args = JSON.stringify({ key: "keys", text: "on desk", kind: "fact", refs: [refOf(e)] });
  store.setTask(t.id, "running");
  store.saveMessages(t.id, [
    { role: "system", content: "fixture" },
    { role: "user", content: "remember" },
    {
      role: "assistant",
      content: null,
      tool_calls: [
        { id: "remember", type: "function", function: { name: "remember", arguments: args } },
      ],
    },
  ]);
  store.beginTool(`${t.id}:remember`, t.id, "remember", args, true);
  const saved = store.remember("owner", "keys", "on desk", "fact", [refOf(e)]);
  store.endTool(`${t.id}:remember`, saved);
  const h = new Harness({
    store,
    gate,
    model: model((messages) => {
      expect(messages.at(-1)?.role).toBe("tool");
      return call("finish", { text: "done", refs: [refOf(e)], notify: false, confidence: 1 });
    }),
    tickMs: 5,
  });
  h.start();
  try {
    await until(() => store.task(t.id)?.status === "completed");
    expect(store.all("SELECT * FROM memories")).toHaveLength(1);
  } finally {
    await h.stop();
    store.close();
  }
});
