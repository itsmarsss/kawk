// KAWK PWA computer client. Plain TypeScript, bundled with `bun build` into app.js.
// Contract: docs/PWA_CONTRACT.md. Same-origin API only; the client token is exchanged once for
// an HttpOnly cookie and never persisted in the browser.
export {};

type SessionState = "connecting" | "connected" | "unavailable";
const RECONNECT_MS = 2000;

interface RuntimeStatus {
  running?: boolean;
  activeTurns?: number;
  lastError?: string | null;
  [key: string]: unknown;
}

interface CaptureStatus {
  faceConfigured?: boolean;
  sceneConfigured?: boolean;
  speechConfigured?: boolean;
  processing?: number;
  sceneProcessing?: number;
  lastError?: string | null;
}

interface Task {
  id: string;
  goal: string;
  mode: string;
  status: string;
  result: string | null;
  error: string | null;
  createdAt: number;
}

interface Reminder {
  id: string;
  text: string;
  dueAt: number;
  state: string;
}

interface Notification {
  id: string;
  text: string;
  refs?: unknown[];
  createdAt: number;
  expiresAt: number;
  state?: string;
}

interface Person {
  id: string;
  name: string;
  imageUrl: string;
}

interface TranscriptEvent {
  id: string;
  revision: number;
  final: boolean;
  text: string;
  sourceStart: number;
  sourceEnd: number;
}

interface ClockSync {
  offsetMs: number;
  uncertaintyMs: number;
  syncedAt: number;
  timeZone: string | null;
}

const POLL_MS = 5000;
const CLOCK_RESYNC_MS = 30000;
const FRAME_INTERVAL_MS = 500;
const FRAME_MAX_SIDE = 640;
const FRAME_QUALITY = 0.75;
const PCM_RATE = 16000;
const PCM_CHUNK_SAMPLES = 512;
const WS_MAX_BUFFERED = 64 * 1024;
const READY_TIMEOUT_MS = 20000;
// Manual utterances sent while the clock is unsynchronized carry a wide, honest uncertainty.
const UNSYNCED_UNCERTAINTY_MS = 5000;

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing element #${id}`);
  return el as T;
};

const show = (el: HTMLElement, visible: boolean) => {
  el.hidden = !visible;
};

const setError = (el: HTMLElement, message: string | null) => {
  el.textContent = message ?? "";
  el.hidden = !message;
};

const setPill = (el: HTMLElement, tone: "muted" | "ok" | "warn" | "bad" | "info", text: string) => {
  // Swap only the tone class so structural classes such as `status-pill` survive.
  for (const cls of [...el.classList]) if (cls.startsWith("pill-")) el.classList.remove(cls);
  el.classList.add("pill", `pill-${tone}`);
  el.textContent = text;
};

const fmtTime = (ms: number, timeZone?: string | null) => {
  if (!Number.isFinite(ms)) return "—";
  try {
    return new Intl.DateTimeFormat(undefined, {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      month: "short",
      day: "numeric",
      timeZone: timeZone ?? undefined,
    }).format(new Date(ms));
  } catch {
    return new Date(ms).toLocaleString();
  }
};

const fmtRelative = (ms: number, now: number) => {
  const delta = Math.round((ms - now) / 1000);
  const abs = Math.abs(delta);
  const unit = abs < 60 ? [abs, "s"] : abs < 3600 ? [Math.round(abs / 60), "min"] : abs < 86400 ? [Math.round(abs / 3600), "h"] : [Math.round(abs / 86400), "d"];
  return delta >= 0 ? `in ${unit[0]} ${unit[1]}` : `${unit[0]} ${unit[1]} ago`;
};

const describeError = (error: unknown): string => {
  if (error instanceof DOMException) {
    switch (error.name) {
      case "NotAllowedError":
      case "PermissionDeniedError":
        return "Permission denied. Allow access in the browser or OS settings and try again.";
      case "NotFoundError":
      case "DevicesNotFoundError":
        return "No matching device was found.";
      case "NotReadableError":
      case "TrackStartError":
        return "The device is busy or could not be read.";
      case "OverconstrainedError":
        return "The device does not support the requested settings.";
      case "SecurityError":
        return "Capture requires HTTPS (or localhost).";
      case "AbortError":
        return "Capture was aborted.";
    }
    return `${error.name}: ${error.message}`;
  }
  if (error instanceof Error) return error.message;
  return String(error);
};

/**
 * Human-readable task outcome. The agent's finish tool stores a JSON object
 * `{text, refs, notify, reviewRejected}` in `task.result`; plain-text results are preserved.
 */
const describeTaskResult = (task: Task): string => {
  if (task.error) return `Failed: ${task.error}`;
  if (task.status === "failed") return "Failed without an error message.";
  if (task.status === "cancelled") return "Cancelled.";
  if (task.result === null || task.result === undefined || task.result === "") {
    return task.status === "abstained" ? "Finished without anything to report." : "";
  }
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(task.result);
  } catch {
    return task.result;
  }
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const record = parsed as { text?: unknown; notify?: unknown; reviewRejected?: unknown };
    const text = typeof record.text === "string" ? record.text.trim() : "";
    const notes: string[] = [];
    if (record.reviewRejected === true) notes.push("delivery review rejected the notification");
    else if (record.notify === false && text) notes.push("not delivered as a notification");
    if (!text) return task.status === "abstained" ? "Finished without anything to report." : notes.length ? notes.join("; ") : "Finished.";
    return notes.length ? `${text}\n(${notes.join("; ")})` : text;
  }
  return typeof parsed === "string" ? parsed : task.result;
};

class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

// ---------------------------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------------------------

class Api {
  /** Called with the time the rejected request was started, so stale 401s can be ignored. */
  onUnauthorized: (startedAt: number) => void = () => {};
  onUnreachable: () => void = () => {};

