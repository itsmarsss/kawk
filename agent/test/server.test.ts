import { expect, test } from "bun:test";
import { Harness } from "../src/harness";
import { Store } from "../src/store";
import { serve } from "../src/server";
import { KawkClient } from "../client";
import { call, event, gate, model, until } from "./helpers";
test("HTTP ingestion, auth, notification delivery and acknowledgement", async () => {
  const h = new Harness({
    store: new Store(":memory:"),
    gate,
    model: model(() =>
      call("finish", {
        text: "Keys are on the desk",
        refs: [{ eventId: "e", revision: 0 }],
        confidence: 0.9,
        notify: true,
      }),
    ),
    tickMs: 5,
  });
  h.start();
  const token = "a".repeat(48),
    server = serve(h, { token, owner: "owner", port: 0 }),
    client = new KawkClient(server.url, token);
  try {
    await client.syncClock();
    const capture = client.captureTimes(performance.now());
    expect(Math.abs(capture.sourceStart - Date.now())).toBeLessThan(500);
    expect(capture.timing.uncertaintyMs).toBeGreaterThan(0);
    expect((await fetch(server.url + "/v1/status")).status).toBe(401);
    expect(
      (
        await fetch(server.url + "/v1/status", {
          headers: { Authorization: `Bearer ${token}`, Origin: "https://evil.example" },
        })
      ).status,
    ).toBe(403);
    expect((await client.send([event("e", "Keys on the desk")])).accepted[0]?.duplicate).toBe(
      false,
    );
    await until(() => h.store.notifications("owner").length === 1);
    const abort = new AbortController(),
      stream = client.watch(abort.signal);
    const first = await stream.next();
    expect(first.value?.text).toContain("desk");
    await client.ack(first.value!.id);
    abort.abort();
    await stream.return(undefined);
    expect((await client.notifications()).notifications).toHaveLength(0);
    expect(
      (
        await fetch(server.url + "/v1/events", {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({ events: [{ ...event("e2", "hi"), owner: "other" }] }),
        })
      ).status,
    ).toBe(400);
    const saved = await client.transcripts({ query: "keys" });
    expect(saved.evidence[0]?.id).toBe("e");
    const history = await client.grepHistory({ pattern: "keys|keyring" });
    expect(history.matches[0]?.evidenceRef).toEqual({ eventId: "e", revision: 0 });
    expect(await client.reminders()).toEqual({ reminders: [] });
  } finally {
    await server.stop();
    await h.stop();
    h.store.close();
  }
});

test("PWA session cookies authenticate capture and SSE without exposing provider credentials", async () => {
  const h = new Harness({
    store: new Store(":memory:"),
    gate,
    model: model(() => call("finish", { text: "", refs: [], confidence: 1, notify: false })),
  });
  const token = "a".repeat(48),
    server = serve(h, { token, owner: "owner", port: 0 });
  try {
    const login = await fetch(server.url + "/v1/client/session", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: "{}",
    });
    expect(login.status).toBe(200);
    expect(login.headers.get("set-cookie")).toContain("HttpOnly");
    const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
    const status = await fetch(server.url + "/v1/capture/status", { headers: { cookie } });
    expect(status.status).toBe(200);
    expect(await status.json()).toMatchObject({ faceConfigured: false, speechConfigured: false });
    expect(
      (
        await fetch(server.url + "/v1/client/session", {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, Origin: "https://other.test" },
        })
      ).status,
    ).toBe(403);
    await fetch(server.url + "/v1/client/session", { method: "DELETE", headers: { cookie } });
    expect((await fetch(server.url + "/v1/status", { headers: { cookie } })).status).toBe(401);
  } finally {
    await server.stop();
    await h.capture.stop();
    h.store.close();
  }
});

test("local page connects without a token and renews an invalidated session", async () => {
  const h = new Harness({
    store: new Store(":memory:"),
    gate,
    model: model(() => call("finish", { text: "", refs: [], confidence: 1, notify: false })),
  });
  const server = serve(h, { token: "b".repeat(48), owner: "owner", port: 0 });
  const connect = () =>
    fetch(server.url + "/v1/client/session", {
      method: "POST",
      headers: { Origin: server.url, "Sec-Fetch-Site": "same-origin" },
      body: "{}",
    });
  try {
    expect((await fetch(server.url + "/v1/client/session", { method: "POST" })).status).toBe(401);
    expect(
      (
        await fetch(server.url + "/v1/client/session", {
          method: "POST",
          headers: { Origin: "https://other.test" },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await fetch(server.url + "/v1/client/session", {
          method: "POST",
          headers: { Origin: server.url, "Sec-Fetch-Site": "cross-site" },
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await fetch(server.url + "/v1/client/session", {
          method: "POST",
          headers: { Host: "other.test", Origin: "http://other.test" },
        })
      ).status,
    ).toBe(401);

    const connected = await connect();
    expect(connected.status).toBe(200);
    expect(await connected.json()).toEqual({ connected: true });
    expect(connected.headers.get("set-cookie")).toContain("HttpOnly; SameSite=Strict");
    const cookie = connected.headers.get("set-cookie")!.split(";")[0]!;
    expect((await fetch(server.url + "/v1/status", { headers: { cookie } })).status).toBe(200);
    await fetch(server.url + "/v1/client/session", { method: "DELETE", headers: { cookie } });
    expect((await fetch(server.url + "/v1/status", { headers: { cookie } })).status).toBe(401);
    const renewed = await connect();
    const renewedCookie = renewed.headers.get("set-cookie")!.split(";")[0]!;
    expect(renewedCookie).not.toBe(cookie);
    expect(
      (await fetch(server.url + "/v1/status", { headers: { cookie: renewedCookie } })).status,
    ).toBe(200);
  } finally {
    await server.stop();
    await h.capture.stop();
    h.store.close();
  }
});
