// Local mock of the KAWK agent API used only for PWA validation. It mirrors docs/PWA_CONTRACT.md
// shapes, keeps everything in memory, uses a random unused port and never touches provider
// services or real notifications. Not part of the runtime.
import { join } from "node:path";

export interface MockState {
  token: string;
  events: unknown[];
  frames: { id: string; streamId: string; capturedAt: number; uncertaintyMs: number; width: number; height: number; bytes: number }[];
  frameRejections: string[];
  acks: string[];
  notifications: { id: string; taskId: string; text: string; refs: unknown[]; createdAt: number; expiresAt: number; state: "pending" | "acked" | "withdrawn" }[];
  audioSessions: AudioSession[];
  audioMode: "ok" | "fail";
  sessionRequests: { authorized: boolean; bearer: boolean }[];
  /** false → every /v1/* request answers 503 (backend down). */
  available: boolean;
  /** Session bootstrap attempts answered 503 while unavailable. */
  sessionAttemptsWhileDown: number;
  /** Set ~100 ms after a `deliver:true` test notification: reminder fired, task-1 completed. */
  delivered: boolean;
}

export interface AudioSession {
  start: Record<string, unknown> | null;
  audioStart: Record<string, unknown> | null;
  binaryBeforeAudioStart: number;
  binaryBeforeReady: number;
  packets: number;
  bytes: number;
  oddLength: number;
  oversized: number;
  ready: boolean;
  closed: boolean;
  controlAfterStart: string[];
}

type WsData = { session: AudioSession };

const WEB_DIR = join(import.meta.dir, "..");
const COOKIE = "kawk_session";