  async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers);
    if (init.body !== undefined && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
    const startedAt = Date.now();
    let response: Response;
    try {
      response = await fetch(path, { ...init, headers, credentials: "same-origin", cache: "no-store" });
    } catch (error) {
      if (init.signal?.aborted) throw error;
      this.onUnreachable();
      throw new ApiError(0, "Agent unreachable");
    }
    if (response.status === 401) {
      this.onUnauthorized(startedAt);
      throw new ApiError(401, "Not connected");
    }
    let body: unknown = null;
    const text = await response.text();
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = null;
      }
    }
    if (!response.ok) {
      const message =
        body && typeof body === "object" && typeof (body as { error?: unknown }).error === "string"
          ? (body as { error: string }).error
          : `HTTP ${response.status}`;
      throw new ApiError(response.status, message);
    }
    return body as T;
  }

  get<T>(path: string) {
    return this.request<T>(path);
  }

  post<T>(path: string, body: unknown) {
    return this.request<T>(path, { method: "POST", body: JSON.stringify(body) });
  }

  delete<T>(path: string, body?: unknown) {
    return this.request<T>(path, { method: "DELETE", body: body === undefined ? undefined : JSON.stringify(body) });
  }
}

// ---------------------------------------------------------------------------------------------
// Clock synchronization (docs/PWA_CONTRACT.md "Clock")
// ---------------------------------------------------------------------------------------------

class Clock {
  sync: ClockSync | null = null;
  private timer: number | null = null;
  onChange: () => void = () => {};

  constructor(private api: Api) {}

  start() {
    this.stop();
    void this.resync();
    this.timer = window.setInterval(() => void this.resync(), CLOCK_RESYNC_MS);
  }

  stop() {
    if (this.timer !== null) window.clearInterval(this.timer);
    this.timer = null;
  }

  async resync(): Promise<ClockSync | null> {
    let best: ClockSync | null = null;
    for (let i = 0; i < 3; i++) {
      try {
        const clientSent = Date.now();
        const sample = await this.api.get<{ receivedAt: number; sentAt: number; timeZone?: string }>("/v1/time");
        const clientReceived = Date.now();
        const offset = (sample.receivedAt - clientSent + (sample.sentAt - clientReceived)) / 2;
        const roundTrip = clientReceived - clientSent;
        const uncertainty = Math.max(0, (roundTrip - (sample.sentAt - sample.receivedAt)) / 2);
        if (!best || uncertainty < best.uncertaintyMs) {
          best = { offsetMs: offset, uncertaintyMs: uncertainty, syncedAt: clientReceived, timeZone: sample.timeZone ?? null };
        }
      } catch (error) {
        if (error instanceof ApiError && error.status === 401) return null;
      }
    }
    if (best) {
      this.sync = best;
      this.onChange();
    }
    return best;
  }

  /** Corrected epoch for a local Date.now() value, or null when unsynchronized. */
  epoch(localMs = Date.now()): number | null {
    return this.sync ? Math.round(localMs + this.sync.offsetMs) : null;
  }

  /** Total uncertainty budget for a capture timestamp: clock error plus 50 ms as per contract. */
  uncertainty(): number {
    return Math.min(5000, Math.ceil((this.sync?.uncertaintyMs ?? 0) + 50));
  }

  get fresh(): boolean {
    return !!this.sync && Date.now() - this.sync.syncedAt < CLOCK_RESYNC_MS * 3;
  }
}

// ---------------------------------------------------------------------------------------------
// Camera capture (JPEG, long side <= 640, ~2 fps, one upload in flight)
// ---------------------------------------------------------------------------------------------

class Camera {
  private stream: MediaStream | null = null;
  private timer: number | null = null;
  private inFlight: AbortController | null = null;
  private streamId = "";
  private canvas = document.createElement("canvas");
  sent = 0;
  accepted = 0;
  failed = 0;
  skipped = 0;
  lastError: string | null = null;
  onChange: () => void = () => {};

  constructor(
    private api: Api,
    private clock: Clock,
    private video: HTMLVideoElement,
  ) {}

  get active() {
    return this.stream !== null;
  }

  get liveTracks() {
    return this.stream?.getTracks().filter((t) => t.readyState === "live").length ?? 0;
  }

  async start() {
    if (this.stream) return;
    if (!navigator.mediaDevices?.getUserMedia) throw new Error("Camera capture is not supported in this browser.");
    if (!this.clock.fresh) {
      const sync = await this.clock.resync();
      if (!sync) throw new Error("Clock is not synchronized with the agent; frames would not be timestamped exactly. Retry.");
    }
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    });
    this.stream = stream;
    this.streamId = crypto.randomUUID();
    this.sent = this.accepted = this.failed = this.skipped = 0;
    this.lastError = null;
    this.video.srcObject = stream;
    try {
      await this.video.play();
    } catch {
      /* autoplay policies: preview stays muted, capture continues */
    }
    for (const track of stream.getVideoTracks()) {
      track.addEventListener("ended", () => {
        this.lastError = "Camera track ended by the device or OS.";
        this.stop();
      });
    }
    this.timer = window.setInterval(() => void this.tick(), FRAME_INTERVAL_MS);
    this.onChange();
  }

  stop() {
    if (this.timer !== null) window.clearInterval(this.timer);
    this.timer = null;
    this.inFlight?.abort();
    this.inFlight = null;
    for (const track of this.stream?.getTracks() ?? []) track.stop();
    this.stream = null;
    this.video.pause();
    this.video.srcObject = null;
    this.onChange();
  }

  private async tick() {
    if (!this.stream || this.inFlight) {
      if (this.inFlight) this.skipped += 1;
      return;
    }
    const vw = this.video.videoWidth;
    const vh = this.video.videoHeight;
    if (!vw || !vh) return;
    const capturedLocal = Date.now();
    const epoch = this.clock.epoch(capturedLocal);
    if (epoch === null || !this.clock.fresh) {
      this.lastError = "Clock unsynchronized; frame not uploaded.";
      this.skipped += 1;
      this.onChange();
      return;
    }
    const scale = Math.min(1, FRAME_MAX_SIDE / Math.max(vw, vh));
    const w = Math.max(1, Math.round(vw * scale));
    const h = Math.max(1, Math.round(vh * scale));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    const ctx = this.canvas.getContext("2d");
    if (!ctx) return;
    ctx.drawImage(this.video, 0, 0, w, h);
    const blob = await new Promise<Blob | null>((resolve) => this.canvas.toBlob(resolve, "image/jpeg", FRAME_QUALITY));
    if (!blob || !this.stream) return;
    const base64 = await blobToBase64(blob);
    const controller = new AbortController();
    this.inFlight = controller;
    this.sent += 1;
    this.onChange();
    try {
      await this.api.request<{ accepted: boolean; id: string }>("/v1/capture/frame", {
        method: "POST",
        signal: controller.signal,
        body: JSON.stringify({
          id: crypto.randomUUID(),
          deviceId: "pwa",
          streamId: this.streamId,
          capturedAt: epoch,
          uncertaintyMs: this.clock.uncertainty(),
          imageBase64: base64,
        }),
      });
      this.accepted += 1;
      this.lastError = null;
    } catch (error) {
      if (controller.signal.aborted) return;
      this.failed += 1;
      this.lastError = describeError(error);
      if (error instanceof ApiError && error.status === 401) this.stop();
    } finally {
      if (this.inFlight === controller) this.inFlight = null;
      this.onChange();
    }
  }
}

