// KAWK testing-page probe: token-free auto-connect, reconnect after a revoked session,
// recovery when the agent is unavailable at load, manual send, notifications + ack, review fixes
// (backpressure, [hidden], task results, SSE refresh), service worker/manifest, screenshots.
// Local mock API on a random unused port; Chromium fake media devices; no provider keys.
// Run from agent/: `bun build web/app.ts --outfile web/app.js --target browser --format esm && bun web/validation/probe.ts`
import { chromium, type Page } from "playwright";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { startMockServer, type MockState } from "./mock-server";

const OUT_DIR = join(import.meta.dir, "../../data/pwa-validation");
const results: { name: string; ok: boolean; detail?: string }[] = [];
const check = (name: string, ok: boolean, detail?: string) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor<T>(fn: () => Promise<T> | T, predicate: (v: T) => boolean, timeoutMs = 8000, everyMs = 50): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last = await fn();
  while (!predicate(last) && Date.now() < deadline) {
    await sleep(everyMs);
    last = await fn();
  }
  return last;
}
const fetchState = async (url: string) => (await fetch(`${url}/__test/state`)).json() as Promise<MockState>;
const control = (url: string, path: string, body: unknown) => fetch(`${url}/__test/${path}`, { method: "POST", body: JSON.stringify(body) });
const display = (page: Page, selector: string) => page.evaluate((s) => getComputedStyle(document.querySelector(s)!).display, selector);
const debug = (page: Page) => page.evaluate(() => window.kawkDebug?.() ?? {});
const sessionText = (page: Page) => page.textContent("#session-pill").then((t) => t ?? "");

declare global {
  interface Window {
    kawkDebug?: () => Record<string, unknown>;
  }
}

async function openConnected(page: Page, url: string) {
  await page.goto(url);
  await waitFor(() => sessionText(page), (t) => t === "Connected", 8000);
  await page.waitForFunction(() => document.getElementById("rt-running")?.textContent === "running");
}

