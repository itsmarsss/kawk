// web/app.ts
var RECONNECT_MS = 2000;
var POLL_MS = 5000;
var CLOCK_RESYNC_MS = 30000;
var FRAME_INTERVAL_MS = 500;
var FRAME_MAX_SIDE = 640;
var FRAME_QUALITY = 0.75;
var PCM_RATE = 16000;
var PCM_CHUNK_SAMPLES = 512;
var WS_MAX_BUFFERED = 64 * 1024;
var READY_TIMEOUT_MS = 20000;
var UNSYNCED_UNCERTAINTY_MS = 5000;
var $ = (id) => {
  const el = document.getElementById(id);
  if (!el)
    throw new Error(`Missing element #${id}`);
  return el;
};
var show = (el, visible) => {
  el.hidden = !visible;
};
var setError = (el, message) => {
  el.textContent = message ?? "";
  el.hidden = !message;
};
var setPill = (el, tone, text) => {
  for (const cls of [...el.classList])
    if (cls.startsWith("pill-"))
      el.classList.remove(cls);
  el.classList.add("pill", `pill-${tone}`);
  el.textContent = text;
};
var fmtTime = (ms, timeZone) => {
  if (!Number.isFinite(ms))
    return "—";
  try {
    return new Intl.DateTimeFormat(undefined, {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      month: "short",
      day: "numeric",
      timeZone: timeZone ?? undefined
    }).format(new Date(ms));
  } catch {
    return new Date(ms).toLocaleString();
  }
};
var fmtRelative = (ms, now) => {
  const delta = Math.round((ms - now) / 1000);
  const abs = Math.abs(delta);
  const unit = abs < 60 ? [abs, "s"] : abs < 3600 ? [Math.round(abs / 60), "min"] : abs < 86400 ? [Math.round(abs / 3600), "h"] : [Math.round(abs / 86400), "d"];
  return delta >= 0 ? `in ${unit[0]} ${unit[1]}` : `${unit[0]} ${unit[1]} ago`;
};
var describeError = (error) => {
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
  if (error instanceof Error)
    return error.message;
  return String(error);
};
var describeTaskResult = (task) => {
  if (task.error)
    return `Failed: ${task.error}`;
  if (task.status === "failed")
    return "Failed without an error message.";
  if (task.status === "cancelled")
    return "Cancelled.";
  if (task.result === null || task.result === undefined || task.result === "") {
    return task.status === "abstained" ? "Finished without anything to report." : "";
  }
  let parsed = null;
  try {
    parsed = JSON.parse(task.result);
  } catch {
    return task.result;
  }
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const record = parsed;
    const text = typeof record.text === "string" ? record.text.trim() : "";
    const notes = [];
    if (record.reviewRejected === true)
      notes.push("delivery review rejected the notification");
    else if (record.notify === false && text)
      notes.push("not delivered as a notification");
    if (!text)
      return task.status === "abstained" ? "Finished without anything to report." : notes.length ? notes.join("; ") : "Finished.";
    return notes.length ? `${text}
(${notes.join("; ")})` : text;
  }
  return typeof parsed === "string" ? parsed : task.result;
};

class ApiError extends Error {
  status;
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

class Api {
  onUnauthorized = () => {};
  onUnreachable = () => {};
  async request(path, init = {}) {
    const headers = new Headers(init.headers);
    if (init.body !== undefined && !headers.has("Content-Type"))
      headers.set("Content-Type", "application/json");
    const startedAt = Date.now();
    let response;
    try {
      response = await fetch(path, { ...init, headers, credentials: "same-origin", cache: "no-store" });
    } catch (error) {
      if (init.signal?.aborted)
        throw error;
      this.onUnreachable();
      throw new ApiError(0, "Agent unreachable");
    }
    if (response.status === 401) {
      this.onUnauthorized(startedAt);
      throw new ApiError(401, "Not connected");
    }
    let body = null;
    const text = await response.text();
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = null;
      }
    }
    if (!response.ok) {
      const message = body && typeof body === "object" && typeof body.error === "string" ? body.error : `HTTP ${response.status}`;
      throw new ApiError(response.status, message);
    }
    return body;
  }
  get(path) {
    return this.request(path);
  }
  post(path, body) {
    return this.request(path, { method: "POST", body: JSON.stringify(body) });
  }
  delete(path, body) {
    return this.request(path, { method: "DELETE", body: body === undefined ? undefined : JSON.stringify(body) });
  }
}