const blobToBase64 = (blob: Blob) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("Could not encode frame"));
    reader.onload = () => {
      const result = String(reader.result ?? "");
      resolve(result.slice(result.indexOf(",") + 1));
    };
    reader.readAsDataURL(blob);
  });

// ---------------------------------------------------------------------------------------------
// Microphone capture (AudioWorklet -> PCM16 mono 16 kHz -> same-origin WebSocket)
// ---------------------------------------------------------------------------------------------

type MicPhase = "off" | "requesting" | "connecting" | "waiting-ready" | "streaming" | "error";

class Microphone {
  phase: MicPhase = "off";
  level = 0;
  packets = 0;
  lastError: string | null = null;
  streamId = "";
  private stream: MediaStream | null = null;
  private context: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private ws: WebSocket | null = null;
  private anchored = false;
  private stopping = false;
  private contextClosed = false;
  onChange: () => void = () => {};
  onTranscript: (event: TranscriptEvent) => void = () => {};

  constructor(private clock: Clock) {}

  get active() {
    return this.phase !== "off" && this.phase !== "error";
  }

  get liveTracks() {
    return this.stream?.getTracks().filter((t) => t.readyState === "live").length ?? 0;
  }

  get contextState() {
    return this.context?.state ?? (this.contextClosed ? "closed" : "none");
  }

  get socketState() {
    return this.ws?.readyState ?? WebSocket.CLOSED;
  }

  async start() {
    if (this.active) return;
    this.lastError = null;
    this.packets = 0;
    this.anchored = false;
    this.stopping = false;
    if (!navigator.mediaDevices?.getUserMedia) throw new Error("Microphone capture is not supported in this browser.");
    if (typeof AudioWorkletNode === "undefined") throw new Error("AudioWorklet is not supported in this browser.");
    this.setPhase("requesting");
    try {
      if (!this.clock.fresh) {
        const sync = await this.clock.resync();
        if (!sync) throw new Error("Clock is not synchronized with the agent; audio would not be timestamped exactly. Retry.");
      }
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: { ideal: 1 }, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: false,
      });
      this.stream = stream;
      const context = new AudioContext({ latencyHint: "interactive" });
      this.context = context;
      await context.audioWorklet.addModule("/audio-worklet.js");
      const node = new AudioWorkletNode(context, "kawk-pcm-chunker", {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
        processorOptions: { inputRate: context.sampleRate, outRate: PCM_RATE, chunkSamples: PCM_CHUNK_SAMPLES },
      });
      this.node = node;
      node.port.onmessage = (event: MessageEvent) => this.onWorkletMessage(event.data, context);
      const source = context.createMediaStreamSource(stream);
      this.source = source;
      source.connect(node);
      node.connect(context.destination); // silent output keeps the graph rendering
      if (context.state === "suspended") await context.resume();
      for (const track of stream.getAudioTracks()) {
        track.addEventListener("ended", () => this.fail("Microphone track ended by the device or OS."));
      }
      // Microphone is producing samples now. Open the cloud session; samples before `ready`
      // are discarded in onWorkletMessage (never replayed).
      this.setPhase("connecting");
      await this.openSocket();
    } catch (error) {
      this.fail(describeError(error));
      throw error;
    }
  }

  stop() {
    this.stopping = true;
    this.releaseAll();
    this.setPhase("off");
  }

  private setPhase(phase: MicPhase) {
    this.phase = phase;
    this.onChange();
  }

  private fail(message: string) {
    if (this.phase === "off" && !this.stream) return;
    this.lastError = message;
    this.releaseAll();
    this.setPhase("error");
  }

  private releaseAll() {
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onmessage = ws.onclose = ws.onerror = ws.onopen = null;
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close();
    }
    try {
      this.node?.port.postMessage({ type: "stop" });
    } catch {}
    this.source?.disconnect();
    this.node?.disconnect();
    this.source = null;
    this.node = null;
    for (const track of this.stream?.getTracks() ?? []) track.stop();
    this.stream = null;
    const context = this.context;
    this.context = null;
    if (context) {
      this.contextClosed = true;
      if (context.state !== "closed") void context.close().catch(() => {});
    }
    this.anchored = false;
    this.level = 0;
    this.streamId = "";
  }

  private openSocket() {
    return new Promise<void>((resolve, reject) => {
      const streamId = crypto.randomUUID(); // fresh stream UUID on every start/reconnect
      this.streamId = streamId;
      const protocol = location.protocol === "https:" ? "wss:" : "ws:";
      const ws = new WebSocket(`${protocol}//${location.host}/v1/capture/audio`);
      ws.binaryType = "arraybuffer";
      this.ws = ws;
      let settled = false;
      const readyTimer = window.setTimeout(() => {
        if (!settled) {
          settled = true;
          const message = "Speech service did not become ready in time.";
          reject(new Error(message));
          this.fail(message);
        }
      }, READY_TIMEOUT_MS);
      ws.onopen = () => {
        const epoch = this.clock.epoch();
        if (epoch === null) {
          settled = true;
          window.clearTimeout(readyTimer);
          const message = "Clock unsynchronized; cannot start audio session.";
          reject(new Error(message));
          this.fail(message);
          return;
        }
        ws.send(
          JSON.stringify({
            type: "start",
            deviceId: "pwa",
            streamId,
            capturedAt: epoch,
            uncertaintyMs: this.clock.uncertainty(),
          }),
        );
        this.setPhase("waiting-ready");
      };
      ws.onmessage = (event: MessageEvent) => {
        if (typeof event.data !== "string") return;
        let message: { type?: string; message?: string; event?: TranscriptEvent };
        try {
          message = JSON.parse(event.data);
        } catch {
          return;
        }
        if (message.type === "ready") {
          if (!settled) {
            settled = true;
            window.clearTimeout(readyTimer);
            resolve();
          }
          // Streaming begins with the next captured chunk: audio-start is sent immediately
          // before the first PCM packet in onWorkletMessage.
          this.setPhase("streaming");
        } else if (message.type === "transcript" && message.event) {
          this.onTranscript(message.event);
        } else if (message.type === "error") {
          const text = typeof message.message === "string" ? message.message : "Speech session error";
          if (!settled) {
            settled = true;
            window.clearTimeout(readyTimer);
            reject(new Error(text));
          }
          this.fail(text);
        }
      };
      ws.onerror = () => {
        if (!settled) {
          settled = true;
          window.clearTimeout(readyTimer);
          reject(new Error("Audio WebSocket connection failed."));
        }
        this.fail("Audio WebSocket connection failed.");
      };
      ws.onclose = (event: CloseEvent) => {
        if (this.stopping) return;
        const text = event.code === 1008 || event.code === 4401 ? "Audio session rejected (not connected)." : "Audio connection closed; restart the microphone to reconnect.";
        if (!settled) {
          settled = true;
          window.clearTimeout(readyTimer);
          reject(new Error(text));
        }
        this.fail(text);
      };
    });
  }

  private onWorkletMessage(data: { type: string; rms?: number; buffer?: ArrayBuffer; contextTime?: number }, context: AudioContext) {
    if (data.type === "level") {
      this.level = Math.min(1, (data.rms ?? 0) * 4);
      this.onChange();
      return;
    }
    if (data.type !== "chunk" || !data.buffer) return;
    const ws = this.ws;
    // Discard everything captured before the cloud is ready: never replay pre-ready audio.
    if (this.phase !== "streaming" || !ws || ws.readyState !== WebSocket.OPEN) return;
    if (!this.anchored) {
      // The chunk ended at contextTime; its first sample began chunkDuration earlier. Convert
      // the audio-context timeline to a local wall-clock estimate, then to the corrected epoch.
      const chunkMs = (PCM_CHUNK_SAMPLES / PCM_RATE) * 1000;
      const nowLocal = Date.now();
      const contextNow = context.currentTime;
      const blockEndLocal = nowLocal - Math.max(0, contextNow - (data.contextTime ?? contextNow)) * 1000;
      const inputLatencyMs = (context.baseLatency || 0) * 1000;
      const firstSampleLocal = blockEndLocal - chunkMs - inputLatencyMs;
      const epoch = this.clock.epoch(firstSampleLocal);
      if (epoch === null) {
        this.fail("Clock unsynchronized; audio was not sent.");
        return;
      }
      ws.send(JSON.stringify({ type: "audio-start", capturedAt: epoch, uncertaintyMs: this.clock.uncertainty() }));
      this.anchored = true;
    }
    if (ws.bufferedAmount > WS_MAX_BUFFERED) {
      // Bounded queue: silently dropping chunks would shift every later provider sample offset
      // away from the audio-start anchor, so the session ends instead. Restart gives a fresh
      // stream UUID and a fresh anchor.
      this.fail("Audio backpressure: network could not keep up, so the stream was stopped to keep capture timestamps exact. Restart the microphone.");
      return;
    }
    ws.send(data.buffer);
    this.packets += 1;
    if (this.packets % 8 === 0) this.onChange();
  }
}