async function main() {
  const { server, state, url } = startMockServer({ readyDelayMs: 300 });
  if (server.port === 8082 || server.port === 8091) throw new Error("Random port collided with a reserved port; rerun");
  console.log(`Mock server: ${url}`);
  await mkdir(OUT_DIR, { recursive: true });
  const browser = await chromium.launch({ headless: true, args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--autoplay-policy=no-user-gesture-required"] });
  const pageErrors: string[] = [];

  try {
    // ------------------------------------------------------------------ Auto-connect, no token UI
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, permissions: ["camera", "microphone"] });
    const page = await ctx.newPage();
    page.on("pageerror", (e) => pageErrors.push(e.message));
    await page.goto(url);
    const connected = await waitFor(() => sessionText(page), (t) => t === "Connected", 8000);
    check("Page auto-connects on load without any token input", connected === "Connected", connected);
    check("No token input, login form or Disconnect button exists", (await page.locator("#token-input, #login-form, #login-panel, #logout-btn, input[type=password]").count()) === 0);
    check("Page text never asks for a client token", !/client token|paste/i.test((await page.textContent("body")) ?? ""));
    const sessionReq = (await fetchState(url)).sessionRequests;
    check("Session was created cookie-only (Origin, no Authorization header)", sessionReq.length >= 1 && sessionReq.every((r) => r.authorized && !r.bearer), JSON.stringify(sessionReq));
    const cookie = (await ctx.cookies(url)).find((c) => c.name === "kawk_session");
    check("Session cookie is HttpOnly", !!cookie && cookie.httpOnly);
    check("Camera/mic are off and no push permission was requested on load", (await page.textContent("#camera-pill")) === "off" && (await page.textContent("#mic-pill")) === "off" && (await page.evaluate(() => Notification.permission)) !== "granted" && (await fetchState(url)).frames.length === 0 && (await fetchState(url)).audioSessions.length === 0);
    check("Retry button hidden while connected; offline pill hidden while online", (await display(page, "#retry-btn")) === "none" && (await display(page, "#offline-pill")) === "none");
    check("Capture and Details sections start collapsed", !(await page.evaluate(() => (document.getElementById("capture-details") as HTMLDetailsElement).open || (document.getElementById("details") as HTMLDetailsElement).open)));
    const mainHeight = await page.evaluate(() => Math.ceil(document.body.getBoundingClientRect().height));
    check("Main view is short: body under 600 px tall on desktop with sections collapsed", mainHeight < 600, `${mainHeight} px`);

    // Manual send
    await page.waitForFunction(() => /offset/.test(document.getElementById("rt-clock")?.textContent ?? ""));
    const utterance = "remind me to ask Bob about his trip <b>not html</b>";
    await page.fill("#manual-text", utterance);
    await page.click("#manual-send-btn");
    await page.waitForFunction(() => document.getElementById("manual-status")?.textContent === "Accepted.");
    const clock = (await debug(page)).clock as { offsetMs: number; uncertaintyMs: number } | null;
    const event = (await fetchState(url)).events[0] as Record<string, unknown> & { timing: { method: string; clockSessionId: string; uncertaintyMs: number } };
    check(
      "Manual send posts a contract-shaped final transcript with clock-corrected epoch and measured uncertainty",
      event.kind === "transcript" && event.final === true && event.deviceId === "pwa" && event.streamId === "manual" && event.provenance === "pwa-manual" && event.text === utterance && event.confidence === 1 && event.revision === 0 && event.speakerId === null && event.timing.method === "capture" && event.timing.clockSessionId === "manual" && !!clock && event.timing.uncertaintyMs === Math.min(5000, Math.ceil(clock.uncertaintyMs + 50)) && Math.abs((event.sourceStart as number) - (Date.now() + clock.offsetMs)) < 5000,
      `uncertaintyMs=${event.timing.uncertaintyMs}`,
    );
    check("Manual log escapes HTML", (await page.innerHTML("#manual-log")).includes("&lt;b&gt;") && !(await page.innerHTML("#manual-log")).includes("<b>not html</b>"));

    // Notifications over SSE + explicit ack + refresh of reminders/tasks
    await waitFor(() => page.textContent("#sse-pill"), (t) => t === "live");
    await page.evaluate(() => {
      (document.getElementById("details") as HTMLDetailsElement).open = true;
    });
    await page.waitForFunction(() => document.querySelectorAll("#task-list li").length === 4 && document.querySelectorAll("#reminder-list li").length === 1);
    const notifyText = "Ask Bob about his trip <img src=x onerror=alert(1)>";
    const { id } = (await (await control(url, "notify", { text: notifyText, deliver: true })).json()) as { id: string };
    const notifyAt = Date.now();
    await page.waitForSelector(`#notification-list li[data-id="${id}"]`);
    check("Notification arrives over SSE and renders as text", (await page.textContent(`#notification-list li[data-id="${id}"] .item-text`)) === notifyText && !(await page.innerHTML("#notification-list")).includes("<img"));
    const remindersLeft = await waitFor(() => page.locator("#reminder-list li").count(), (n) => n === 0, 3000);
    const refreshMs = Date.now() - notifyAt;
    check("Reminder/task lists refresh shortly after the SSE event", remindersLeft === 0 && refreshMs < 2500 && (await page.textContent('#task-list li[data-id="task-1"] .status-pill')) === "completed", `${refreshMs} ms (poll is 5000 ms)`);
    await sleep(800);
    check("Notification is never auto-acknowledged", (await fetchState(url)).acks.length === 0);
    await page.click(`#notification-list li[data-id="${id}"] .ack-btn`);
    await page.waitForSelector(`#notification-list li[data-id="${id}"]`, { state: "detached" });
    check("Acknowledge posts to /v1/notifications/{id}/ack and removes the item", (await fetchState(url)).acks[0] === id);

    // Task results readable (review fix 3)
    const t2 = (await page.textContent('#task-list li[data-id="task-2"] .item-result'))?.trim();
    const t3 = (await page.textContent('#task-list li[data-id="task-3"] .item-result'))?.trim();
    const t4 = (await page.textContent('#task-list li[data-id="task-4"] .item-result'))?.trim();
    check("Task results show finish text / failure / plain text, not raw JSON", t2 === "Saved: Sarah prefers oat milk.\n(not delivered as a notification)" && t3 === "Failed: Model provider request failed" && t4 === "Plain text result kept verbatim." && !/\{"text"/.test(await page.innerHTML("#task-list")), JSON.stringify([t2, t3, t4]));
    await page.screenshot({ path: join(OUT_DIR, "plain-desktop-details.png"), fullPage: true });
    await page.evaluate(() => {
      (document.getElementById("details") as HTMLDetailsElement).open = false;
    });
    await page.screenshot({ path: join(OUT_DIR, "plain-desktop.png"), fullPage: true });

    // ------------------------------------------------------------------ Reconnect after revoked session
    await control(url, "revoke", {});
    const stateSeen: string[] = [];
    const reconnected = await waitFor(
      async () => {
        const t = await sessionText(page);
        if (stateSeen.at(-1) !== t) stateSeen.push(t);
        return (await fetchState(url)).sessionRequests.length;
      },
      (n) => n >= 2 && stateSeen.at(-1) === "Connected",
      12000,
    );
    const sessionsAfterRevoke = (await fetchState(url)).sessionRequests.length;
    check("Revoked session (runtime restart) → 401 → exactly one new session bootstrap → Connected, no unavailable flash", reconnected === 2 && (await sessionText(page)) === "Connected" && !stateSeen.some((s) => /unavailable/i.test(s)), `bootstraps=${sessionsAfterRevoke} states=${stateSeen.join(" → ")}`);
    await sleep(2500);
    check("No reconnect loop after recovery", (await fetchState(url)).sessionRequests.length === sessionsAfterRevoke, `bootstraps still ${sessionsAfterRevoke}`);
    await waitFor(() => page.textContent("#sse-pill"), (t) => t === "live", 6000);
    await page.fill("#manual-text", "still works after reconnect");
    await page.click("#manual-send-btn");
    await page.waitForFunction(() => document.getElementById("manual-status")?.textContent === "Accepted.");
    check("Manual send and SSE work after reconnect", (await fetchState(url)).events.length === 2 && (await page.textContent("#sse-pill")) === "live");

    // ------------------------------------------------------------------ Agent unavailable while connected → retrying → recovers
    await control(url, "availability", { available: false });
    const unavailable = await waitFor(() => sessionText(page), (t) => /unavailable/i.test(t), 8000);
    check("Agent going down shows 'Agent unavailable — retrying…' and Retry button", /Agent unavailable — retrying/.test(unavailable) && (await display(page, "#retry-btn")) !== "none" && (await page.isDisabled("#manual-send-btn")), unavailable);
    const before = (await fetchState(url)).sessionAttemptsWhileDown;
    await sleep(4500);
    const attempts = (await fetchState(url)).sessionAttemptsWhileDown - before;
    check("Bounded retry (~2 s) while down: about 2 attempts in 4.5 s", attempts >= 1 && attempts <= 3, `${attempts} attempts`);
    await control(url, "availability", { available: true });
    const back = await waitFor(() => sessionText(page), (t) => t === "Connected", 6000);
    check("Recovers to Connected within one retry interval after the agent returns", back === "Connected", back);
    await ctx.close();

    // ------------------------------------------------------------------ Unavailable at first load
    await control(url, "availability", { available: false });
    const cold = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const coldPage = await cold.newPage();
    coldPage.on("pageerror", (e) => pageErrors.push(e.message));
    await coldPage.goto(url);
    const coldState = await waitFor(() => sessionText(coldPage), (t) => /unavailable/i.test(t), 6000);
    check("Unavailable at load: page renders with retrying state, no token prompt", /Agent unavailable — retrying/.test(coldState) && (await coldPage.locator("#token-input").count()) === 0, coldState);
    await coldPage.screenshot({ path: join(OUT_DIR, "plain-desktop-unavailable.png"), fullPage: true });
    await control(url, "availability", { available: true });
    const coldBack = await waitFor(() => sessionText(coldPage), (t) => t === "Connected", 6000);
    check("Unavailable at load recovers automatically once the agent is up", coldBack === "Connected" && (await coldPage.isEnabled("#manual-send-btn")), coldBack);
    await coldPage.click("#retry-btn").catch(() => {}); // hidden when connected; must be a no-op
    await cold.close();

    // ------------------------------------------------------------------ Review fix 1: backpressure ends the mic session
    const bp = await browser.newContext({ viewport: { width: 1280, height: 900 }, permissions: ["camera", "microphone"] });
    await bp.addInitScript(() => {
      Object.defineProperty(WebSocket.prototype, "bufferedAmount", { get: () => 1_000_000, configurable: true });
    });
    const bpPage = await bp.newPage();
    bpPage.on("pageerror", (e) => pageErrors.push(e.message));
    await control(url, "reset", {});
    await openConnected(bpPage, url);
    await bpPage.evaluate(() => {
      (document.getElementById("capture-details") as HTMLDetailsElement).open = true;
    });
    await bpPage.click("#mic-start-btn");
    await bpPage.waitForSelector("#mic-error:not([hidden])", { timeout: 20000 });
    const bpErr = await bpPage.textContent("#mic-error");
    const bpDbg = await waitFor(() => debug(bpPage), (d) => d.micContextState === "closed", 5000);
    const bpSess = await waitFor(() => fetchState(url).then((s) => s.audioSessions.at(-1)), (s) => !!s?.closed, 5000);
    check("Backpressure stops the audio stream (anchor sent, 0 PCM packets, session closed, resources released)", /backpressure/i.test(bpErr ?? "") && !!bpSess?.audioStart && bpSess.packets === 0 && bpSess.closed && bpDbg.micPhase === "error" && bpDbg.micLiveTracks === 0 && bpDbg.micContextState === "closed" && (await bpPage.isEnabled("#mic-start-btn")), `packets=${bpSess?.packets} phase=${bpDbg.micPhase}`);
    await bp.close();

    // ------------------------------------------------------------------ Normal capture path still works
    const cap = await browser.newContext({ viewport: { width: 1280, height: 900 }, permissions: ["camera", "microphone"] });
    const capPage = await cap.newPage();
    capPage.on("pageerror", (e) => pageErrors.push(e.message));
    await control(url, "reset", {});
    await openConnected(capPage, url);
    await capPage.evaluate(() => {
      (document.getElementById("capture-details") as HTMLDetailsElement).open = true;
    });
    await capPage.click("#camera-start-btn");
    const frames = await waitFor(() => fetchState(url).then((s) => s.frames), (f) => f.length >= 3, 10000);
    check("Camera: JPEG frames long side ≤ 640 at ~2 fps, none rejected", frames.length >= 3 && Math.max(frames[0]!.width, frames[0]!.height) <= 640 && (await fetchState(url)).frameRejections.length === 0, frames[0] ? `${frames[0].width}x${frames[0].height}` : "none");
    await capPage.click("#mic-start-btn");
    const micSess = await waitFor(() => fetchState(url).then((s) => s.audioSessions.at(-1)), (s) => !!s && s.packets >= 16, 20000);
    check("Microphone: start → ready → audio-start → 1024-byte PCM packets", !!micSess && micSess.binaryBeforeReady === 0 && micSess.binaryBeforeAudioStart === 0 && micSess.oddLength === 0 && micSess.oversized === 0 && micSess.packets >= 16, `packets=${micSess?.packets}`);
    await capPage.waitForSelector('#transcript-list li[data-final="true"]', { timeout: 10000 });
    check("Live transcript: final replaces partial", (await capPage.locator("#transcript-list li").count()) === 1);
    await capPage.screenshot({ path: join(OUT_DIR, "plain-desktop-capture.png"), fullPage: true });
    await capPage.click("#camera-stop-btn");
    await capPage.click("#mic-stop-btn");
    const released = await waitFor(() => debug(capPage), (d) => d.micContextState === "closed" && d.cameraActive === false, 5000);
    const framesAtStop = (await fetchState(url)).frames.length;
    await sleep(1500);
    check("Stop releases camera tracks, mic tracks, AudioContext, socket; no frames after stop", released.cameraLiveTracks === 0 && released.micLiveTracks === 0 && released.micContextState === "closed" && released.micSocketState === 3 && (await fetchState(url)).frames.length === framesAtStop);
    await cap.close();

    // ------------------------------------------------------------------ Service worker + manifest
    const sw = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const swPage = await sw.newPage();
    swPage.on("pageerror", (e) => pageErrors.push(e.message));
    await openConnected(swPage, url);
    const manifest = (await (await swPage.request.get(`${url}/manifest.webmanifest`)).json()) as { name: string; display: string; start_url: string; icons: { src: string }[] };
    const iconsOk = (await Promise.all(manifest.icons.map((i) => swPage.request.get(`${url}${i.src}`)))).every((r) => r.ok());
    check("Manifest valid and icons served", manifest.name === "KAWK" && manifest.display === "standalone" && manifest.start_url === "/" && iconsOk);
    const swState = await swPage.evaluate(async () => {
      const reg = await Promise.race([navigator.serviceWorker.ready, new Promise<null>((r) => setTimeout(() => r(null), 8000))]);
      return reg ? (reg.active?.state ?? "registered") : "timeout";
    });
    const cacheNames = await swPage.evaluate(() => caches.keys());
    const cached = await swPage.evaluate(async () => {
      const out: string[] = [];
      for (const k of await caches.keys()) for (const r of await (await caches.open(k)).keys()) out.push(new URL(r.url).pathname);
      return out;
    });
    check("Service worker active with cache version v2, shell assets only, no /v1/*", (swState === "activated" || swState === "activating") && cacheNames.includes("kawk-shell-v2") && !cacheNames.includes("kawk-shell-v1") && cached.length > 0 && cached.every((p) => !p.startsWith("/v1/")), `${swState}; ${cacheNames.join(",")}`);
    await sw.close();

    // ------------------------------------------------------------------ Mobile
    const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    const mPage = await mobile.newPage();
    mPage.on("pageerror", (e) => pageErrors.push(e.message));
    await openConnected(mPage, url);
    await control(url, "notify", { text: "Sarah mentioned her flight lands at 6pm" });
    await mPage.waitForSelector("#notification-list li");
    check("Mobile: auto-connected, no horizontal overflow", await mPage.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
    await mPage.screenshot({ path: join(OUT_DIR, "plain-mobile.png"), fullPage: true });
    await mobile.close();

    check("No page errors across all contexts", pageErrors.length === 0, pageErrors.slice(0, 3).join(" | "));
  } finally {
    await browser.close();
    server.stop(true);
  }
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed. Screenshots in ${OUT_DIR}`);
  await Bun.write(join(OUT_DIR, "plain-probe-results.json"), JSON.stringify({ ranAt: new Date().toISOString(), results }, null, 2));
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
