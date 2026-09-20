import { SpeechSession } from "./speech";
import type { PushDelivery } from "./push";
import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { BatchSchema, Conflict, EventSchema, Id, refOf } from "./contracts";
import type { Harness } from "./harness";
import { join } from "node:path";
import { GraphFilter, TranscriptFilter } from "./memory-tools";
import { grepHistory, HistoryQuery } from "./history";

export function serve(
  harness: Harness,
  options: {
    token: string;
    owner: string;
    port?: number;
    push?: PushDelivery;
    speech?: { apiKey?: string; modelId?: string };
    webDir?: string;
  },
) {
  if (options.token.length < 32) throw new Error("Client token must be at least 32 characters");
  const json = (body: unknown, status = 200) =>
    Response.json(body, {
      status,
      headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
    });
  const sessions = new Map<string, number>();
  const bearer = (request: Request) => {
    const value = request.headers.get("authorization") ?? "",
      expected = `Bearer ${options.token}`;
    return (
      Buffer.byteLength(value) === Buffer.byteLength(expected) &&
      timingSafeEqual(Buffer.from(value), Buffer.from(expected))
    );
  };
  const authorized = (request: Request) => {
    if (bearer(request)) return true;
    const id = request.headers
      .get("cookie")
      ?.split(";")
      .map((s) => s.trim())
      .find((s) => s.startsWith("kawk_session="))
      ?.slice(13);
    return !!id && (sessions.get(id) ?? 0) > Date.now();
  };
  const audio = new Map<Bun.ServerWebSocket<{ owner: string }>, SpeechSession>();
  const streams = new Set<() => void>();
  const server: Bun.Server<{ owner: string }> = Bun.serve({
    hostname: "127.0.0.1",
    port: options.port ?? 8091,
    maxRequestBodySize: 1024 * 1024,
    idleTimeout: 255,
    websocket: {
      open(ws) {
        audio.set(
          ws,
          new SpeechSession(
            ws,
            (event) => harness.ingest(ws.data.owner, event),
            options.speech ?? {},
          ),
        );
      },
      message(ws, message) {
        audio.get(ws)?.message(message);
      },
      close(ws) {
        audio.get(ws)?.close();
        audio.delete(ws);
      },
      maxPayloadLength: 16000,
      idleTimeout: 120,
    },
    async fetch(request) {
      const receivedAt = Date.now();
      const url = new URL(request.url),
        path = url.pathname,
        owner = options.owner;
      if (path === "/health" && request.method === "GET")
        return json({ service: "kawk-agent", running: harness.status().running });
      const origin = request.headers.get("origin");
      if (origin && origin !== url.origin)
        return json({ error: "Cross-origin request rejected" }, 403);
      if (path === "/v1/client/session" && request.method === "POST") {
        // The local testing page connects itself; scripts can still use the bearer token.
        const localPage =
          origin === url.origin &&
          ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) &&
          request.headers.get("sec-fetch-site") !== "cross-site";
        if (!localPage && !bearer(request)) return json({ error: "Unauthorized" }, 401);
        for (const [id, expires] of sessions) if (expires < Date.now()) sessions.delete(id);
        const id = crypto.randomUUID();
        sessions.set(id, Date.now() + 86400000);
        return Response.json(
          { connected: true },
          {
            headers: {
              "Set-Cookie": `kawk_session=${id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400${url.protocol === "https:" ? "; Secure" : ""}`,
              "Cache-Control": "no-store",
            },
          },
        );
      }
      if (path === "/v1/client/session" && request.method === "DELETE") {
        const id = request.headers
          .get("cookie")
          ?.split(";")
          .map((s) => s.trim())
          .find((s) => s.startsWith("kawk_session="))
          ?.slice(13);
        if (id) sessions.delete(id);
        return Response.json(
          { connected: false },
          {
            headers: {
              "Set-Cookie": "kawk_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0",
            },
          },
        );
      }
      if (
        request.method === "GET" &&
        !path.startsWith("/v1/") &&
        /^\/[a-zA-Z0-9_./-]*$/.test(path) &&
        !path.includes("..")
      ) {
        const file = Bun.file(
          join(
            options.webDir ?? join(import.meta.dir, "../web"),
            path === "/" ? "index.html" : path.slice(1),
          ),
        );
        if (await file.exists())
          return new Response(file, {
            headers: {
              "Cache-Control": path === "/sw.js" ? "no-cache" : "no-store",
              "X-Content-Type-Options": "nosniff",
            },
          });
      }
      if (!authorized(request)) return json({ error: "Unauthorized" }, 401);

      try {
        if (path === "/v1/integration/events" && request.method === "POST") {
          const body = z.object({ events: z.array(EventSchema).max(64), invalidatedIds: z.array(Id).max(64) }).strict().parse(await request.json());
          const results = harness.store.atomic(() => {
            for (const id of body.invalidatedIds) harness.deleteEvidence(owner, id);
            return body.events.map(event => {
              // Replay journals all revisions but never wakes actions from stale backlog.
              const live = Date.now() - event.sourceEnd < 60000;
              const accepted = harness.ingest(owner, event, live);
              if (event.provenance === "scene-memory:faces" && accepted.current && !accepted.duplicate) {
                const content = JSON.parse(event.text);
                for (const person of content.visiblePeople ?? []) if (person.name && event.personIds.includes(person.personId)) {
                  const key = `gallery:${person.personId}`;
                  const old = harness.store.one<{ id: string }>("SELECT id FROM graph_nodes WHERE owner=? AND key=?", owner, key);
                  if (old && harness.graph.node(owner, old.id)?.label === person.name) continue;
                  harness.graph.entity(owner, { key, kind: "person", label: person.name, galleryId: person.personId, refs: [refOf(event)] });
                }
              }
              return accepted;
            });
          });
          return json({ accepted: results }, 202);
        }
        if (path === "/v1/capture/audio" && request.headers.get("upgrade") === "websocket") {
          if (audio.size >= 2) return json({ error: "Audio session limit reached" }, 429);
          if (server.upgrade(request, { data: { owner } })) return;
          return json({ error: "WebSocket upgrade failed" }, 400);
        }
        if (path === "/v1/capture/status" && request.method === "GET")
          return json({
            ...harness.capture.status(),
            speechConfigured: !!options.speech?.apiKey && !!options.speech?.modelId,
          });
        if (path === "/v1/capture/frame" && request.method === "POST")
          return json(harness.capture.accept(owner, await request.json()), 202);
        if (path === "/v1/people" && request.method === "GET")
          return json({ people: harness.capture.people(owner) });
        const personImage = path.match(/^\/v1\/people\/([0-9a-f-]{36})\/image$/);
        if (personImage && request.method === "GET") {
          const bytes = harness.capture.image(owner, personImage[1]!);
          return bytes
            ? new Response(bytes, {
                headers: { "Content-Type": "image/jpeg", "Cache-Control": "no-store" },
              })
            : json({ error: "Unknown person" }, 404);
        }
        if (path === "/v1/push/key" && request.method === "GET")
          return options.push
            ? json({ publicKey: options.push.keys.publicKey })
            : json({ error: "Push is not configured" }, 503);
        if (path === "/v1/push/subscriptions" && options.push) {
          if (request.method === "POST")
            return json(options.push.subscribe(owner, await request.json()));
          if (request.method === "DELETE")
            return json(
              options.push.unsubscribe(
                owner,
                z.object({ endpoint: z.string() }).parse(await request.json()).endpoint,
              ),
            );
        }
        if (path === "/v1/time" && request.method === "GET")
          return json({ receivedAt, sentAt: Date.now(), timeZone: harness.timeZone });
        if (path === "/v1/history/grep" && request.method === "POST")
          return json(
            await grepHistory(
              harness.store,
              owner,
              HistoryQuery.parse(await request.json()),
              request.signal,
            ),
          );
        if (path === "/v1/transcripts/search" && request.method === "POST")
          return json({
            evidence: harness.store.transcripts(
              owner,
              TranscriptFilter.parse(await request.json()),
            ),
          });
        if (path === "/v1/graph/query" && request.method === "POST")
          return json(harness.graph.query(owner, GraphFilter.parse(await request.json())));
        if (path === "/v1/reminders" && request.method === "GET")
          return json({ reminders: harness.reminders.list(owner) });
        if (path.startsWith("/v1/reminders/") && request.method === "DELETE")
          return json({
            cancelled: harness.reminders.cancel(owner, decodeURIComponent(path.slice(14))),
          });
        if (path === "/v1/status" && request.method === "GET") return json(harness.status());
        if (path === "/v1/decisions/retry" && request.method === "POST")
          return json({ retried: harness.store.retryGates(owner) });
        const artifact = path.match(/^\/v1\/artifacts\/([0-9a-f-]{36})$/);
        if (artifact && request.method === "GET") {
          const row = harness.store.one<{ filename: string; mime: string }>(
            "SELECT filename,mime FROM artifacts WHERE id=? AND owner=? AND deleted=0",
            artifact[1]!,
            owner,
          );
          if (!row) return json({ error: "Artifact not found" }, 404);
          const file = Bun.file(
            join(harness.artifactDir, artifact[1]! + (row.mime === "image/png" ? ".png" : ".bin")),
          );
          if (!(await file.exists())) return json({ error: "Artifact expired" }, 404);
          return new Response(file, {
            headers: {
              "Content-Type": row.mime,
              "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(row.filename)}`,
              "Cache-Control": "no-store",
              "X-Content-Type-Options": "nosniff",
            },
          });
        }
        if (path === "/v1/events" && request.method === "POST") {
          const batch = BatchSchema.parse(await request.json());
          const results = harness.store.atomic(() =>
            batch.events.map((event) => ({
              ...harness.ingest(owner, event),
              id: event.id,
              revision: event.revision,
            })),
          );
          return json({ accepted: results }, 202);
        }
        if (path.startsWith("/v1/evidence/") && request.method === "DELETE") {
          harness.deleteEvidence(owner, decodeURIComponent(path.slice(13)));
          await harness.archive?.flush();
          return json({ deleted: true });
        }
        if (path === "/v1/memory/search" && request.method === "GET")
          return json(
            harness.store.search(
              owner,
              z.string().min(1).max(300).parse(url.searchParams.get("q")),
            ),
          );
        if (path.startsWith("/v1/memory/") && request.method === "DELETE")
          return json({ deleted: harness.store.forget(owner, decodeURIComponent(path.slice(11))) });
        if (path === "/v1/tasks" && request.method === "GET")
          return json({
            tasks: harness.store.tasks(owner).map((task) => ({
              ...task,
              goal: harness.reminders.labelForWake(task.id) ?? task.goal,
            })),
          });
        const taskRoute = path.match(/^\/v1\/tasks\/([^/]+)(?:\/(message|cancel))?$/);
        if (taskRoute) {
          const task = harness.store.task(decodeURIComponent(taskRoute[1]!));
          if (!task || task.owner !== owner) return json({ error: "Task not found" }, 404);
          if (request.method === "GET" && !taskRoute[2]) return json({ task });
          if (request.method === "POST" && taskRoute[2] === "cancel") {
            harness.cancel(task.id);
            return json({ cancelled: true });
          }
          if (request.method === "POST" && taskRoute[2] === "message") {
            const body = z
              .object({ text: z.string().min(1).max(4000), id: z.string().uuid() })
              .strict()
              .parse(await request.json());
            if (!["queued", "running", "waiting"].includes(task.status))
              return json({ error: "Task has ended" }, 409);
            harness.store.message(task.id, body.text, body.id);
            return json({ queued: true }, 202);
          }
        }
        if (path === "/v1/notifications" && request.method === "GET")
          return json({ notifications: harness.store.notifications(owner) });
        const ack = path.match(/^\/v1\/notifications\/([^/]+)\/ack$/);
        if (ack && request.method === "POST") {
          const id = decodeURIComponent(ack[1]!);
          const acked = harness.store.ack(owner, id);
          if (acked) harness.telemetry.emit("notification.acked", { notificationId: id });
          return json({ acked });
        }
        if (path === "/v1/notifications/stream" && request.method === "GET") {
          let cleanup = () => {};
          const body = new ReadableStream<Uint8Array>({
            start(controller) {
              const encoder = new TextEncoder();
              let sent = new Set<string>();
              let closed = false;
              const tick = () => {
                if (closed) return;
                try {
                  if ((controller.desiredSize ?? 0) <= 0) return;
                  const notifications = harness.store.notifications(owner);
                  controller.enqueue(encoder.encode(": heartbeat\n\n"));
                  for (const n of notifications)
                    if (!sent.has(n.id)) {
                      controller.enqueue(
                        encoder.encode(
                          `id: ${n.id}\nevent: notification\ndata: ${JSON.stringify(n)}\n\n`,
                        ),
                      );
                      sent.add(n.id);
                    }
                  sent = new Set([...sent].filter((id) => notifications.some((n) => n.id === id)));
                } catch {
                  cleanup();
                }
              };
              const timer = setInterval(tick, 100);
              cleanup = () => {
                if (closed) return;
                closed = true;
                clearInterval(timer);
                streams.delete(cleanup);
                request.signal.removeEventListener("abort", cleanup);
                try {
                  controller.close();
                } catch {}
              };
              streams.add(cleanup);
              request.signal.addEventListener("abort", cleanup, { once: true });
              tick();
            },
            cancel() {
              cleanup();
            },
          });
          return new Response(body, {
            headers: {
              "Content-Type": "text/event-stream",
              "Cache-Control": "no-store",
              "X-Accel-Buffering": "no",
            },
          });
        }
        return json({ error: "Not found" }, 404);
      } catch (error) {
        if (error instanceof z.ZodError)
          return json(
            {
              error: "Invalid request",
              issues: error.issues.map((i) => ({ path: i.path, code: i.code })),
            },
            400,
          );
        if (error instanceof Conflict) return json({ error: error.message }, 409);
        if (error instanceof SyntaxError) return json({ error: "Invalid JSON" }, 400);
        return json({ error: "Request failed; retry safely with the same event ID" }, 503);
      }
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    stop: async () => {
      for (const close of streams) close();
      for (const session of audio.values()) session.close();
      await server.stop(true);
    },
  };
}
