import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";
if (!process.argv.includes("--live"))
  throw new Error("Pass --live to exercise the running local PWA and providers");
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1050 } });
const page = await context.newPage(),
  errors: string[] = [];
page.on("pageerror", (e) => errors.push(e.message));
let connections = 0;
page.on("response", (response) => {
  if (
    new URL(response.url()).pathname === "/v1/client/session" &&
    response.request().method() === "POST" &&
    response.status() === 200
  )
    connections++;
});
const started = Date.now(),
  dir = "data/pwa-validation/full-stack/" + new Date().toISOString().replaceAll(":", "-");
mkdirSync(dir, { recursive: true });
try {
  await page.goto("http://127.0.0.1:8091/");
  await page.waitForFunction(() => (window as any).kawkDebug?.().session === "connected");
  if (await page.locator('input[type="password"], #token-input').count())
    throw new Error("The local page must connect without token entry");
  const initialConnections = connections;
  await page.evaluate(() => fetch("/v1/client/session", { method: "DELETE" }));
  const reconnectDeadline = Date.now() + 15000;
  while (connections <= initialConnections && Date.now() < reconnectDeadline)
    await new Promise((r) => setTimeout(r, 100));
  if (connections <= initialConnections)
    throw new Error("Page did not automatically renew its session");
  await page.waitForFunction(() => (window as any).kawkDebug?.().session === "connected");
  const capture = await page.evaluate(async () => await (await fetch("/v1/capture/status")).json());
  if (capture.faceConfigured || capture.speechConfigured)
    throw new Error("Baseten should be disabled for this test");
  const text = "Remind me in 5 seconds to stretch for this PWA smoke test.";
  await page.locator("#manual-text").fill(text);
  const sentAt = Date.now();
  await page.locator("#manual-send-btn").click();
  await page.waitForFunction(() =>
    document.querySelector("#manual-log")?.textContent?.includes("stretch"),
  );
  let wake: any = null;
  while (Date.now() - sentAt < 90000) {
    const result = await page.evaluate(async () => await (await fetch("/v1/notifications")).json());
    wake = result.notifications.find(
      (n: any) => n.createdAt >= sentAt && !n.taskId.startsWith("gate-") && /stretch/i.test(n.text),
    );
    if (wake) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!wake) throw new Error("No LLM reminder notification within 90 seconds");
  await page.locator("#notification-list").getByText(wake.text, { exact: true }).waitFor();
  await page.waitForFunction(() => document.querySelector("#reminders-count")?.textContent === "0");
  await page.screenshot({ path: dir + "/desktop.png", fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: dir + "/mobile.png", fullPage: true });
  const card = page.locator("#notification-list li").filter({ hasText: wake.text });
  await card.getByRole("button", { name: "Acknowledge" }).click();
  await card.waitFor({ state: "detached" });
  const report = {
    startedAt: new Date(started).toISOString(),
    passed: true,
    elapsedMs: Date.now() - started,
    reminderFromInputMs: wake.createdAt - sentAt,
    automaticReconnect: true,
    notification: wake.text,
    basetenDisabled: true,
    pageErrors: errors,
    scope:
      "Actual PWA automatic connection and session renewal without a token, manual transcript, Jev/OpenAI reminder wake, SSE rendering, acknowledgement, desktop/mobile layout. No camera/microphone or OS push.",
  };
  if (errors.length) throw new Error(JSON.stringify(report));
  writeFileSync(dir + "/report.json", JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ ...report, dir }));
} finally {
  await context.close();
  await browser.close();
}
