import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store";
import { grepHistory } from "../src/history";
import { Harness } from "../src/harness";
import { refOf } from "../src/contracts";
import { call, event, gate, model } from "./helpers";

test("grep searches durable raw history before hourly export or Jev selection, across restart", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kawk-history-"));
  let store = new Store(join(dir, "store.sqlite"));
  try {
    const h = new Harness({ store, gate, model: model(() => call("finish", {})) });
    h.ingest("owner", event("speech", "Calculus covered derivatives and the chain rule"));
    h.ingest(
      "owner",
      event("frame", "Red keyring inside the blue backpack", { kind: "observation" }),
    );
    h.ingest("owner", event("partial", "This keyring was...", { final: false }));
    h.ingest("other", event("private", "Private keyring on desk"));
    expect(store.tasks()).toHaveLength(0);
    expect(h.tools.names()).toContain("grep_history");
    expect(h.tools.names()).not.toContain("search_life_memory");
    store.close();
    store = new Store(join(dir, "store.sqlite"));
    const result = await grepHistory(store, "owner", { pattern: "CHAIN RULE|keyring" });
    expect(result.matches.map((m) => m.id)).toEqual(["speech", "frame"]);
    expect(result.matches[0]?.evidenceRef).toEqual({ eventId: "speech", revision: 0 });
    expect(result.truncated).toBe(false);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("grep applies source-time and identity filters without treating a visible person as speaker", async () => {
  const store = new Store(":memory:");
  try {
    store.ingest(
      "o",
      event("old", "I visited Iceland", {
        sourceStart: 100,
        sourceEnd: 200,
        personIds: ["william"],
      }),
      false,
    );
    store.ingest(
      "o",
      event("new", "Iceland was great", {
        sourceStart: 1000,
        sourceEnd: 2000,
        speakerId: "william",
      }),
      false,
    );
    const visible = await grepHistory(store, "o", {
      pattern: "Iceland",
      personId: "william",
      from: 150,
      to: 300,
    });
    expect(visible.matches.map((m) => m.id)).toEqual(["old"]);
    expect(visible.matches[0]?.speakerId).toBeNull();
    expect(
      (await grepHistory(store, "o", { pattern: "Iceland", speakerId: "william" })).matches.map(
        (m) => m.id,
      ),
    ).toEqual(["new"]);
    expect(
      (await grepHistory(store, "o", { pattern: "Iceland", kind: "observation" })).matches,
    ).toHaveLength(0);
  } finally {
    store.close();
  }
});

test("grep handles regex, literal punctuation and option-like input without invoking a shell", async () => {
  const store = new Store(":memory:");
  try {
    store.ingest("o", event("syntax", "C++ --pre=echo $(whoami) [literal]"), false);
    expect(
      (await grepHistory(store, "o", { pattern: "C++", fixedStrings: true })).matches,
    ).toHaveLength(1);
    expect(
      (await grepHistory(store, "o", { pattern: "--pre=echo $(whoami)", fixedStrings: true }))
        .matches,
    ).toHaveLength(1);
    expect(
      (await grepHistory(store, "o", { pattern: "LITERAL", caseSensitive: true })).matches,
    ).toHaveLength(0);
    await expect(grepHistory(store, "o", { pattern: "[invalid" })).rejects.toThrow(
      "ripgrep failed",
    );
    await expect(grepHistory(store, "o", { pattern: "a\nb" })).rejects.toThrow("single-line");
    await expect(grepHistory(store, "o", { pattern: ".", from: 10, to: 1 })).rejects.toThrow(
      "Invalid time",
    );
  } finally {
    store.close();
  }
});

test("grep pagination crosses input batches, bounds output and reports exact exhaustion", async () => {
  const store = new Store(":memory:");
  try {
    store.atomic(() => {
      for (let i = 0; i < 160; i++)
        store.ingest("o", event(`e-${i}`, i % 40 === 0 ? "needle" : "filler"), false);
    });
    const first = await grepHistory(store, "o", { pattern: "needle", limit: 2 });
    expect(first.matches.map((m) => m.id)).toEqual(["e-0", "e-40"]);
    expect(first.truncated).toBe(true);
    const last = await grepHistory(store, "o", {
      pattern: "needle",
      limit: 2,
      after: first.nextCursor!,
    });
    expect(last.matches.map((m) => m.id)).toEqual(["e-80", "e-120"]);
    expect(last.truncated).toBe(false);
    expect(last.nextCursor).toBeNull();
    for (let i = 0; i < 8; i++)
      store.ingest("o", event(`large-${i}`, "longtext ".repeat(1300)), false);
    const bounded = await grepHistory(store, "o", { pattern: "longtext", limit: 100 });
    expect(bounded.truncated).toBe(true);
    expect(JSON.stringify(bounded).length).toBeLessThan(50000);
  } finally {
    store.close();
  }
});

test("corrected/deleted revisions cannot reappear as current grep matches", async () => {
  const store = new Store(":memory:");
  try {
    const original = event("keys", "Keys on the counter");
    store.ingest("o", original, false);
    store.ingest("o", { ...original, revision: 1, text: "Keys in the backpack" }, false);
    expect((await grepHistory(store, "o", { pattern: "counter" })).matches).toHaveLength(0);
    expect(
      (await grepHistory(store, "o", { pattern: "backpack" })).matches[0]?.evidenceRef.revision,
    ).toBe(1);
    store.deleteEvidence("o", original.id);
    expect((await grepHistory(store, "o", { pattern: "backpack" })).matches).toHaveLength(0);
  } finally {
    store.close();
  }
});

test("grep cancellation is an error, never an empty successful search", async () => {
  const store = new Store(":memory:");
  try {
    const abort = new AbortController();
    abort.abort(new Error("Search cancelled"));
    await expect(grepHistory(store, "o", { pattern: "." }, abort.signal)).rejects.toThrow(
      "Search cancelled",
    );
    store.atomic(() => {
      for (let i = 0; i < 512; i++) store.ingest("o", event(`e-${i}`, "ordinary speech"), false);
    });
    const active = new AbortController();
    const searching = grepHistory(store, "o", { pattern: "no-match" }, active.signal);
    queueMicrotask(() => active.abort(new Error("Active search cancelled")));
    await expect(searching).rejects.toThrow("Active search cancelled");
  } finally {
    store.close();
  }
});

test("grep tool binds matched sources so a later correction invalidates the task", async () => {
  const store = new Store(":memory:");
  try {
    const e = event("saved", "Keyring on shelf");
    store.ingest("o", e, false);
    const question = event("question", "Where are my keys?");
    store.ingest("o", question, false);
    const h = new Harness({ store, gate, model: model(() => call("finish", {})) });
    const task = store.createTask({
      owner: "o",
      goal: "Find keys",
      refs: [refOf(question)],
      capabilities: ["grep_history"],
    });
    await h.tools.execute("grep_history", JSON.stringify({ pattern: "keyring" }), {
      task,
      callId: "search",
      signal: new AbortController().signal,
    });
    expect(store.refs("task", task.id)).toContainEqual(refOf(e));
    store.ingest("o", { ...e, revision: 1, text: "Keyring in bag" }, false);
    expect(store.task(task.id)?.status).toBe("cancelled");
  } finally {
    store.close();
  }
});

test("upgrade retires imported semantic snapshots and dependent claims while preserving local history", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kawk-upgrade-"));
  let store = new Store(join(dir, "store.sqlite"));
  try {
    const e = event("imported", "Possible keys on counter", {
      kind: "context",
      provenance: "memory-service",
    });
    store.ingest("o", e, false);
    store.ingest("o", event("local", "Local speech about keys"), false);
    store.remember("o", "keys", e.text, "fact", [refOf(e)]);
    store.run(
      "CREATE TABLE memory_sources(owner TEXT,event_id TEXT,packet_id TEXT,packet_version INTEGER)",
    );
    store.run("INSERT INTO memory_sources VALUES('o','imported','packet',1)");
    store.close();
    store = new Store(join(dir, "store.sqlite"));
    expect(store.latest("o", "imported")).toBeNull();
    expect(store.search("o", "keys").memories).toHaveLength(0);
    expect((await grepHistory(store, "o", { pattern: "keys" })).matches.map((m) => m.id)).toEqual([
      "local",
    ]);
    expect(
      store.one<{ payload: string }>("SELECT payload FROM evidence WHERE id='imported'")?.payload,
    ).toContain("Possible keys");
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