class Clock {
  api;
  sync = null;
  timer = null;
  onChange = () => {};
  constructor(api) {
    this.api = api;
  }
  start() {
    this.stop();
    this.resync();
    this.timer = window.setInterval(() => void this.resync(), CLOCK_RESYNC_MS);
  }
  stop() {
    if (this.timer !== null)
      window.clearInterval(this.timer);
    this.timer = null;
  }
  async resync() {
    let best = null;
    for (let i = 0;i < 3; i++) {
      try {
        const clientSent = Date.now();
        const sample = await this.api.get("/v1/time");
        const clientReceived = Date.now();
        const offset = (sample.receivedAt - clientSent + (sample.sentAt - clientReceived)) / 2;
        const roundTrip = clientReceived - clientSent;
        const uncertainty = Math.max(0, (roundTrip - (sample.sentAt - sample.receivedAt)) / 2);
        if (!best || uncertainty < best.uncertaintyMs) {
          best = { offsetMs: offset, uncertaintyMs: uncertainty, syncedAt: clientReceived, timeZone: sample.timeZone ?? null };
        }
      } catch (error) {
        if (error instanceof ApiError && error.status === 401)
          return null;
      }
    }
    if (best) {
      this.sync = best;
      this.onChange();
    }
    return best;
  }
  epoch(localMs = Date.now()) {
    return this.sync ? Math.round(localMs + this.sync.offsetMs) : null;
  }
  uncertainty() {
    return Math.min(5000, Math.ceil((this.sync?.uncertaintyMs ?? 0) + 50));
  }
  get fresh() {
    return !!this.sync && Date.now() - this.sync.syncedAt < CLOCK_RESYNC_MS * 3;
  }
}

class Camera {
  api;
  clock;
  video;
  stream = null;
  timer = null;
  inFlight = null;
  streamId = "";
  canvas = document.createElement("canvas");
  sent = 0;
  accepted = 0;
  failed = 0;
  skipped = 0;
  lastError = null;
  onChange = () => {};
  constructor(api, clock, video) {
    this.api = api;
    this.clock = clock;
    this.video = video;
  }
  get active() {
    return this.stream !== null;
  }
  get liveTracks() {
    return this.stream?.getTracks().filter((t) => t.readyState === "live").length ?? 0;
  }
  async start() {
    if (this.stream)
      return;
    if (!navigator.mediaDevices?.getUserMedia)
      throw new Error("Camera capture is not supported in this browser.");
    if (!this.clock.fresh) {
      const sync = await this.clock.resync();
      if (!sync)
        throw new Error("Clock is not synchronized with the agent; frames would not be timestamped exactly. Retry.");
    }
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false
    });
    this.stream = stream;
    this.streamId = crypto.randomUUID();
    this.sent = this.accepted = this.failed = this.skipped = 0;
    this.lastError = null;
    this.video.srcObject = stream;
    try {
      await this.video.play();
    } catch {}
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
    if (this.timer !== null)
      window.clearInterval(this.timer);
    this.timer = null;
    this.inFlight?.abort();
    this.inFlight = null;
    for (const track of this.stream?.getTracks() ?? [])
      track.stop();
    this.stream = null;
    this.video.pause();
    this.video.srcObject = null;
    this.onChange();
  }
  async tick() {
    if (!this.stream || this.inFlight) {
      if (this.inFlight)
        this.skipped += 1;
      return;
    }
    const vw = this.video.videoWidth;
    const vh = this.video.videoHeight;
    if (!vw || !vh)
      return;
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
    if (!ctx)
      return;
    ctx.drawImage(this.video, 0, 0, w, h);
    const blob = await new Promise((resolve) => this.canvas.toBlob(resolve, "image/jpeg", FRAME_QUALITY));
    if (!blob || !this.stream)
      return;
    const base64 = await blobToBase64(blob);
    const controller = new AbortController;
    this.inFlight = controller;
    this.sent += 1;
    this.onChange();
    try {
      await this.api.request("/v1/capture/frame", {
        method: "POST",
        signal: controller.signal,
        body: JSON.stringify({
          id: crypto.randomUUID(),
          deviceId: "pwa",
          streamId: this.streamId,
          capturedAt: epoch,
          uncertaintyMs: this.clock.uncertainty(),
          imageBase64: base64
        })
      });
      this.accepted += 1;
      this.lastError = null;
    } catch (error) {
      if (controller.signal.aborted)
        return;
      this.failed += 1;
      this.lastError = describeError(error);
      if (error instanceof ApiError && error.status === 401)
        this.stop();
    } finally {
      if (this.inFlight === controller)
        this.inFlight = null;
      this.onChange();
    }
  }
}
var blobToBase64 = (blob) => new Promise((resolve, reject) => {
  const reader = new FileReader;
  reader.onerror = () => reject(reader.error ?? new Error("Could not encode frame"));
  reader.onload = () => {
    const result = String(reader.result ?? "");
    resolve(result.slice(result.indexOf(",") + 1));
  };
  reader.readAsDataURL(blob);
});