export function startMockServer(options: { port?: number; readyDelayMs?: number } = {}) {
  const state: MockState = {
    token: `validation-${crypto.randomUUID()}${crypto.randomUUID()}`,
    events: [],
    frames: [],
    frameRejections: [],
    acks: [],
    notifications: [],
    audioSessions: [],
    audioMode: "ok",
    sessionRequests: [],
    delivered: false,
    available: true,
    sessionAttemptsWhileDown: 0,
  };
  const sessions = new Set<string>();
  const readyDelay = options.readyDelayMs ?? 300;

  const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
    Response.json(body, { status, headers: { "Cache-Control": "no-store", ...headers } });
  const cookieId = (request: Request) =>
    request.headers
      .get("cookie")
      ?.split(";")
      .map((s) => s.trim())
      .find((s) => s.startsWith(`${COOKIE}=`))
      ?.slice(COOKIE.length + 1);
  const authorized = (request: Request) => {
    const id = cookieId(request);
    return !!id && sessions.has(id);
  };

  const server = Bun.serve<WsData>({
    hostname: "127.0.0.1",
    port: options.port ?? 0,
    maxRequestBodySize: 2 * 1024 * 1024,
    websocket: {
      maxPayloadLength: 16000,
      open(ws) {
        const session: AudioSession = {
          start: null,
          audioStart: null,
          binaryBeforeAudioStart: 0,
          binaryBeforeReady: 0,
          packets: 0,
          bytes: 0,
          oddLength: 0,
          oversized: 0,
          ready: false,
          closed: false,
          controlAfterStart: [],
        };
        ws.data = { session };
        state.audioSessions.push(session);
      },
      message(ws, message) {
        const session = ws.data.session;
        if (typeof message === "string") {
          let value: Record<string, unknown>;
          try {
            value = JSON.parse(message);
          } catch {
            ws.send(JSON.stringify({ type: "error", message: "Invalid control JSON" }));
            ws.close();
            return;
          }
          if (value.type === "start" && !session.start) {
            session.start = value;
            if (state.audioMode === "fail") {
              setTimeout(() => {
                ws.send(JSON.stringify({ type: "error", message: "Speech service is not configured" }));
                ws.close();
              }, readyDelay);
              return;
            }
            setTimeout(() => {
              if (session.closed) return;
              session.ready = true;
              ws.send(JSON.stringify({ type: "ready", needsAudioStart: true }));
            }, readyDelay);
            return;
          }
          if (value.type === "audio-start" && session.ready && !session.audioStart) {
            session.audioStart = value;
            return;
          }
          session.controlAfterStart.push(String(value.type));
          return;
        }
        const bytes = message.byteLength;
        if (!session.ready) session.binaryBeforeReady += 1;
        if (!session.audioStart) session.binaryBeforeAudioStart += 1;
        if (bytes % 2) session.oddLength += 1;
        if (bytes > 16000) session.oversized += 1;
        session.packets += 1;
        session.bytes += bytes;
        if (session.packets === 8 && session.audioStart && session.start) {
          const anchor = Number(session.audioStart.capturedAt);
          const event = {
            id: `speech-${session.start.streamId}-1`,
            deviceId: "pwa",
            streamId: session.start.streamId,
            revision: 0,
            kind: "transcript",
            final: false,
            sourceStart: anchor,
            sourceEnd: anchor + 250,
            text: "testing the",
            confidence: 0.8,
            speakerId: null,
            personIds: [],
            provenance: "mock-whisper",
            timing: { method: "clock-mapped", clockSessionId: session.start.streamId, uncertaintyMs: 150 },
          };
          ws.send(JSON.stringify({ type: "transcript", event }));
        }
        if (session.packets === 16 && session.audioStart && session.start) {
          const anchor = Number(session.audioStart.capturedAt);
          const event = {
            id: `speech-${session.start.streamId}-1`,
            deviceId: "pwa",
            streamId: session.start.streamId,
            revision: 1,
            kind: "transcript",
            final: true,
            sourceStart: anchor,
            sourceEnd: anchor + 500,
            text: "testing the microphone path",
            confidence: 0.9,
            speakerId: null,
            personIds: [],
            provenance: "mock-whisper",
            timing: { method: "clock-mapped", clockSessionId: session.start.streamId, uncertaintyMs: 150 },
          };
          ws.send(JSON.stringify({ type: "transcript", event }));
        }
      },
      close(ws) {
        ws.data.session.closed = true;
      },
    },
    async fetch(request, server) {
      const receivedAt = Date.now();
      const url = new URL(request.url);
      const path = url.pathname;

      // Test-only control plane (never part of the real backend).
      if (path.startsWith("/__test/")) {
        if (path === "/__test/state") return json(state);
        if (path === "/__test/notify" && request.method === "POST") {
          const body = (await request.json()) as { text: string; ttlMs?: number; deliver?: boolean };
          const id = crypto.randomUUID();
          state.notifications.push({
            id,
            taskId: crypto.randomUUID(),
            text: body.text,
            refs: [],
            createdAt: Date.now(),
            expiresAt: Date.now() + (body.ttlMs ?? 600000),
            state: "pending",
          });
          // The real server reconciles reminder/task rows about one 100 ms tick after the SSE frame.
          if (body.deliver) setTimeout(() => {
            state.delivered = true;
          }, 120);
          return json({ id });
        }
        if (path === "/__test/audio-mode" && request.method === "POST") {
          state.audioMode = ((await request.json()) as { mode: "ok" | "fail" }).mode;
          return json({ mode: state.audioMode });
        }
        if (path === "/__test/revoke" && request.method === "POST") {
          sessions.clear(); // simulates a runtime restart: every cookie is now stale
          return json({ revoked: true });
        }
        if (path === "/__test/availability" && request.method === "POST") {
          state.available = ((await request.json()) as { available: boolean }).available;
          return json({ available: state.available });
        }
        if (path === "/__test/reset" && request.method === "POST") {
          state.events.length = 0;
          state.frames.length = 0;
          state.frameRejections.length = 0;
          state.acks.length = 0;
          state.audioSessions.length = 0;
          return json({ ok: true });
        }
        return json({ error: "Not found" }, 404);
      }

      if (!state.available && path.startsWith("/v1/")) {
        if (path === "/v1/client/session") state.sessionAttemptsWhileDown += 1;
        return json({ error: "Agent unavailable" }, 503);
      }
      if (path === "/v1/client/session" && request.method === "POST") {
        // Local page: no Authorization header, same-origin Origin header → automatic session.
        // Scripts may still present the bearer token.
        const auth = request.headers.get("authorization");
        const origin = request.headers.get("origin");
        const ok = auth ? auth === `Bearer ${state.token}` : !!origin && origin === url.origin;
        state.sessionRequests.push({ authorized: ok, bearer: !!auth });
        if (!ok) return json({ error: "Unauthorized" }, 401);
        const id = crypto.randomUUID();
        sessions.add(id);
        return json({ connected: true }, 200, {
          "Set-Cookie": `${COOKIE}=${id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400`,
        });
      }
      if (path === "/v1/client/session" && request.method === "DELETE") {
        const id = cookieId(request);
        if (id) sessions.delete(id);
        return json({ connected: false }, 200, { "Set-Cookie": `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0` });
      }

      if (request.method === "GET" && !path.startsWith("/v1/") && /^\/[a-zA-Z0-9_./-]*$/.test(path) && !path.includes("..")) {
        const file = Bun.file(join(WEB_DIR, path === "/" ? "index.html" : path.slice(1)));
        if (await file.exists()) return new Response(file, { headers: { "Cache-Control": path === "/sw.js" ? "no-cache" : "no-store" } });
        return new Response("Not found", { status: 404 });
      }

      if (!authorized(request)) return json({ error: "Unauthorized" }, 401);

      if (path === "/v1/capture/audio" && request.headers.get("upgrade") === "websocket") {
        if (server.upgrade(request, { data: { session: null as unknown as AudioSession } })) return;
        return json({ error: "WebSocket upgrade failed" }, 400);
      }
      if (path === "/v1/time") return json({ receivedAt, sentAt: Date.now(), timeZone: "America/Toronto" });
      if (path === "/v1/status") return json({ running: true, activeTurns: 0, lastError: null, telemetryDropped: 0, tasks: 2, evidence: 41 });
      if (path === "/v1/capture/status") return json({ faceConfigured: true, sceneConfigured: false, processing: 0, sceneProcessing: 0, lastError: null, speechConfigured: state.audioMode === "ok" });
      if (path === "/v1/tasks")
        return json({
          tasks: [
            // task-1 flips to completed with a finish-tool JSON result once a test notification fires.
            state.delivered
              ? { id: "task-1", owner: "owner", parentId: null, rootId: "task-1", goal: "Ask Bob about his trip", mode: "assist", status: "completed", messages: [], result: JSON.stringify({ text: "Reminder: ask Bob about his trip.", refs: [], notify: true, reviewRejected: false }), error: null, createdAt: Date.now() - 90000, deadline: Date.now() + 600000, steps: 3, tokens: 1200, capabilities: ["browser"] }
              : { id: "task-1", owner: "owner", parentId: null, rootId: "task-1", goal: "Ask Bob about his trip", mode: "assist", status: "running", messages: [], result: null, error: null, createdAt: Date.now() - 90000, deadline: Date.now() + 600000, steps: 3, tokens: 1200, capabilities: ["browser"] },
            { id: "task-2", owner: "owner", parentId: null, rootId: "task-2", goal: "Remember that Sarah prefers oat milk", mode: "memory", status: "completed", messages: [], result: JSON.stringify({ text: "Saved: Sarah prefers oat milk.", refs: [{ eventId: "e1", revision: 0 }], notify: false, reviewRejected: false }), error: null, createdAt: Date.now() - 3600000, deadline: Date.now(), steps: 1, tokens: 300, capabilities: [] },
            { id: "task-3", owner: "owner", parentId: null, rootId: "task-3", goal: "Look up the weather for the trip", mode: "assist", status: "failed", messages: [], result: null, error: "Model provider request failed", createdAt: Date.now() - 7200000, deadline: Date.now(), steps: 2, tokens: 800, capabilities: ["browser"] },
            { id: "task-4", owner: "owner", parentId: null, rootId: "task-4", goal: "Legacy plain-text result", mode: "assist", status: "completed", messages: [], result: "Plain text result kept verbatim.", error: null, createdAt: Date.now() - 9000000, deadline: Date.now(), steps: 1, tokens: 100, capabilities: [] },
          ],
        });
      if (path === "/v1/reminders")
        return json({
          reminders: state.delivered
            ? []
            : [{ id: "rem-1", text: "Ask Bob about his trip", dueAt: Date.now() + 5400000, personId: null, state: "pending", refs: [], evidenceRef: { eventId: "reminder-rem-1", revision: 0 } }],
        });
      if (path === "/v1/notifications") {
        for (const n of state.notifications) if (n.expiresAt <= Date.now() && n.state === "pending") n.state = "withdrawn";
        return json({ notifications: state.notifications.filter((n) => n.state === "pending") });
      }
      const ack = path.match(/^\/v1\/notifications\/([^/]+)\/ack$/);
      if (ack && request.method === "POST") {
        const id = decodeURIComponent(ack[1]!);
        const n = state.notifications.find((x) => x.id === id && x.state === "pending");
        if (n) {
          n.state = "acked";
          state.acks.push(id);
        }
        return json({ acked: !!n });
      }
      if (path === "/v1/notifications/stream") {
        let cleanup = () => {};
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            const encoder = new TextEncoder();
            const sent = new Set<string>();
            let closed = false;
            const tick = () => {
              if (closed) return;
              try {
                controller.enqueue(encoder.encode(": heartbeat\n\n"));
                for (const n of state.notifications)
                  if (n.state === "pending" && !sent.has(n.id)) {
                    controller.enqueue(encoder.encode(`id: ${n.id}\nevent: notification\ndata: ${JSON.stringify(n)}\n\n`));
                    sent.add(n.id);
                  }
              } catch {
                cleanup();
              }
            };
            const timer = setInterval(tick, 100);
            cleanup = () => {
              if (closed) return;
              closed = true;
              clearInterval(timer);
              try {
                controller.close();
              } catch {}
            };
            request.signal.addEventListener("abort", cleanup, { once: true });
            tick();
          },
          cancel() {
            cleanup();
          },
        });
        return new Response(body, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-store" } });
      }
      if (path === "/v1/people") return json({ people: [{ id: "11111111-1111-4111-8111-111111111111", name: "Sarah", imageUrl: "/v1/people/11111111-1111-4111-8111-111111111111/image" }] });
      if (path.match(/^\/v1\/people\/[0-9a-f-]{36}\/image$/)) return new Response(Bun.file(join(WEB_DIR, "icons/icon.svg")), { headers: { "Content-Type": "image/svg+xml", "Cache-Control": "no-store" } });
      if (path === "/v1/push/key") return json({ error: "Push is not configured" }, 503);
      if (path === "/v1/events" && request.method === "POST") {
        const batch = (await request.json()) as { events: { id: string; revision: number }[] };
        state.events.push(...batch.events);
        return json({ accepted: batch.events.map((e) => ({ id: e.id, revision: e.revision, duplicate: false, current: true })) }, 202);
      }
      if (path === "/v1/capture/frame" && request.method === "POST") {
        const frame = (await request.json()) as { id: string; deviceId: string; streamId: string; capturedAt: number; uncertaintyMs: number; imageBase64: string };
        const now = Date.now();
        const jpeg = Buffer.from(frame.imageBase64 ?? "", "base64");
        const problems: string[] = [];
        if (frame.deviceId !== "pwa") problems.push("deviceId");
        if (typeof frame.imageBase64 !== "string" || frame.imageBase64.startsWith("data:")) problems.push("base64 prefix");
        if (jpeg[0] !== 0xff || jpeg[1] !== 0xd8 || jpeg.at(-2) !== 0xff || jpeg.at(-1) !== 0xd9) problems.push("not a JPEG");
        if (!(frame.capturedAt <= now + 1000 && frame.capturedAt >= now - 120000)) problems.push("capturedAt outside live buffer");
        if (!(frame.uncertaintyMs >= 50 && frame.uncertaintyMs <= 5000)) problems.push("uncertaintyMs");
        const dims = jpegDimensions(jpeg);
        if (!dims) problems.push("no SOF marker");
        else if (Math.max(dims.width, dims.height) > 640) problems.push(`long side ${Math.max(dims.width, dims.height)} > 640`);
        if (problems.length) {
          state.frameRejections.push(problems.join(", "));
          return json({ error: problems.join(", ") }, 409);
        }
        state.frames.push({ id: frame.id, streamId: frame.streamId, capturedAt: frame.capturedAt, uncertaintyMs: frame.uncertaintyMs, width: dims!.width, height: dims!.height, bytes: jpeg.length });
        return json({ accepted: true, id: frame.id }, 202);
      }
      return json({ error: "Not found" }, 404);
    },
  });
  return { server, state, url: `http://127.0.0.1:${server.port}` };
}

/** Parse JPEG SOFn marker for width/height. */
export function jpegDimensions(buf: Buffer): { width: number; height: number } | null {
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) {
      i += 1;
      continue;
    }
    const marker = buf[i + 1]!;
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    const length = buf.readUInt16BE(i + 2);
    if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) || (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf)) {
      return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    }
    i += 2 + length;
  }
  return null;
}

if (import.meta.main) {
  const { url, state } = startMockServer({ port: Number(process.env.PORT ?? 0) });
  console.log(`KAWK mock API + static server on ${url}`);
  console.log(`Client token: ${state.token}`);
}