// ---------------------------------------------------------------------------------------------
// Push registration
// ---------------------------------------------------------------------------------------------

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const output = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) output[i] = raw.charCodeAt(i);
  return output;
}

class Push {
  status = "Push not registered.";
  subscribed = false;
  onChange: () => void = () => {};

  constructor(private api: Api) {}

  get supported() {
    return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
  }

  async refresh() {
    if (!this.supported) {
      this.status = "Push is not supported in this browser.";
      this.onChange();
      return;
    }
    const registration = await navigator.serviceWorker.getRegistration("/");
    const subscription = await registration?.pushManager.getSubscription();
    this.subscribed = !!subscription;
    this.status = subscription ? "Push registered on this device." : Notification.permission === "denied" ? "Notifications are blocked for this site." : "Push not registered.";
    this.onChange();
  }

  async enable() {
    if (!this.supported) throw new Error("Push is not supported in this browser.");
    const permission = await Notification.requestPermission();
    if (permission !== "granted") throw new Error("Notification permission was not granted.");
    const { publicKey } = await this.api.get<{ publicKey: string }>("/v1/push/key");
    const registration = await navigator.serviceWorker.register("/sw.js", { scope: "/" });
    await navigator.serviceWorker.ready;
    const existing = await registration.pushManager.getSubscription();
    const subscription =
      existing ??
      (await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey) as BufferSource,
      }));
    await this.api.post("/v1/push/subscriptions", subscription.toJSON());
    this.subscribed = true;
    this.status = "Push registered on this device.";
    this.onChange();
  }

  async disable() {
    const registration = await navigator.serviceWorker.getRegistration("/");
    const subscription = await registration?.pushManager.getSubscription();
    if (subscription) {
      const endpoint = subscription.endpoint;
      await subscription.unsubscribe();
      await this.api.delete("/v1/push/subscriptions", { endpoint });
    }
    this.subscribed = false;
    this.status = "Push not registered.";
    this.onChange();
  }
}

// ---------------------------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------------------------

class App {
  api = new Api();
  clock = new Clock(this.api);
  camera: Camera;
  mic = new Microphone(this.clock);
  push = new Push(this.api);
  session: SessionState = "connecting";
  private pollTimer: number | null = null;
  private eventSource: EventSource | null = null;
  private notifications = new Map<string, Notification>();
  private acking = new Set<string>();
  private transcripts = new Map<string, TranscriptEvent>();
  private pushConfigured = true;

