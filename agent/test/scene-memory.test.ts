import { expect, test } from "bun:test";
import { Store } from "../src/store";
import { Harness } from "../src/harness";
import { serve } from "../src/server";
import { SceneMemory } from "../src/scene-memory";
import { call, decision, event, model, until } from "./helpers";

test("scene bridge journals delayed history without replaying actions and imports one gallery identity", async () => {
  const store = new Store(":memory:");
  const h = new Harness({ store, tickMs: 5,
    gate: { decide: async () => decision({ act: false, route: "observe" }) },
    model: model(() => call("finish", { text: "", refs: [], confidence: 1, notify: false })) });
  const server = serve(h, { port: 0, owner: "owner", token: "t".repeat(48) }); h.start();
  const send = (events: unknown[], invalidatedIds: string[] = [], forgottenPeople: string[] = []) => fetch(server.url + "/v1/integration/events", {
    method: "POST", headers: { Authorization: "Bearer " + "t".repeat(48), "Content-Type": "application/json" }, body: JSON.stringify({ events, invalidatedIds, forgottenPeople }),
  });
  try {
    const old = event("old", "Remind me in twenty seconds", { sourceStart: Date.now() - 120000, sourceEnd: Date.now() - 120000, provenance: "scene-memory:speech" });
    expect((await send([old])).status).toBe(202);
    expect(store.latest("owner", "old")?.text).toBe(old.text);
    expect(store.all("SELECT * FROM gate_jobs")).toHaveLength(0);
    await send([event("recent-backfill", "Remind me in twenty seconds", { provenance: "scene-memory:speech:backfill" })]);
    expect(store.all("SELECT * FROM gate_jobs")).toHaveLength(0);
    const face = event("face", JSON.stringify({ visiblePeople: [{ personId: "kenny-gallery", name: "Kenny" }] }),
      { kind: "observation", personIds: ["kenny-gallery"], provenance: "scene-memory:faces" });
    expect((await send([face])).status).toBe(202);
    expect((await send([face])).status).toBe(202);
    const graph = h.graph.query("owner", { query: "Kenny" });
    expect(graph.entities).toHaveLength(1); expect(graph.entities[0]?.galleryId).toBe("kenny-gallery");
    await until(() => store.all("SELECT * FROM gate_jobs WHERE state='done'").length === 1);
    expect(store.tasks("owner")).toHaveLength(0);
    const staleFace = { ...face, id: "late-old-name", sourceStart: face.sourceStart - 1000, sourceEnd: face.sourceEnd - 1000,
      text: JSON.stringify({ visiblePeople: [{ personId: "kenny-gallery", name: "Old name" }] }) };
    await send([staleFace]); expect(h.graph.query("owner", { query: "Kenny" }).entities).toHaveLength(1);
    await send([], [], ["kenny-gallery"]);
    expect(h.graph.node("owner", graph.entities[0]!.id)).toBeNull();
    await send([{ ...face, id: "late-deleted-face" }]);
    expect(store.latest("owner", "late-deleted-face")).toBeNull();
    await send([], ["old"]); expect(store.latest("owner", "old")).toBeNull();
  } finally { await server.stop(); await h.stop(); store.close(); }
});

test("Jev camera decision requests an interrupt before the agent waits for fresh source evidence", async () => {
  let request: any, modelSawRequest = false, polls = 0;
  const source = event("fresh-photo", "The sign reads ROOM 314.", { kind: "observation", provenance: "scene-memory:vision" });
  const memory = Bun.serve({ port: 0, fetch: async req => {
    const path = new URL(req.url).pathname;
    if (req.method === "POST") { request = await req.json(); return Response.json({ id: request.id, state: "pending" }); }
    if (path.startsWith("/api/agent/capture/")) { polls++; return Response.json({ state: polls === 1 ? "captured" : "completed", captureId: "camera-photo", event: source }); }
    return new Response("{}", { status: 404 });
  } });
  const store = new Store(":memory:");
  const h = new Harness({ store, sceneMemoryUrl: memory.url.href, tickMs: 5,
    gate: { decide: async () => decision({ captureNow: true }), review: async () => true },
    model: model(messages => {
      const response = messages.find(m => m.role === "tool");
      if (!response) {
        const trigger = JSON.parse(messages.find(m => m.role === "user")!.content!);
        modelSawRequest = trigger.cameraRequest.id === request.id;
        return call("capture_camera", { reason: "Read the current sign", requestId: trigger.cameraRequest.id });
      }
      return call("finish", { text: "The sign reads ROOM 314.", refs: [{ eventId: source.id, revision: 0 }], confidence: 0.9, notify: true });
    }) });
  h.start();
  try {
    h.ingest("owner", event("ask", "Read the sign I am looking at", { provenance: "scene-memory:speech", deviceId: "memory-session" }));
    await until(() => store.notifications("owner").length === 1);
    expect(request.sessionId).toBe("session"); expect(modelSawRequest).toBe(true); expect(polls).toBe(2);
    expect(store.latest("owner", "fresh-photo")?.sourceEnd).toBe(source.sourceEnd);
    expect(store.notifications("owner")[0]?.text).toContain("ROOM 314");
  } finally { await h.stop(); store.close(); await memory.stop(true); }
});

test("scene search uses keyword defaults and rejects a source invalidated by a correction or people reset", async () => {
  const store = new Store(":memory:"); let valid = true, sent: any;
  const scene = new SceneMemory("http://scene.test", store, (async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).includes("/source/")) return Response.json({ valid });
    sent = JSON.parse(String(init?.body));
    return Response.json({ results: [{ id: "note", packetId: "photo", packetVersion: 2, text: "Keys on shelf",
      observedAt: 1000, endAt: 1000, confidence: "observed", entityIds: ["keys"], candidateEntityIds: [], superseded: false }] });
  }) as typeof fetch);
  try {
    const result = await scene.search("owner", { query: "keys", from: 500, to: 1500 }, new AbortController().signal);
    expect(sent.mode).toBe("keyword"); expect(sent.from).toBe(500); expect(result[0]?.sourceUrl).toBe("/api/frames/photo");
    const evidence = store.latest("owner", result[0]!.evidenceRef.eventId)!;
    expect(evidence.sourceStart).toBe(1000); expect(evidence.revision).toBe(2);
    expect(await scene.currentEvidence(evidence, new AbortController().signal)).toBe(true);
    valid = false; expect(await scene.currentEvidence(evidence, new AbortController().signal)).toBe(false);
  } finally { store.close(); }
});