class Microphone {
  clock;
  phase = "off";
  level = 0;
  packets = 0;
  lastError = null;
  streamId = "";
  stream = null;
  context = null;
  node = null;
  source = null;
  ws = null;
  anchored = false;
  stopping = false;
  contextClosed = false;
  onChange = () => {};
  onTranscript = () => {};
  constructor(clock) {
    this.clock = clock;
  }
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
    if (this.active)
      return;
    this.lastError = null;
    this.packets = 0;
    this.anchored = false;
    this.stopping = false;
    if (!navigator.mediaDevices?.getUserMedia)
      throw new Error("Microphone capture is not supported in this browser.");
    if (typeof AudioWorkletNode === "undefined")
      throw new Error("AudioWorklet is not supported in this browser.");
    this.setPhase("requesting");
    try {
      if (!this.clock.fresh) {
        const sync = await this.clock.resync();
        if (!sync)
          throw new Error("Clock is not synchronized with the agent; audio would not be timestamped exactly. Retry.");
      }
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: { ideal: 1 }, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: false
      });
      this.stream = stream;
      const context = new AudioContext({ latencyHint: "interactive" });
      this.context = context;
      await context.audioWorklet.addModule("/audio-worklet.js");
      const node = new AudioWorkletNode(context, "kawk-pcm-chunker", {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
        processorOptions: { inputRate: context.sampleRate, outRate: PCM_RATE, chunkSamples: PCM_CHUNK_SAMPLES }
      });
      this.node = node;
      node.port.onmessage = (event) => this.onWorkletMessage(event.data, context);
      const source = context.createMediaStreamSource(stream);
      this.source = source;
      source.connect(node);
      node.connect(context.destination);
      if (context.state === "suspended")
        await context.resume();
      for (const track of stream.getAudioTracks()) {
        track.addEventListener("ended", () => this.fail("Microphone track ended by the device or OS."));
      }
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
  setPhase(phase) {
    this.phase = phase;
    this.onChange();
  }
  fail(message) {
    if (this.phase === "off" && !this.stream)
      return;
    this.lastError = message;
    this.releaseAll();
    this.setPhase("error");
  }
  releaseAll() {
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onmessage = ws.onclose = ws.onerror = ws.onopen = null;
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)
        ws.close();
    }
    try {
      this.node?.port.postMessage({ type: "stop" });
    } catch {}
    this.source?.disconnect();
    this.node?.disconnect();
    this.source = null;
    this.node = null;
    for (const track of this.stream?.getTracks() ?? [])
      track.stop();
    this.stream = null;
    const context = this.context;
    this.context = null;
    if (context) {
      this.contextClosed = true;
      if (context.state !== "closed")
        context.close().catch(() => {});
    }
    this.anchored = false;
    this.level = 0;
    this.streamId = "";
  }
  openSocket() {
    return new Promise((resolve, reject) => {
      const streamId = crypto.randomUUID();
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
        ws.send(JSON.stringify({
          type: "start",
          deviceId: "pwa",
          streamId,
          capturedAt: epoch,
          uncertaintyMs: this.clock.uncertainty()
        }));
        this.setPhase("waiting-ready");
      };
      ws.onmessage = (event) => {
        if (typeof event.data !== "string")
          return;
        let message;
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
      ws.onclose = (event) => {
        if (this.stopping)
          return;
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
  onWorkletMessage(data, context) {
    if (data.type === "level") {
      this.level = Math.min(1, (data.rms ?? 0) * 4);
      this.onChange();
      return;
    }
    if (data.type !== "chunk" || !data.buffer)
      return;
    const ws = this.ws;
    if (this.phase !== "streaming" || !ws || ws.readyState !== WebSocket.OPEN)
      return;
    if (!this.anchored) {
      const chunkMs = PCM_CHUNK_SAMPLES / PCM_RATE * 1000;
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
      this.fail("Audio backpressure: network could not keep up, so the stream was stopped to keep capture timestamps exact. Restart the microphone.");
      return;
    }
    ws.send(data.buffer);
    this.packets += 1;
    if (this.packets % 8 === 0)
      this.onChange();
  }
}
function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const output = new Uint8Array(raw.length);
  for (let i = 0;i < raw.length; i++)
    output[i] = raw.charCodeAt(i);
  return output;
}

class Push {
  api;
  status = "Push not registered.";
  subscribed = false;
  onChange = () => {};
  constructor(api) {
    this.api = api;
  }
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
    if (!this.supported)
      throw new Error("Push is not supported in this browser.");
    const permission = await Notification.requestPermission();
    if (permission !== "granted")
      throw new Error("Notification permission was not granted.");
    const { publicKey } = await this.api.get("/v1/push/key");
    const registration = await navigator.serviceWorker.register("/sw.js", { scope: "/" });
    await navigator.serviceWorker.ready;
    const existing = await registration.pushManager.getSubscription();
    const subscription = existing ?? await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey)
    });
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