  // Elements
  private el = {
    sessionPill: $("session-pill"),
    retryBtn: $<HTMLButtonElement>("retry-btn"),
    runtimeUpdated: $("runtime-updated"),
    rtRunning: $("rt-running"),
    rtTurns: $("rt-turns"),
    rtError: $("rt-error"),
    rtFace: $("rt-face"),
    rtScene: $("rt-scene"),
    rtSpeech: $("rt-speech"),
    rtClock: $("rt-clock"),
    runtimeError: $("runtime-error"),
    ssePill: $("sse-pill"),
    notificationList: $<HTMLUListElement>("notification-list"),
    notificationError: $("notification-error"),
    pushEnableBtn: $<HTMLButtonElement>("push-enable-btn"),
    pushDisableBtn: $<HTMLButtonElement>("push-disable-btn"),
    pushStatus: $("push-status"),
    manualForm: $<HTMLFormElement>("manual-form"),
    manualText: $<HTMLTextAreaElement>("manual-text"),
    manualSendBtn: $<HTMLButtonElement>("manual-send-btn"),
    manualStatus: $("manual-status"),
    manualLog: $<HTMLUListElement>("manual-log"),
    cameraPill: $("camera-pill"),
    cameraPreview: $<HTMLVideoElement>("camera-preview"),
    cameraStartBtn: $<HTMLButtonElement>("camera-start-btn"),
    cameraStopBtn: $<HTMLButtonElement>("camera-stop-btn"),
    cameraStats: $("camera-stats"),
    cameraError: $("camera-error"),
    micPill: $("mic-pill"),
    micLevel: $("mic-level"),
    micStartBtn: $<HTMLButtonElement>("mic-start-btn"),
    micStopBtn: $<HTMLButtonElement>("mic-stop-btn"),
    micStats: $("mic-stats"),
    micError: $("mic-error"),
    transcriptList: $<HTMLUListElement>("transcript-list"),
    reminderList: $<HTMLUListElement>("reminder-list"),
    remindersCount: $("reminders-count"),
    reminderError: $("reminder-error"),
    taskList: $<HTMLUListElement>("task-list"),
    tasksCount: $("tasks-count"),
    taskError: $("task-error"),
    peopleGrid: $("people-grid"),
    peopleCount: $("people-count"),
    peopleError: $("people-error"),
    offlinePill: $("offline-pill"),
  };

  private tpl = {
    notification: $<HTMLTemplateElement>("notification-item"),
    task: $<HTMLTemplateElement>("task-item"),
    reminder: $<HTMLTemplateElement>("reminder-item"),
    transcript: $<HTMLTemplateElement>("transcript-item"),
    person: $<HTMLTemplateElement>("person-card"),
  };

  constructor() {
    this.camera = new Camera(this.api, this.clock, this.el.cameraPreview);
    this.api.onUnauthorized = (startedAt) => this.handleUnauthorized(startedAt);
    this.api.onUnreachable = () => this.markUnavailable("Agent unreachable");
    this.clock.onChange = () => this.renderClock();
    this.camera.onChange = () => this.renderCamera();
    this.mic.onChange = () => this.renderMic();
    this.mic.onTranscript = (event) => this.upsertTranscript(event);
    this.push.onChange = () => this.renderPush();
    this.bind();
  }

  private bind() {
    this.el.retryBtn.addEventListener("click", () => void this.connect());
    this.el.manualForm.addEventListener("submit", (event) => {
      event.preventDefault();
      void this.sendManual();
    });
    this.el.cameraStartBtn.addEventListener("click", () => void this.startCamera());
    this.el.cameraStopBtn.addEventListener("click", () => this.camera.stop());
    this.el.micStartBtn.addEventListener("click", () => void this.startMic());
    this.el.micStopBtn.addEventListener("click", () => this.mic.stop());
    this.el.pushEnableBtn.addEventListener("click", () => void this.enablePush());
    this.el.pushDisableBtn.addEventListener("click", () => void this.disablePush());
    this.el.notificationList.addEventListener("click", (event) => {
      const button = (event.target as HTMLElement).closest<HTMLButtonElement>(".ack-btn");
      const id = button?.closest<HTMLLIElement>("li")?.dataset.id;
      if (button && id) void this.ack(id, button);
    });
    window.addEventListener("online", () => this.renderOffline());
    window.addEventListener("offline", () => this.renderOffline());
    window.addEventListener("pagehide", () => {
      this.camera.stop();
      this.mic.stop();
    });
  }

  async boot() {
    this.renderOffline();
    this.registerServiceWorker();
    this.setSession("connecting");
    await this.connect();
  }

  // -- Session bootstrap -----------------------------------------------------------------------
  // The local page gets its HttpOnly session automatically: POST /v1/client/session with an
  // empty body and no Authorization header (the browser sends Origin). One bootstrap is in
  // flight at a time; failures retry every RECONNECT_MS.

  private bootstrapping: Promise<void> | null = null;
  private retryTimer: number | null = null;
  private lastConnectAt = 0;

