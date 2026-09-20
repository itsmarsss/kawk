import { expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store";
import { TranscriptArchive } from "../src/transcripts";
import { KnowledgeGraph } from "../src/knowledge";
import { Reminders } from "../src/reminders";
import { mapCapture, mapClock, relateTime, resolveLocalTime } from "../src/temporal";
import { refOf } from "../src/contracts";
import { event } from "./helpers";

test("JSONL keeps unselected speech, every revision and hourly rollover; restart catches up and deletion redacts", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kawk-transcripts-"));
  let now = Date.parse("2026-09-19T23:59:59Z");
  let store = new Store(join(dir, "db.sqlite"), () => now);
  try {
    let archive = new TranscriptArchive(store, join(dir, "transcripts"));
    const a = event("a", "calculus partial", {
      final: false,
      sourceStart: now - 3000,
      sourceEnd: now - 1000,
    });
    store.ingest("owner", a, false);
    store.ingest("owner", { ...a, text: "calculus integrals", revision: 1, final: true }, false);
    store.ingest("other", event("a", "private other person"), false);
    await archive.flush();
    const first = archive.file("owner", Math.floor(now / 3600000) * 3600000);
    expect((await readFile(first, "utf8")).trim().split("\n")).toHaveLength(2);
    expect((await stat(first)).mode & 0o777).toBe(0o600);
    now += 2000;
    store.ingest("owner", event("b", "next hour", { sourceStart: now, sourceEnd: now }), false);
    store.close();
    store = new Store(join(dir, "db.sqlite"), () => now);
    archive = new TranscriptArchive(store, join(dir, "transcripts"));
    await archive.flush(false);
    expect(
      (await readdir(join(dir, "transcripts"))).filter((f) => f.endsWith(".jsonl")),
    ).toHaveLength(2);
    await archive.flush();
    expect(
      (await readdir(join(dir, "transcripts"))).filter((f) => f.endsWith(".jsonl")),
    ).toHaveLength(3);
    expect(store.transcripts("owner", { query: "integrals" }).map((e) => e.id)).toEqual(["a"]);
    expect(store.transcripts("owner", { query: "private" })).toHaveLength(0);
    store.deleteEvidence("owner", "a");
    await archive.flush();
    expect(await readFile(first, "utf8")).toBe("");
    expect(store.transcripts("owner", { query: "integrals" })).toHaveLength(0);
    expect(store.transcripts("other")).toHaveLength(1);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("transcript retention is independent; visible-person search never claims a speaker", () => {
  let now = 100000;
  const s = new Store(":memory:", () => now);
  try {
    s.ingest(
      "o",
      event("speech", "I love skiing", {
        personIds: ["william"],
        sourceStart: now,
        sourceEnd: now,
      }),
      false,
    );
    s.ingest(
      "o",
      event("frame", "William in view", { kind: "observation", sourceStart: now, sourceEnd: now }),
      false,
    );
    now += 8 * 86400000;
    s.maintain(7 * 86400000, 0);
    expect(s.latest("o", "speech")).not.toBeNull();
    expect(s.latest("o", "frame")).toBeNull();
    expect(s.transcripts("o", { personId: "william" })).toHaveLength(1);
    expect(s.transcripts("o", { speakerId: "william" })).toHaveLength(0);
  } finally {
    s.close();
  }
});

test("clock mapping handles asymmetric transit, stale sessions and delayed speech without false identity", () => {
  const mapping = mapClock("s", [
    { clientSent: 100, serverReceived: 1110, serverSent: 1112, clientReceived: 152 },
  ]);
  const capture = mapCapture(mapping, "s", 200, 300, 5);
  expect(capture.sourceStart - capture.timing.uncertaintyMs).toBeLessThanOrEqual(1200);
  expect(capture.sourceStart + capture.timing.uncertaintyMs).toBeGreaterThanOrEqual(1200);
  expect(() => mapCapture(mapping, "old-session", 200, 300)).toThrow();
  expect(() => mapCapture(mapping, "s", 100000, 100001)).toThrow("expired");
  const speech = event("speech", "hello", { ...capture });
  const earlierFrame = event("earlier", "William", {
    kind: "observation",
    sourceStart: 1250,
    sourceEnd: 1250,
    timing: { method: "capture", clockSessionId: "s", uncertaintyMs: 5 },
  });
  const arrivalFrame = event("arrival", "Bob", {
    kind: "observation",
    sourceStart: 7000,
    sourceEnd: 7000,
  });
  expect(relateTime(speech, earlierFrame).possibleOverlap).toBe(true);
  expect(relateTime(speech, earlierFrame).provesSpeakerIdentity).toBe(false);
  expect(relateTime(speech, arrivalFrame).possibleOverlap).toBe(false);
  expect(relateTime(arrivalFrame, arrivalFrame).uncertaintyKnown).toBe(false);
});

test("Temporal resolves calendar time and rejects DST gaps/repeats and invalid dates", () => {
  expect(resolveLocalTime("2026-09-20T09:00:00", "America/Toronto")).toBe(
    Date.parse("2026-09-20T13:00:00Z"),
  );
  expect(() => resolveLocalTime("2026-03-08T02:30:00", "America/Toronto")).toThrow();
  expect(() => resolveLocalTime("2026-11-01T01:30:00", "America/Toronto")).toThrow();
  expect(resolveLocalTime("2026-11-01T01:30:00-04:00", "America/Toronto")).toBe(
    Date.parse("2026-11-01T05:30:00Z"),
  );
  expect(resolveLocalTime("2026-11-01T01:30:00-05:00", "America/Toronto")).toBe(
    Date.parse("2026-11-01T06:30:00Z"),
  );
  expect(() => resolveLocalTime("2026-02-30T09:00:00", "UTC")).toThrow();
});

test("relative reminder due time is anchored to source speech, including a delayed final", () => {
  const now = Date.now(),
    s = new Store(":memory:", () => now);
  try {
    const e = event("late-speech", "Remind me in 20 seconds", {
      sourceStart: now - 40000,
      sourceEnd: now - 30000,
    });
    s.ingest("o", e, false);
    const task = s.createTask({ owner: "o", goal: e.text, refs: [refOf(e)], capabilities: [] });
    const reminders = new Reminders(s, (owner, event, refs) =>
      s.createTask({ owner, goal: event.text, refs, capabilities: [] }),
    );
    const result = reminders.create(task, "late-reminder", {
      text: "Stretch",
      afterMs: 20000,
      anchorEventId: e.id,
      refs: [refOf(e)],
    });
    expect(result.dueAt).toBe(now - 10000);
    reminders.fire();
    reminders.fire();
    expect(s.notifications("o")).toHaveLength(0);
    expect(s.all("SELECT * FROM reminder_wakes")).toHaveLength(1);
    expect(() =>
      reminders.create(task, "bad-anchor", {
        text: "Stretch",
        afterMs: 20000,
        anchorEventId: "unrelated",
        refs: [refOf(e)],
      }),
    ).toThrow();
  } finally {
    s.close();
  }
});

test("graph reuses gallery identities, retains relation history and invalidates corrected/deleted claims", () => {
  const s = new Store(":memory:");
  try {
    const g = new KnowledgeGraph(s);
    const e = event("meeting", "William studies calculus", { personIds: ["gallery-1"] });
    s.ingest("o", e, false);
    const refs = [refOf(e)];
    const person = g.entity("o", {
      key: "william",
      kind: "person",
      label: "William",
      galleryId: "gallery-1",
      refs,
    });
    expect(
      g.entity("o", {
        key: "different-name",
        kind: "person",
        label: "Will",
        galleryId: "gallery-1",
        refs,
      }).id,
    ).toBe(person.id);
    expect(() =>
      g.entity("o", { key: "bob", kind: "person", label: "Bob", galleryId: "wrong-id", refs }),
    ).toThrow();
    const course = g.entity("o", { key: "math", kind: "topic", label: "Calculus", refs });
    g.relation("o", {
      key: "studies",
      subjectId: person.id,
      predicate: "studies",
      targetId: course.id,
      validFrom: e.sourceStart,
      certainty: "reported",
      refs,
    });
    const newer = event("new", "William switched to algebra", { personIds: ["gallery-1"] });
    s.ingest("o", newer, false);
    g.relation("o", {
      key: "studies",
      subjectId: person.id,
      predicate: "studies",
      value: "algebra",
      validFrom: newer.sourceStart,
      certainty: "reported",
      refs: [refOf(newer)],
    });
    expect(g.query("o", { entityId: person.id, history: true }).relations).toHaveLength(2);
    expect(g.query("o", { entityId: person.id }).relations).toHaveLength(1);
    expect(g.query("other", { entityId: person.id }).relations).toHaveLength(0);
    s.ingest("o", { ...newer, revision: 1, text: "Correction: not algebra" }, false);
    expect(g.query("o", { entityId: person.id }).relations).toHaveLength(0);
    s.deleteEvidence("o", "meeting");
    expect(g.query("o", { entityId: person.id, history: true }).entities).toHaveLength(0);
  } finally {
    s.close();
  }
});

test("reminders survive restart, are independent of task acknowledgements and fire once; stale/unknown encounters do not fire", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kawk-reminders-"));
  let now = Date.now();
  let s = new Store(join(dir, "db.sqlite"), () => now);
  try {
    const e = event("request", "Remind me to submit homework", {
      sourceStart: now,
      sourceEnd: now,
    });
    s.ingest("o", e, false);
    const task = s.createTask({ owner: "o", goal: e.text, refs: [refOf(e)], capabilities: [] });
    const reminders = new Reminders(s, (owner, event, refs) =>
      s.createTask({ owner, goal: event.text, refs, capabilities: [] }),
    );
    reminders.create(task, "r1", { text: "Submit homework", dueAt: now + 5000, refs: [refOf(e)] });
    reminders.create(task, "r2", {
      text: "Ask William about his trip",
      personId: "william",
      refs: [refOf(e)],
    });
    const confirmation = s.notify(task, "Scheduled", [refOf(e)]);
    s.ack("o", confirmation.id);
    s.setTask(task.id, "completed");
    s.close();
    now += 6000;
    s = new Store(join(dir, "db.sqlite"), () => now);
    const resumed = new Reminders(s, (owner, event, refs) =>
      s.createTask({ owner, goal: event.text, refs, capabilities: [] }),
    );
    resumed.fire();
    resumed.fire();
    expect(s.notifications("o")).toHaveLength(0);
    expect(s.all("SELECT * FROM reminder_wakes")).toHaveLength(1);
    expect(s.tasks().some((t) => t.goal.includes("Submit homework") && t.id !== task.id)).toBe(
      true,
    );
    const sighting = event("seen", "William is here", {
      kind: "observation",
      personIds: ["william"],
      sourceStart: now,
      sourceEnd: now,
    });
    s.ingest("o", sighting, false);
    resumed.fire(s.latest("o", "seen")!);
    expect(s.all("SELECT * FROM reminder_wakes")).toHaveLength(1); // timing uncertainty unknown
    s.ingest(
      "o",
      {
        ...sighting,
        revision: 1,
        timing: { method: "capture", clockSessionId: "s", uncertaintyMs: 50 },
      },
      false,
    );
    resumed.fire(s.latest("o", "seen")!);
    expect(s.all("SELECT * FROM reminder_wakes")).toHaveLength(2);
    expect(s.notifications("o")).toHaveLength(0);
    s.deleteEvidence("o", "request");
    expect(s.notifications("o")).toHaveLength(0);
  } finally {
    s.close();
    await rm(dir, { recursive: true, force: true });
  }
});
