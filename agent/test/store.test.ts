import { afterEach, expect, test } from "bun:test";
import { Store } from "../src/store";
import { event } from "./helpers";
import { refOf } from "../src/contracts";
const stores: Store[] = [];
const create = () => {
  const store = new Store(":memory:");
  stores.push(store);
  return store;
};
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

test("immutable revisions, duplicate delivery, stale revisions and partials", () => {
  const s = create(),
    e = event("speech", "Where are my keys?", { final: false });
  expect(s.ingest("alice", e).duplicate).toBe(false);
  expect(s.ingest("alice", e).duplicate).toBe(true);
  expect(s.nextGate()).toBeNull();
  expect(() => s.ingest("alice", { ...e, text: "different" })).toThrow("different content");
  s.ingest("alice", { ...e, revision: 2, final: true });
  s.ingest("alice", { ...e, revision: 1, text: "late partial" });
  expect(s.latest("alice", e.id)?.revision).toBe(2);
  expect(s.nextGate()?.revision).toBe(2);
  expect(s.nextGate()).toBeNull();
});
test("search is scoped; punctuation and SQL-looking text cannot bypass scope", () => {
  const s = create();
  s.ingest("alice", event("a", "keys on the desk"));
  s.ingest("bob", event("b", "keys in the car"));
  expect(s.search("alice", "keys").evidence.map((e) => e.id)).toEqual(["a"]);
  expect(s.search("alice", 'keys" OR "car').evidence.map((e) => e.id)).toEqual(["a"]);
  expect(s.search("alice", "!?'").evidence).toEqual([]);
});
test("source-time context does not attribute delayed speech to the person currently visible", () => {
  const s = create();
  s.ingest(
    "owner",
    event("bob", "Bob visible", {
      kind: "observation",
      sourceStart: 100,
      sourceEnd: 600,
      personIds: ["bob"],
    }),
  );
  s.ingest(
    "owner",
    event("alice", "Alice visible", {
      kind: "observation",
      sourceStart: 1800,
      sourceEnd: 2000,
      personIds: ["alice"],
    }),
  );
  const context = s.recent("owner", 600, 500);
  expect(context.map((e) => e.id)).toEqual(["bob"]);
});
test("corrections cancel dependent work and withdraw memories/notifications", () => {
  const s = create(),
    e = event("keys", "Keys on desk");
  s.ingest("owner", e);
  const refs = [refOf(e)],
    task = s.createTask({ owner: "owner", goal: "find keys", refs, capabilities: [] });
  const memory = s.remember("owner", "keys-location", "on desk", "fact", refs);
  s.notify(task, "On your desk", refs);
  s.ingest("owner", { ...e, revision: 1, text: "Keys on shelf" });
  expect(s.task(task.id)?.status).toBe("cancelled");
  expect(s.memory("owner", memory.id)).toBeNull();
  expect(s.notifications("owner")).toEqual([]);
  expect(s.search("owner", "desk")).toEqual({ evidence: [], memories: [] });
});
test("deletion purges derived text and prevents reimport", () => {
  const s = create(),
    e = event("trip", "Private trip to Oslo");
  s.ingest("owner", e);
  const t = s.createTask({ owner: "owner", goal: e.text, refs: [refOf(e)], capabilities: [] });
  s.saveMessages(t.id, [{ role: "user", content: e.text }]);
  s.remember("owner", "trip", e.text, "episode", [refOf(e)]);
  s.notify(t, e.text, [refOf(e)]);
  s.deleteEvidence("owner", e.id);
  expect(s.search("owner", "Oslo")).toEqual({ evidence: [], memories: [] });
  expect(s.task(t.id)?.messages).toEqual([]);
  expect(() => s.ingest("owner", e)).toThrow("Deleted evidence");
  expect(s.one<{ text: string }>("SELECT text FROM memories")?.text).toBe("");
});
test("restart distinguishes replay-safe and uncertain tool effects", () => {
  const s = create(),
    e = event("e", "do work");
  s.ingest("owner", e);
  const safe = s.createTask({ owner: "owner", goal: "safe", refs: [refOf(e)], capabilities: [] });
  const unsafe = s.createTask({
    owner: "owner",
    goal: "unsafe",
    refs: [refOf(e)],
    capabilities: [],
  });
  for (const t of [safe, unsafe]) s.setTask(t.id, "running");
  s.beginTool("safe", safe.id, "search_memory", "{}", true);
  s.beginTool("unsafe", unsafe.id, "run_code", "{}", false);
  s.recover();
  expect(s.task(safe.id)?.status).toBe("queued");
  expect(s.task(unsafe.id)?.status).toBe("failed");
});
test("runtime lease rejects a second daemon and can be released", () => {
  const s = create();
  expect(s.lock("first")).toBe(true);
  expect(s.lock("second")).toBe(false);
  s.unlock("first");
  expect(s.lock("second")).toBe(true);
});
test("notification acknowledgement and expiry persist independently from task", () => {
  let now = 1000;
  const s = new Store(":memory:", () => now);
  stores.push(s);
  const e = event("e", "answer");
  s.ingest("owner", e);
  const t = s.createTask({ owner: "owner", goal: "answer", refs: [refOf(e)], capabilities: [] });
  const n = s.notify(t, "answer", [refOf(e)], 100);
  expect(s.ack("other", n.id)).toBe(false);
  expect(s.ack("owner", n.id)).toBe(true);
  expect(s.notifications("owner")).toEqual([]);
  const t2 = s.createTask({ owner: "owner", goal: "answer 2", refs: [refOf(e)], capabilities: [] });
  s.notify(t2, "answer2", [refOf(e)], 100);
  now = 1200;
  expect(s.notifications("owner")).toEqual([]);
});

test("retention purges unpinned evidence and preserves evidence for a retained memory", () => {
  let now = Date.now();
  const s = new Store(":memory:", () => now);
  stores.push(s);
  const raw = event("raw", "old observation"),
    pinned = event("pinned", "a lasting preference");
  s.ingest("owner", raw, false);
  s.ingest("owner", pinned, false);
  s.remember("owner", "preference", pinned.text, "fact", [refOf(pinned)]);
  now += 8 * 86400000;
  s.maintain(7 * 86400000);
  expect(s.latest("owner", "raw")).toBeNull();
  expect(s.latest("owner", "pinned")).not.toBeNull();
  expect(() => s.ingest("owner", raw)).toThrow("Deleted evidence");
});

test("removing a retrieved memory cancels its pending work and notification", () => {
  const s = create(),
    e = event("e", "preference");
  s.ingest("owner", e);
  const m = s.remember("owner", "preference", e.text, "fact", [refOf(e)]);
  const t = s.createTask({ owner: "owner", goal: "retrieve", refs: [refOf(e)], capabilities: [] });
  s.notify(t, e.text, [refOf(e)]);
  expect(s.forget("owner", m.id)).toBe(true);
  expect(s.task(t.id)?.status).toBe("cancelled");
  expect(s.notifications("owner")).toHaveLength(0);
  expect(s.latest("owner", e.id)).not.toBeNull();
});