  private connect(): Promise<void> {
    if (this.bootstrapping) return this.bootstrapping;
    if (this.retryTimer !== null) window.clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.bootstrapping = (async () => {
      if (this.session !== "connected") this.setSession("connecting");
      let failed = false;
      try {
        const response = await fetch("/v1/client/session", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
          credentials: "same-origin",
          cache: "no-store",
        });
        if (!response.ok) throw new Error(response.status === 401 || response.status === 403 ? "Agent refused a local session" : `HTTP ${response.status}`);
        this.lastConnectAt = Date.now();
        this.setSession("connected");
      } catch (error) {
        failed = true;
        this.setSession("unavailable", describeError(error));
      } finally {
        this.bootstrapping = null;
      }
      // Schedule after the in-flight flag is cleared, otherwise the guard would swallow it.
      if (failed) this.scheduleReconnect();
    })();
    return this.bootstrapping;
  }

  private scheduleReconnect() {
    if (this.retryTimer !== null || this.bootstrapping) return;
    this.retryTimer = window.setTimeout(() => {
      this.retryTimer = null;
      void this.connect();
    }, RECONNECT_MS);
  }

  /** A 401 after a successful bootstrap means the session went stale (e.g. runtime restart). */
  private handleUnauthorized(startedAt: number) {
    if (this.bootstrapping) return;
    // A request issued before the latest successful bootstrap carried the old cookie: ignore.
    if (startedAt < this.lastConnectAt) return;
    if (Date.now() - this.lastConnectAt < RECONNECT_MS) {
      // We just (re)connected and are still rejected: back off instead of looping.
      this.setSession("unavailable", "Session rejected");
      this.scheduleReconnect();
      return;
    }
    this.setSession("connecting");
    void this.connect();
  }

  private markUnavailable(reason: string) {
    if (this.bootstrapping) return;
    if (this.session === "unavailable") return;
    this.setSession("unavailable", reason);
    this.scheduleReconnect();
  }

  private registerServiceWorker() {
    if (!("serviceWorker" in navigator)) return;
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => {
        /* offline shell is optional */
      });
    });
  }

  // -- Session --------------------------------------------------------------------------------

  private setSession(state: SessionState, detail?: string) {
    const was = this.session;
    this.session = state;
    this.el.manualSendBtn.disabled = state !== "connected";
    show(this.el.retryBtn, state === "unavailable");
    if (state === "connected") {
      setPill(this.el.sessionPill, "ok", "Connected");
      if (was !== "connected") this.startLiveData();
      return;
    }
    if (state === "connecting") setPill(this.el.sessionPill, "muted", "Connecting…");
    else setPill(this.el.sessionPill, "bad", `Agent unavailable — retrying…${detail ? ` (${detail})` : ""}`);
    if (was === "connected") this.stopLiveData();
  }

  // -- Live data -------------------------------------------------------------------------------

  private startLiveData() {
    this.clock.start();
    void this.refreshAll();
    this.pollTimer = window.setInterval(() => void this.refreshAll(), POLL_MS);
    this.openStream();
    void this.push.refresh();
  }

  private stopLiveData() {
    this.clock.stop();
    if (this.pollTimer !== null) window.clearInterval(this.pollTimer);
    this.pollTimer = null;
    this.eventSource?.close();
    this.eventSource = null;
    if (this.stateRefreshTimer !== null) window.clearTimeout(this.stateRefreshTimer);
    this.stateRefreshTimer = null;
    setPill(this.el.ssePill, "muted", "stream idle");
    this.camera.stop();
    this.mic.stop();
  }

  private async refreshAll() {
    if (this.session !== "connected") return;
    await Promise.all([this.refreshRuntime(), this.refreshTasks(), this.refreshReminders(), this.refreshNotifications(), this.refreshPeople()]);
  }

  private async refreshRuntime() {
    try {
      const [status, capture] = await Promise.all([
        this.api.get<RuntimeStatus>("/v1/status"),
        this.api.get<CaptureStatus>("/v1/capture/status").catch((error: unknown) => {
          if (error instanceof ApiError && error.status === 401) throw error;
          return null;
        }),
      ]);
      this.el.rtRunning.textContent = status.running === undefined ? "unknown" : status.running ? "running" : "stopped";
      this.el.rtTurns.textContent = String(status.activeTurns ?? "—");
      this.el.rtError.textContent = status.lastError ? String(status.lastError) : "none";
      if (capture) {
        this.el.rtFace.textContent = capture.faceConfigured ? `configured${capture.processing ? ` · ${capture.processing} processing` : ""}` : "not configured";
        this.el.rtScene.textContent = capture.sceneConfigured ? `configured${capture.sceneProcessing ? ` · ${capture.sceneProcessing} processing` : ""}` : "not configured";
        this.el.rtSpeech.textContent = capture.speechConfigured ? "configured" : "not configured";
        if (capture.lastError) this.el.rtError.textContent = `${this.el.rtError.textContent === "none" ? "" : `${this.el.rtError.textContent} · `}capture: ${capture.lastError}`;
      } else {
        this.el.rtFace.textContent = this.el.rtScene.textContent = this.el.rtSpeech.textContent = "unavailable";
      }
      this.el.runtimeUpdated.textContent = `updated ${fmtTime(Date.now())}`;
      setError(this.el.runtimeError, null);
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) return;
      setError(this.el.runtimeError, `Status unavailable: ${describeError(error)}`);
      // The status endpoint failing with a network error or 5xx means the agent is down.
      if (error instanceof ApiError && (error.status === 0 || error.status >= 500)) this.markUnavailable(describeError(error));
    }
  }

  private renderClock() {
    const sync = this.clock.sync;
    this.el.rtClock.textContent = sync ? `offset ${sync.offsetMs >= 0 ? "+" : ""}${Math.round(sync.offsetMs)} ms · ±${Math.ceil(sync.uncertaintyMs)} ms${sync.timeZone ? ` · ${sync.timeZone}` : ""}` : "not synced";
  }

  private async refreshTasks() {
    try {
      const { tasks } = await this.api.get<{ tasks: Task[] }>("/v1/tasks");
      this.renderList(this.el.taskList, this.tpl.task, tasks, (task, li) => {
        li.dataset.id = task.id;
        li.querySelector(".item-text")!.textContent = task.goal;
        li.querySelector(".item-meta")!.textContent = `${task.mode} · ${fmtTime(task.createdAt, this.clock.sync?.timeZone)}`;
        const result = li.querySelector<HTMLElement>(".item-result")!;
        result.textContent = describeTaskResult(task);
        result.hidden = !result.textContent;
        result.classList.toggle("is-failure", task.status === "failed" || !!task.error);
        const pill = li.querySelector<HTMLElement>(".status-pill")!;
        setPill(pill, task.status === "running" || task.status === "waiting" ? "info" : task.status === "queued" ? "warn" : task.status === "completed" ? "ok" : task.status === "failed" ? "bad" : "muted", task.status);
      });
      this.el.tasksCount.textContent = String(tasks.length);
      setError(this.el.taskError, null);
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) return;
      setError(this.el.taskError, `Tasks unavailable: ${describeError(error)}`);
    }
  }

  private async refreshReminders() {
    try {
      const { reminders } = await this.api.get<{ reminders: Reminder[] }>("/v1/reminders");
      const now = this.clock.epoch() ?? Date.now();
      this.renderList(this.el.reminderList, this.tpl.reminder, reminders, (reminder, li) => {
        li.dataset.id = reminder.id;
        li.querySelector(".item-text")!.textContent = reminder.text;
        li.querySelector(".item-meta")!.textContent = `${fmtTime(reminder.dueAt, this.clock.sync?.timeZone)} · ${fmtRelative(reminder.dueAt, now)}`;
        setPill(li.querySelector<HTMLElement>(".status-pill")!, reminder.state === "failed" ? "bad" : reminder.state === "queued" ? "info" : "warn", reminder.state);
      });
      this.el.remindersCount.textContent = String(reminders.length);
      setError(this.el.reminderError, null);
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) return;
      setError(this.el.reminderError, `Reminders unavailable: ${describeError(error)}`);
    }
  }

  private async refreshNotifications() {
    try {
      const { notifications } = await this.api.get<{ notifications: Notification[] }>("/v1/notifications");
      const pending = notifications.filter((n) => !n.state || n.state === "pending");
      const ids = new Set(pending.map((n) => n.id));
      for (const id of [...this.notifications.keys()]) if (!ids.has(id) && !this.acking.has(id)) this.notifications.delete(id);
      for (const n of pending) this.notifications.set(n.id, n);
      this.renderNotifications();
      setError(this.el.notificationError, null);
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) return;
      setError(this.el.notificationError, `Notifications unavailable: ${describeError(error)}`);
    }
  }

  private async refreshPeople() {
    try {
      const { people } = await this.api.get<{ people: Person[] }>("/v1/people");
      this.el.peopleGrid.replaceChildren(
        ...people.map((person) => {
          const figure = (this.tpl.person.content.cloneNode(true) as DocumentFragment).firstElementChild as HTMLElement;
          const img = figure.querySelector("img")!;
          img.src = person.imageUrl.startsWith("/") ? person.imageUrl : "";
          img.alt = person.name;
          figure.querySelector("figcaption")!.textContent = person.name;
          return figure;
        }),
      );
      this.el.peopleCount.textContent = String(people.length);
      setError(this.el.peopleError, null);
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) return;
      setError(this.el.peopleError, `People unavailable: ${describeError(error)}`);
    }
  }

  private renderList<T>(list: HTMLUListElement, tpl: HTMLTemplateElement, items: T[], fill: (item: T, li: HTMLLIElement) => void) {
    list.replaceChildren(
      ...items.map((item) => {
        const li = (tpl.content.cloneNode(true) as DocumentFragment).firstElementChild as HTMLLIElement;
        fill(item, li);
        return li;
      }),
    );
  }

  // -- Notifications ---------------------------------------------------------------------------

  private openStream() {
    this.eventSource?.close();
    const source = new EventSource("/v1/notifications/stream");
    this.eventSource = source;
    setPill(this.el.ssePill, "warn", "connecting");
    source.onopen = () => setPill(this.el.ssePill, "ok", "live");
    source.onerror = () => {
      if (source.readyState === EventSource.CLOSED) {
        // The server ended the stream (stale session or restart); go through one bootstrap.
        setPill(this.el.ssePill, "bad", "stream closed");
        if (this.eventSource === source) this.markUnavailable("stream closed");
      } else setPill(this.el.ssePill, "warn", "reconnecting");
    };
    source.addEventListener("notification", (event: MessageEvent) => {
      try {
        const n = JSON.parse(event.data) as Notification;
        if (typeof n.id !== "string" || typeof n.text !== "string") return;
        if (n.state && n.state !== "pending") this.notifications.delete(n.id);
        else this.notifications.set(n.id, n);
        this.renderNotifications();
        this.scheduleStateRefresh();
      } catch {
        /* ignore malformed frames */
      }
    });
  }

  private stateRefreshTimer: number | null = null;

  /**
   * A delivered notification usually means a reminder fired or a task finished. Refresh those
   * lists shortly after the SSE event (the server reconciles within about one 100 ms tick)
   * instead of leaving them stale until the next poll.
   */
  private scheduleStateRefresh(delayMs = 350) {
    if (this.stateRefreshTimer !== null) window.clearTimeout(this.stateRefreshTimer);
    this.stateRefreshTimer = window.setTimeout(() => {
      this.stateRefreshTimer = null;
      if (this.session !== "connected") return;
      void Promise.all([this.refreshTasks(), this.refreshReminders(), this.refreshRuntime()]);
    }, delayMs);
  }

  private renderNotifications() {
    const items = [...this.notifications.values()].sort((a, b) => b.createdAt - a.createdAt);
    this.renderList(this.el.notificationList, this.tpl.notification, items, (n, li) => {
      li.dataset.id = n.id;
      li.querySelector(".item-text")!.textContent = n.text;
      li.querySelector(".item-meta")!.textContent = `${fmtTime(n.createdAt, this.clock.sync?.timeZone)} · expires ${fmtRelative(n.expiresAt, this.clock.epoch() ?? Date.now())}`;
      const button = li.querySelector<HTMLButtonElement>(".ack-btn")!;
      if (this.acking.has(n.id)) {
        button.disabled = true;
        button.textContent = "Acknowledging…";
      }
    });
  }

  private async ack(id: string, button: HTMLButtonElement) {
    if (this.acking.has(id)) return;
    this.acking.add(id);
    button.disabled = true;
    button.textContent = "Acknowledging…";
    try {
      const { acked } = await this.api.post<{ acked: boolean }>(`/v1/notifications/${encodeURIComponent(id)}/ack`, {});
      if (acked) this.notifications.delete(id);
      else setError(this.el.notificationError, "Notification was already acknowledged or expired.");
      this.acking.delete(id);
      this.renderNotifications();
    } catch (error) {
      this.acking.delete(id);
      this.renderNotifications();
      if (error instanceof ApiError && error.status === 401) return;
      setError(this.el.notificationError, `Acknowledge failed: ${describeError(error)}`);
    }
  }

  // -- Push ------------------------------------------------------------------------------------

  private renderPush() {
    this.el.pushStatus.textContent = this.push.status;
    show(this.el.pushEnableBtn, !this.push.subscribed);
    show(this.el.pushDisableBtn, this.push.subscribed);
    this.el.pushEnableBtn.disabled = !this.push.supported || !this.pushConfigured;
  }

  private async enablePush() {
    this.el.pushEnableBtn.disabled = true;
    this.el.pushStatus.textContent = "Requesting permission…";
    try {
      await this.push.enable();
    } catch (error) {
      if (error instanceof ApiError && error.status === 503) {
        this.pushConfigured = false;
        this.push.status = "Push is not configured on the agent.";
      } else this.push.status = `Push failed: ${describeError(error)}`;
      this.renderPush();
    } finally {
      this.el.pushEnableBtn.disabled = !this.push.supported || !this.pushConfigured;
    }
  }

  private async disablePush() {
    this.el.pushDisableBtn.disabled = true;
    try {
      await this.push.disable();
    } catch (error) {
      this.push.status = `Unsubscribe failed: ${describeError(error)}`;
      this.renderPush();
    } finally {
      this.el.pushDisableBtn.disabled = false;
    }
  }

  // -- Manual utterance ------------------------------------------------------------------------

  private async sendManual() {
    const text = this.el.manualText.value.trim();
    if (!text) return;
    this.el.manualSendBtn.disabled = true;
    this.el.manualStatus.textContent = "Sending…";
    // Corrected epoch when the clock is synced; otherwise resync once. If still unsynced,
    // the local clock is used and the timing uncertainty says so (whole seconds, not 50 ms).
    if (!this.clock.fresh) await this.clock.resync();
    const synced = this.clock.fresh;
    const epoch = this.clock.epoch() ?? Date.now();
    const uncertaintyMs = synced ? this.clock.uncertainty() : UNSYNCED_UNCERTAINTY_MS;
    const id = crypto.randomUUID();
    try {
      const response = await this.api.post<{ accepted: { id: string; revision: number; duplicate: boolean; current: boolean }[] }>("/v1/events", {
        events: [
          {
            id,
            deviceId: "pwa",
            streamId: "manual",
            revision: 0,
            kind: "transcript",
            final: true,
            sourceStart: epoch,
            sourceEnd: epoch,
            text,
            confidence: 1,
            speakerId: null,
            personIds: [],
            provenance: "pwa-manual",
            timing: { method: "capture", clockSessionId: "manual", uncertaintyMs },
          },
        ],
      });
      const receipt = response.accepted?.[0];
      this.el.manualStatus.textContent = receipt ? (receipt.duplicate ? "Duplicate ignored." : "Accepted.") : "Sent.";
      const li = document.createElement("li");
      li.className = "item";
      const body = document.createElement("div");
      body.className = "item-body";
      const p = document.createElement("p");
      p.className = "item-text";
      p.textContent = text;
      const meta = document.createElement("p");
      meta.className = "item-meta muted small";
      meta.textContent = `${fmtTime(epoch, this.clock.sync?.timeZone)} · ${synced ? "clock-corrected" : "local clock, unsynced"} · ±${uncertaintyMs} ms`;
      body.append(p, meta);
      li.append(body);
      this.el.manualLog.prepend(li);
      while (this.el.manualLog.children.length > 10) this.el.manualLog.lastElementChild?.remove();
      this.el.manualText.value = "";
      void this.refreshTasks();
    } catch (error) {
      this.el.manualStatus.textContent = error instanceof ApiError && error.status === 401 ? "Not connected." : `Failed: ${describeError(error)}`;
    } finally {
      this.el.manualSendBtn.disabled = false;
    }
  }

  // -- Camera ----------------------------------------------------------------------------------

  private async startCamera() {
    setError(this.el.cameraError, null);
    this.el.cameraStartBtn.disabled = true;
    try {
      await this.camera.start();
    } catch (error) {
      setError(this.el.cameraError, describeError(error));
      this.camera.stop();
    } finally {
      this.renderCamera();
    }
  }

  private renderCamera() {
    const active = this.camera.active;
    this.el.cameraStartBtn.disabled = active;
    this.el.cameraStopBtn.disabled = !active;
    this.el.cameraPreview.parentElement?.classList.toggle("live", active);
    setPill(this.el.cameraPill, active ? (this.camera.lastError ? "warn" : "ok") : "muted", active ? "streaming" : "off");
    const parts = [`${this.camera.accepted} accepted`, `${this.camera.sent} sent`];
    if (this.camera.failed) parts.push(`${this.camera.failed} failed`);
    if (this.camera.skipped) parts.push(`${this.camera.skipped} skipped`);
    this.el.cameraStats.textContent = parts.join(" · ");
    if (this.camera.lastError) setError(this.el.cameraError, this.camera.lastError);
    else if (active) setError(this.el.cameraError, null);
  }

  // -- Microphone ------------------------------------------------------------------------------

  private async startMic() {
    setError(this.el.micError, null);
    this.el.micStartBtn.disabled = true;
    try {
      await this.mic.start();
    } catch (error) {
      setError(this.el.micError, describeError(error));
    } finally {
      this.renderMic();
    }
  }

  private renderMic() {
    const phase = this.mic.phase;
    const active = this.mic.active;
    this.el.micStartBtn.disabled = active;
    this.el.micStopBtn.disabled = !active;
    const label: Record<MicPhase, [tone: "muted" | "ok" | "warn" | "bad" | "info", text: string]> = {
      off: ["muted", "off"],
      requesting: ["warn", "requesting mic"],
      connecting: ["warn", "connecting"],
      "waiting-ready": ["warn", "waiting for speech service"],
      streaming: ["ok", "streaming"],
      error: ["bad", "error"],
    };
    setPill(this.el.micPill, ...label[phase]);
    this.el.micLevel.style.width = `${Math.round(this.mic.level * 100)}%`;
    const parts = [`${this.mic.packets} packets sent`];
    this.el.micStats.textContent = parts.join(" · ");
    if (this.mic.lastError) setError(this.el.micError, this.mic.lastError);
    else if (active) setError(this.el.micError, null);
  }

  private upsertTranscript(event: TranscriptEvent) {
    if (typeof event.id !== "string" || typeof event.text !== "string") return;
    const previous = this.transcripts.get(event.id);
    if (previous && previous.revision > event.revision) return;
    this.transcripts.set(event.id, event);
    this.renderTranscripts();
  }

  private renderTranscripts() {
    const items = [...this.transcripts.values()].sort((a, b) => b.sourceStart - a.sourceStart).slice(0, 30);
    this.renderList(this.el.transcriptList, this.tpl.transcript, items, (t, li) => {
      li.dataset.id = t.id;
      li.dataset.final = String(!!t.final);
      li.querySelector(".item-text")!.textContent = t.text;
      li.querySelector(".item-meta")!.textContent = `${fmtTime(t.sourceStart, this.clock.sync?.timeZone)} · ${t.final ? "final" : "partial"} · rev ${t.revision}`;
    });
  }

  // -- Misc ------------------------------------------------------------------------------------

  private renderOffline() {
    show(this.el.offlinePill, !navigator.onLine);
  }
}

const app = new App();
void app.boot();

// Read-only diagnostics for tests and debugging (no secrets, no API access).
declare global {
  interface Window {
    kawkDebug?: () => Record<string, unknown>;
  }
}
window.kawkDebug = () => ({
  session: app.session,
  cameraActive: app.camera.active,
  cameraLiveTracks: app.camera.liveTracks,
  cameraSent: app.camera.sent,
  cameraAccepted: app.camera.accepted,
  micPhase: app.mic.phase,
  micLiveTracks: app.mic.liveTracks,
  micContextState: app.mic.contextState,
  micSocketState: app.mic.socketState,
  micPackets: app.mic.packets,
  clock: app.clock.sync,
});
