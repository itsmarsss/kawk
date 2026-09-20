import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { LocalRunner } from "../src/runner";
import { Harness } from "../src/harness";
import { Store } from "../src/store";
import { serve } from "../src/server";
import { call, event, gate, model, until } from "./helpers";
import { browserSite, salesCsv } from "./fixtures/browser-site";

test("browser download shares workspace with code, uploads actual bytes, and observes server receipt", async () => {
  const site = browserSite(),
    runner = new LocalRunner(),
    signal = new AbortController().signal;
  const run = (action: string, args = {}) =>
    runner.call("one", "browser", action, args, signal) as Promise<any>;
  try {
    await run("browser.goto", { url: site.url + "/downloads" });
    const downloaded = await run("browser.download", {
      selector: "text=Download sales CSV",
      path: "inputs/sales.csv",
    });
    expect(downloaded.downloaded.bytes).toBe(Buffer.byteLength(salesCsv));
    expect(
      await runner.call("one", "code", "file.read", { path: "inputs/sales.csv" }, signal),
    ).toEqual({ text: salesCsv });
    const state = await run("browser.goto", { url: site.url + "/upload" });
    const field = (name: string) =>
      state.controls.find((c: any) => c.label?.startsWith(name)).selector;
    expect(state.accessibility).toContain("Project");
    await run("browser.type", { selector: field("Project"), text: "roundtrip" });
    await run("browser.select", { selector: field("Category"), label: "Research" });
    const selected = await run("browser.upload", {
      selector: field("Attachments"),
      paths: ["inputs/sales.csv"],
    });
    expect(selected.submitted).toBe(false);
    expect(site.uploads).toHaveLength(0);
    await run("browser.click", { selector: "button" });
    await run("browser.wait", { selector: "text=Importing…", state: "hidden" });
    const imported = await run("browser.wait", {
      selector: "#outcome:has-text('Import successful')",
    });
    expect(imported.text).toContain("IMPORT-1");
    expect(site.uploads[0]).toEqual({
      project: "roundtrip",
      category: "Research",
      files: [{ name: "sales.csv", text: salesCsv }],
    });
    await expect(
      run("browser.upload", { selector: field("Attachments"), paths: ["../outside.csv"] }),
    ).rejects.toThrow("workspace");
  } finally {
    await runner.dispose();
    await site.server.stop(true);
  }
}, 30000);

test("focused browser read finds evidence past the initial page truncation", async () => {
  const runner = new LocalRunner();
  const site = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(`<body><p>${"padding ".repeat(3000)}</p><h2>Even-sized median</h2><p>Average the two middle values.</p></body>`, { headers: { "Content-Type": "text/html" } }) });
  const signal = new AbortController().signal;
  try {
    const initial = await runner.call("one", "browser", "browser.goto", { url: `http://127.0.0.1:${site.port}` }, signal) as any;
    expect(initial.text).not.toContain("Average the two middle");
    const focus = await runner.call("one", "browser", "browser.state", { query: "Even-sized median" }, signal) as any;
    expect(focus.found).toBe(true); expect(focus.text).toContain("Average the two middle values"); expect(focus.text.length).toBeLessThanOrEqual(5000);
  } finally { await runner.dispose(); await site.stop(true); }
}, 15000);

test("browser searches by Enter, follows a popup, selects a form option, and switches back", async () => {
  const site = browserSite(),
    runner = new LocalRunner(),
    signal = new AbortController().signal;
  const run = (action: string, args = {}) =>
    runner.call("one", "browser", action, args, signal) as Promise<any>;
  try {
    await run("browser.goto", { url: site.url + "/catalog" });
    await run("browser.type", { selector: "input[name=q]", text: "headphones" });
    await run("browser.press", { selector: "input[name=q]", key: "Enter" });
    const product = await run("browser.click", { selector: "text=Trail headphones" });
    expect(product.tabs).toHaveLength(2);
    expect(product.url).toContain("/product/trail");
    await run("browser.type", { selector: "input[name=name]", text: "Demo Tester" });
    await run("browser.select", { selector: "select", label: "Blue" });
    const submitted = await run("browser.click", { selector: "text=Reserve demo item" });
    expect(submitted.text).toContain("Reservation confirmed");
    expect(site.reservations).toEqual([
      { product: "trail", name: "Demo Tester", color: "Blue", quantity: "1" },
    ]);
    expect((await run("browser.tab", { index: 0 })).url).toContain("/catalog");
  } finally {
    await runner.dispose();
    await site.server.stop(true);
  }
}, 30000);

test("exported file survives workspace cleanup and server restart; artifact remains owner-scoped", async () => {
  const dir = await mkdtemp("/tmp/kawk-artifact-test-");
  let turn = 0;
  const create = () =>
    new Harness({
      store: new Store(join(dir, "store.sqlite")),
      gate,
      runner: new LocalRunner(),
      artifactDir: join(dir, "artifacts"),
      tickMs: 5,
      model: model(() =>
        ++turn === 1
          ? call("write_file", { path: "résumé.csv", text: "item,total\nall,94.40\n" })
          : turn === 2
            ? call("export_file", { path: "résumé.csv" })
            : call("finish", { text: "", refs: [], confidence: 1, notify: false }),
      ),
    });
  let h = create();
  let server: ReturnType<typeof serve> | undefined;
  try {
    h.start();
    h.ingest("owner", event("file", "Create and preserve a report"));
    await until(
      () => h.store.tasks("owner").some((t) => ["completed", "abstained"].includes(t.status)),
      5000,
    );
    const artifact = h.store.one<{ id: string; task_id: string }>(
      "SELECT id,task_id FROM artifacts",
    )!;
    await h.runner.close(artifact.task_id);
    await h.stop();
    h.store.close();
    h = create();
    server = serve(h, { owner: "owner", token: "a".repeat(40), port: 0 });
    const result = await fetch(server.url + "/v1/artifacts/" + artifact.id, {
      headers: { Authorization: "Bearer " + "a".repeat(40) },
    });
    expect(result.status).toBe(200);
    expect(result.headers.get("content-disposition")).toContain("r%C3%A9sum%C3%A9.csv");
    expect(await result.text()).toBe("item,total\nall,94.40\n");
    await server.stop();
    server = serve(h, { owner: "other", token: "b".repeat(40), port: 0 });
    expect(
      (
        await fetch(server.url + "/v1/artifacts/" + artifact.id, {
          headers: { Authorization: "Bearer " + "b".repeat(40) },
        })
      ).status,
    ).toBe(404);
  } finally {
    await server?.stop();
    await h.stop();
    await h.runner.dispose?.();
    h.store.close();
    await rm(dir, { recursive: true, force: true });
  }
}, 15000);