class App {
  api = new Api;
  clock = new Clock(this.api);
  camera;
  mic = new Microphone(this.clock);
  push = new Push(this.api);
  session = "connecting";
  pollTimer = null;
  eventSource = null;
  notifications = new Map;
  acking = new Set;
  transcripts = new Map;
  pushConfigured = true;
  el = {
    sessionPill: $("session-pill"),
    retryBtn: $("retry-btn"),
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
    notificationList: $("notification-list"),
    notificationError: $("notification-error"),
    pushEnableBtn: $("push-enable-btn"),
    pushDisableBtn: $("push-disable-btn"),
    pushStatus: $("push-status"),
    manualForm: $("manual-form"),
    manualText: $("manual-text"),
    manualSendBtn: $("manual-send-btn"),
    manualStatus: $("manual-status"),
    manualLog: $("manual-log"),
    cameraPill: $("camera-pill"),
    cameraPreview: $("camera-preview"),
    cameraStartBtn: $("camera-start-btn"),
    cameraStopBtn: $("camera-stop-btn"),
    cameraStats: $("camera-stats"),
    cameraError: $("camera-error"),
    micPill: $("mic-pill"),
    micLevel: $("mic-level"),
    micStartBtn: $("mic-start-btn"),
    micStopBtn: $("mic-stop-btn"),
    micStats: $("mic-stats"),
    micError: $("mic-error"),
    transcriptList: $("transcript-list"),
    reminderList: $("reminder-list"),
    remindersCount: $("reminders-count"),
    reminderError: $("reminder-error"),
    taskList: $("task-list"),
    tasksCount: $("tasks-count"),
    taskError: $("task-error"),
    peopleGrid: $("people-grid"),
    peopleCount: $("people-count"),
    peopleError: $("people-error"),
    offlinePill: $("offline-pill")
  };
  tpl = {
    notification: $("notification-item"),
    task: $("task-item"),
    reminder: $("reminder-item"),
    transcript: $("transcript-item"),
    person: $("person-card")
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
  bind() {
    this.el.retryBtn.addEventListener("click", () => void this.connect());
    this.el.manualForm.addEventListener("submit", (event) => {
      event.preventDefault();
      this.sendManual();
    });
    this.el.cameraStartBtn.addEventListener("click", () => void this.startCamera());
    this.el.cameraStopBtn.addEventListener("click", () => this.camera.stop());
    this.el.micStartBtn.addEventListener("click", () => void this.startMic());
    this.el.micStopBtn.addEventListener("click", () => this.mic.stop());
    this.el.pushEnableBtn.addEventListener("click", () => void this.enablePush());
    this.el.pushDisableBtn.addEventListener("click", () => void this.disablePush());
    this.el.notificationList.addEventListener("click", (event) => {
      const button = event.target.closest(".ack-btn");
      const id = button?.closest("li")?.dataset.id;
      if (button && id)
        this.ack(id, button);
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
  bootstrapping = null;
  retryTimer = null;
  lastConnectAt = 0;
  connect() {
    if (this.bootstrapping)
      return this.bootstrapping;
    if (this.retryTimer !== null)
      window.clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.bootstrapping = (async () => {
      if (this.session !== "connected")
        this.setSession("connecting");
      let failed = false;
      try {
        const response = await fetch("/v1/client/session", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
          credentials: "same-origin",
          cache: "no-store"
        });
        if (!response.ok)
          throw new Error(response.status === 401 || response.status === 403 ? "Agent refused a local session" : `HTTP ${response.status}`);
        this.lastConnectAt = Date.now();
        this.setSession("connected");
      } catch (error) {
        failed = true;
        this.setSession("unavailable", describeError(error));
      } finally {
        this.bootstrapping = null;
      }
      if (failed)
        this.scheduleReconnect();
    })();
    return this.bootstrapping;
  }
  scheduleReconnect() {
    if (this.retryTimer !== null || this.bootstrapping)
      return;
    this.retryTimer = window.setTimeout(() => {
      this.retryTimer = null;
      this.connect();
    }, RECONNECT_MS);
  }
  handleUnauthorized(startedAt) {
    if (this.bootstrapping)
      return;
    if (startedAt < this.lastConnectAt)
      return;
    if (Date.now() - this.lastConnectAt < RECONNECT_MS) {
      this.setSession("unavailable", "Session rejected");
      this.scheduleReconnect();
      return;
    }
    this.setSession("connecting");
    this.connect();
  }
  markUnavailable(reason) {
    if (this.bootstrapping)
      return;
    if (this.session === "unavailable")
      return;
    this.setSession("unavailable", reason);
    this.scheduleReconnect();
  }
  registerServiceWorker() {
    if (!("serviceWorker" in navigator))
      return;
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => {});
    });
  }
  setSession(state, detail) {
    const was = this.session;
    this.session = state;
    this.el.manualSendBtn.disabled = state !== "connected";
    show(this.el.retryBtn, state === "unavailable");
    if (state === "connected") {
      setPill(this.el.sessionPill, "ok", "Connected");
      if (was !== "connected")
        this.startLiveData();
      return;
    }
    if (state === "connecting")
      setPill(this.el.sessionPill, "muted", "Connecting…");
    else
      setPill(this.el.sessionPill, "bad", `Agent unavailable — retrying…${detail ? ` (${detail})` : ""}`);
    if (was === "connected")
      this.stopLiveData();
  }
  startLiveData() {
    this.clock.start();
    this.refreshAll();
    this.pollTimer = window.setInterval(() => void this.refreshAll(), POLL_MS);
    this.openStream();
    this.push.refresh();
  }
  stopLiveData() {
    this.clock.stop();
    if (this.pollTimer !== null)
      window.clearInterval(this.pollTimer);
    this.pollTimer = null;
    this.eventSource?.close();
    this.eventSource = null;
    if (this.stateRefreshTimer !== null)
      window.clearTimeout(this.stateRefreshTimer);
    this.stateRefreshTimer = null;
    setPill(this.el.ssePill, "muted", "stream idle");
    this.camera.stop();
    this.mic.stop();
  }
  async refreshAll() {
    if (this.session !== "connected")
      return;
    await Promise.all([this.refreshRuntime(), this.refreshTasks(), this.refreshReminders(), this.refreshNotifications(), this.refreshPeople()]);
  }
  async refreshRuntime() {
    try {
      const [status, capture] = await Promise.all([
        this.api.get("/v1/status"),
        this.api.get("/v1/capture/status").catch((error) => {
          if (error instanceof ApiError && error.status === 401)
            throw error;
          return null;
        })
      ]);
      this.el.rtRunning.textContent = status.running === undefined ? "unknown" : status.running ? "running" : "stopped";
      this.el.rtTurns.textContent = String(status.activeTurns ?? "—");
      this.el.rtError.textContent = status.lastError ? String(status.lastError) : "none";
      if (capture) {
        this.el.rtFace.textContent = capture.faceConfigured ? `configured${capture.processing ? ` · ${capture.processing} processing` : ""}` : "not configured";
        this.el.rtScene.textContent = capture.sceneConfigured ? `configured${capture.sceneProcessing ? ` · ${capture.sceneProcessing} processing` : ""}` : "not configured";
        this.el.rtSpeech.textContent = capture.speechConfigured ? "configured" : "not configured";
        if (capture.lastError)
          this.el.rtError.textContent = `${this.el.rtError.textContent === "none" ? "" : `${this.el.rtError.textContent} · `}capture: ${capture.lastError}`;
      } else {
        this.el.rtFace.textContent = this.el.rtScene.textContent = this.el.rtSpeech.textContent = "unavailable";
      }
      this.el.runtimeUpdated.textContent = `updated ${fmtTime(Date.now())}`;
      setError(this.el.runtimeError, null);
    } catch (error) {
      if (error instanceof ApiError && error.status === 401)
        return;
      setError(this.el.runtimeError, `Status unavailable: ${describeError(error)}`);
      if (error instanceof ApiError && (error.status === 0 || error.status >= 500))
        this.markUnavailable(describeError(error));
    }
  }
  renderClock() {
    const sync = this.clock.sync;
    this.el.rtClock.textContent = sync ? `offset ${sync.offsetMs >= 0 ? "+" : ""}${Math.round(sync.offsetMs)} ms · ±${Math.ceil(sync.uncertaintyMs)} ms${sync.timeZone ? ` · ${sync.timeZone}` : ""}` : "not synced";
  }
  async refreshTasks() {
    try {
      const { tasks } = await this.api.get("/v1/tasks");
      this.renderList(this.el.taskList, this.tpl.task, tasks, (task, li) => {
        li.dataset.id = task.id;
        li.querySelector(".item-text").textContent = task.goal;
        li.querySelector(".item-meta").textContent = `${task.mode} · ${fmtTime(task.createdAt, this.clock.sync?.timeZone)}`;
        const result = li.querySelector(".item-result");
        result.textContent = describeTaskResult(task);
        result.hidden = !result.textContent;
        result.classList.toggle("is-failure", task.status === "failed" || !!task.error);
        const pill = li.querySelector(".status-pill");
        setPill(pill, task.status === "running" || task.status === "waiting" ? "info" : task.status === "queued" ? "warn" : task.status === "completed" ? "ok" : task.status === "failed" ? "bad" : "muted", task.status);
      });
      this.el.tasksCount.textContent = String(tasks.length);
      setError(this.el.taskError, null);
    } catch (error) {
      if (error instanceof ApiError && error.status === 401)
        return;
      setError(this.el.taskError, `Tasks unavailable: ${describeError(error)}`);
    }
  }
  async refreshReminders() {
    try {
      const { reminders } = await this.api.get("/v1/reminders");
      const now = this.clock.epoch() ?? Date.now();
      this.renderList(this.el.reminderList, this.tpl.reminder, reminders, (reminder, li) => {
        li.dataset.id = reminder.id;
        li.querySelector(".item-text").textContent = reminder.text;
        li.querySelector(".item-meta").textContent = `${fmtTime(reminder.dueAt, this.clock.sync?.timeZone)} · ${fmtRelative(reminder.dueAt, now)}`;
        setPill(li.querySelector(".status-pill"), reminder.state === "failed" ? "bad" : reminder.state === "queued" ? "info" : "warn", reminder.state);
      });
      this.el.remindersCount.textContent = String(reminders.length);
      setError(this.el.reminderError, null);
    } catch (error) {
      if (error instanceof ApiError && error.status === 401)
        return;
      setError(this.el.reminderError, `Reminders unavailable: ${describeError(error)}`);
    }
  }
  async refreshNotifications() {
    try {
      const { notifications } = await this.api.get("/v1/notifications");
      const pending = notifications.filter((n) => !n.state || n.state === "pending");
      const ids = new Set(pending.map((n) => n.id));
      for (const id of [...this.notifications.keys()])
        if (!ids.has(id) && !this.acking.has(id))
          this.notifications.delete(id);
      for (const n of pending)
        this.notifications.set(n.id, n);
      this.renderNotifications();
      setError(this.el.notificationError, null);
    } catch (error) {
      if (error instanceof ApiError && error.status === 401)
        return;
      setError(this.el.notificationError, `Notifications unavailable: ${describeError(error)}`);
    }
  }
  async refreshPeople() {
    try {
      const { people } = await this.api.get("/v1/people");
      this.el.peopleGrid.replaceChildren(...people.map((person) => {
        const figure = this.tpl.person.content.cloneNode(true).firstElementChild;
        const img = figure.querySelector("img");
        img.src = person.imageUrl.startsWith("/") ? person.imageUrl : "";
        img.alt = person.name;
        figure.querySelector("figcaption").textContent = person.name;
        return figure;
      }));
      this.el.peopleCount.textContent = String(people.length);
      setError(this.el.peopleError, null);
    } catch (error) {
      if (error instanceof ApiError && error.status === 401)
        return;
      setError(this.el.peopleError, `People unavailable: ${describeError(error)}`);
    }
  }
  renderList(list, tpl, items, fill) {
    list.replaceChildren(...items.map((item) => {
      const li = tpl.content.cloneNode(true).firstElementChild;
      fill(item, li);
      return li;
    }));
  }
  openStream() {
    this.eventSource?.close();
    const source = new EventSource("/v1/notifications/stream");
    this.eventSource = source;
    setPill(this.el.ssePill, "warn", "connecting");
    source.onopen = () => setPill(this.el.ssePill, "ok", "live");
    source.onerror = () => {
      if (source.readyState === EventSource.CLOSED) {
        setPill(this.el.ssePill, "bad", "stream closed");
        if (this.eventSource === source)
          this.markUnavailable("stream closed");
      } else
        setPill(this.el.ssePill, "warn", "reconnecting");
    };
    source.addEventListener("notification", (event) => {
      try {
        const n = JSON.parse(event.data);
        if (typeof n.id !== "string" || typeof n.text !== "string")
          return;
        if (n.state && n.state !== "pending")
          this.notifications.delete(n.id);
        else
          this.notifications.set(n.id, n);
        this.renderNotifications();
        this.scheduleStateRefresh();
      } catch {}
    });
  }
  stateRefreshTimer = null;
  scheduleStateRefresh(delayMs = 350) {
    if (this.stateRefreshTimer !== null)
      window.clearTimeout(this.stateRefreshTimer);
    this.stateRefreshTimer = window.setTimeout(() => {
      this.stateRefreshTimer = null;
      if (this.session !== "connected")
        return;
      Promise.all([this.refreshTasks(), this.refreshReminders(), this.refreshRuntime()]);
    }, delayMs);
  }
  renderNotifications() {
    const items = [...this.notifications.values()].sort((a, b) => b.createdAt - a.createdAt);
    this.renderList(this.el.notificationList, this.tpl.notification, items, (n, li) => {
      li.dataset.id = n.id;
      li.querySelector(".item-text").textContent = n.text;
      li.querySelector(".item-meta").textContent = `${fmtTime(n.createdAt, this.clock.sync?.timeZone)} · expires ${fmtRelative(n.expiresAt, this.clock.epoch() ?? Date.now())}`;
      const button = li.querySelector(".ack-btn");
      if (this.acking.has(n.id)) {
        button.disabled = true;
        button.textContent = "Acknowledging…";
      }
    });
  }
  async ack(id, button) {
    if (this.acking.has(id))
      return;
    this.acking.add(id);
    button.disabled = true;
    button.textContent = "Acknowledging…";
    try {
      const { acked } = await this.api.post(`/v1/notifications/${encodeURIComponent(id)}/ack`, {});
      if (acked)
        this.notifications.delete(id);
      else
        setError(this.el.notificationError, "Notification was already acknowledged or expired.");
      this.acking.delete(id);
      this.renderNotifications();
    } catch (error) {
      this.acking.delete(id);
      this.renderNotifications();
      if (error instanceof ApiError && error.status === 401)
        return;
      setError(this.el.notificationError, `Acknowledge failed: ${describeError(error)}`);
    }
  }
  renderPush() {
    this.el.pushStatus.textContent = this.push.status;
    show(this.el.pushEnableBtn, !this.push.subscribed);
    show(this.el.pushDisableBtn, this.push.subscribed);
    this.el.pushEnableBtn.disabled = !this.push.supported || !this.pushConfigured;
  }
  async enablePush() {
    this.el.pushEnableBtn.disabled = true;
    this.el.pushStatus.textContent = "Requesting permission…";
    try {
      await this.push.enable();
    } catch (error) {
      if (error instanceof ApiError && error.status === 503) {
        this.pushConfigured = false;
        this.push.status = "Push is not configured on the agent.";
      } else
        this.push.status = `Push failed: ${describeError(error)}`;
      this.renderPush();
    } finally {
      this.el.pushEnableBtn.disabled = !this.push.supported || !this.pushConfigured;
    }
  }
  async disablePush() {
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
  async sendManual() {
    const text = this.el.manualText.value.trim();
    if (!text)
      return;
    this.el.manualSendBtn.disabled = true;
    this.el.manualStatus.textContent = "Sending…";
    if (!this.clock.fresh)
      await this.clock.resync();
    const synced = this.clock.fresh;
    const epoch = this.clock.epoch() ?? Date.now();
    const uncertaintyMs = synced ? this.clock.uncertainty() : UNSYNCED_UNCERTAINTY_MS;
    const id = crypto.randomUUID();
    try {
      const response = await this.api.post("/v1/events", {
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
            timing: { method: "capture", clockSessionId: "manual", uncertaintyMs }
          }
        ]
      });
      const receipt = response.accepted?.[0];
      this.el.manualStatus.textContent = receipt ? receipt.duplicate ? "Duplicate ignored." : "Accepted." : "Sent.";
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
      while (this.el.manualLog.children.length > 10)
        this.el.manualLog.lastElementChild?.remove();
      this.el.manualText.value = "";
      this.refreshTasks();
    } catch (error) {
      this.el.manualStatus.textContent = error instanceof ApiError && error.status === 401 ? "Not connected." : `Failed: ${describeError(error)}`;
    } finally {
      this.el.manualSendBtn.disabled = false;
    }
  }
  async startCamera() {
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
  renderCamera() {
    const active = this.camera.active;
    this.el.cameraStartBtn.disabled = active;
    this.el.cameraStopBtn.disabled = !active;
    this.el.cameraPreview.parentElement?.classList.toggle("live", active);
    setPill(this.el.cameraPill, active ? this.camera.lastError ? "warn" : "ok" : "muted", active ? "streaming" : "off");
    const parts = [`${this.camera.accepted} accepted`, `${this.camera.sent} sent`];
    if (this.camera.failed)
      parts.push(`${this.camera.failed} failed`);
    if (this.camera.skipped)
      parts.push(`${this.camera.skipped} skipped`);
    this.el.cameraStats.textContent = parts.join(" · ");
    if (this.camera.lastError)
      setError(this.el.cameraError, this.camera.lastError);
    else if (active)
      setError(this.el.cameraError, null);
  }
  async startMic() {
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
  renderMic() {
    const phase = this.mic.phase;
    const active = this.mic.active;
    this.el.micStartBtn.disabled = active;
    this.el.micStopBtn.disabled = !active;
    const label = {
      off: ["muted", "off"],
      requesting: ["warn", "requesting mic"],
      connecting: ["warn", "connecting"],
      "waiting-ready": ["warn", "waiting for speech service"],
      streaming: ["ok", "streaming"],
      error: ["bad", "error"]
    };
    setPill(this.el.micPill, ...label[phase]);
    this.el.micLevel.style.width = `${Math.round(this.mic.level * 100)}%`;
    const parts = [`${this.mic.packets} packets sent`];
    this.el.micStats.textContent = parts.join(" · ");
    if (this.mic.lastError)
      setError(this.el.micError, this.mic.lastError);
    else if (active)
      setError(this.el.micError, null);
  }
  upsertTranscript(event) {
    if (typeof event.id !== "string" || typeof event.text !== "string")
      return;
    const previous = this.transcripts.get(event.id);
    if (previous && previous.revision > event.revision)
      return;
    this.transcripts.set(event.id, event);
    this.renderTranscripts();
  }
  renderTranscripts() {
    const items = [...this.transcripts.values()].sort((a, b) => b.sourceStart - a.sourceStart).slice(0, 30);
    this.renderList(this.el.transcriptList, this.tpl.transcript, items, (t, li) => {
      li.dataset.id = t.id;
      li.dataset.final = String(!!t.final);
      li.querySelector(".item-text").textContent = t.text;
      li.querySelector(".item-meta").textContent = `${fmtTime(t.sourceStart, this.clock.sync?.timeZone)} · ${t.final ? "final" : "partial"} · rev ${t.revision}`;
    });
  }
  renderOffline() {
    show(this.el.offlinePill, !navigator.onLine);
  }
}
var app = new App;
app.boot();
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
  clock: app.clock.sync
});
