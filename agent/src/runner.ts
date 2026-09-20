import { setTimeout as delay } from "node:timers/promises";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, rm, stat } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { Unavailable } from "./contracts";

export interface Runner {
  call(
    taskId: string,
    mode: "code" | "browser",
    action: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<unknown>;
  close(taskId: string): Promise<void>;
  reap?(isActive: (id: string) => boolean): Promise<void>;
  dispose?(): Promise<void>;
}
export class DisabledRunner implements Runner {
  async call(): Promise<never> {
    throw new Unavailable("Runner is disabled; set KAWK_RUNNER=local to enable local tools");
  }
  async close() {}
}
interface Job {
  proc: ChildProcess;
  output: string;
  bytes: number;
  exitCode: number | null;
  truncated: boolean;
  done: Promise<void>;
  kill: () => void;
}
interface Session {
  workspace: string;
  jobs: Map<string, Job>;
  page?: Promise<Page>;
  context?: BrowserContext;
  closed: boolean;
}

/** Hackathon runner: /tmp is a working directory, NOT an OS security boundary.
 * Commands run as the host user and can access host files and the network. */
export class LocalRunner implements Runner {
  private sessions = new Map<string, Promise<Session>>();
  private closing = new Map<string, Promise<void>>();
  private browser?: Promise<Browser>;
  private disposed = false;
  private disposal?: Promise<void>;
  constructor(private directory = "/tmp") {}

  private session(taskId: string) {
    if (this.disposed) throw new Error("Runner has stopped");
    if (this.closing.has(taskId)) throw new Error("Task workspace is closing");
    let pending = this.sessions.get(taskId);
    if (!pending) {
      pending = (async (): Promise<Session> => {
        await mkdir(this.directory, { recursive: true });
        return {
          workspace: await mkdtemp(join(this.directory, "kawk-")),
          jobs: new Map(),
          closed: false,
        };
      })();
      this.sessions.set(taskId, pending);
      pending.catch(() => {
        if (this.sessions.get(taskId) === pending) this.sessions.delete(taskId);
      });
    }
    return pending;
  }
  private environment() {
    // Keep normal host paths; don't copy model-provider credentials into commands.
    const env: Record<string, string> = {};
    for (const key of ["PATH", "HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "TMPDIR", "SYSTEMROOT"])
      if (process.env[key] !== undefined) env[key] = process.env[key]!;
    return env;
  }
  private getBrowser() {
    if (!this.browser) {
      const pending = chromium.launch({ headless: true, env: this.environment() });
      this.browser = pending;
      pending
        .then((browser) => {
          browser.on("disconnected", () => {
            if (this.browser === pending) this.browser = undefined;
          });
        })
        .catch(() => {
          if (this.browser === pending) this.browser = undefined;
        });
    }
    return this.browser;
  }
  private getPage(session: Session) {
    if (!session.page) {
      const pending = (async () => {
        const browser = await this.getBrowser();
        if (session.closed) throw new Error("Task workspace closed");
        const context = await browser.newContext({ acceptDownloads: true });
        context.setDefaultTimeout(10000);
        session.context = context;
        context.on("close", () => {
          session.page = undefined;
          session.context = undefined;
        });
        if (session.closed) {
          await context.close();
          throw new Error("Task workspace closed");
        }
        const page = await context.newPage();
        context.on("page", (popup) => {
          session.page = Promise.resolve(popup);
        });
        return page;
      })();
      session.page = pending;
      pending.catch(() => {
        if (session.page === pending) session.page = undefined;
      });
    }
    return session.page;
  }
  private workspaceFile(session: Session, value: unknown) {
    if (typeof value !== "string" || !value || value.length > 1000)
      throw new Error("Invalid workspace path");
    const file = resolve(session.workspace, value);
    if (!file.startsWith(session.workspace + sep))
      throw new Error("File tools require a path inside the task workspace");
    return file;
  }
  private async pageState(session: Session) {
    const page = await this.getPage(session);
    // Use Playwright's accessibility snapshot plus grounded selectors for native controls.
    const controls = await page
      .locator("input, textarea, select, button, [role=button]")
      .evaluateAll((nodes) =>
        nodes.slice(0, 80).map((node, index) => {
          const el = node as HTMLInputElement;
          return {
            selector: `:is(input, textarea, select, button, [role=button]) >> nth=${index}`,
            tag: el.tagName.toLowerCase(),
            type: el.type,
            label:
              el.getAttribute("aria-label") ||
              Array.from(el.labels ?? [])
                .map((l) => l.textContent?.trim())
                .join(" ") ||
              el.textContent?.trim().slice(0, 120),
            placeholder: el.getAttribute("placeholder"),
            value: el.type === "password" ? undefined : el.value,
            disabled: el.disabled,
            checked: el.type === "checkbox" || el.type === "radio" ? el.checked : undefined,
            options:
              el.tagName === "SELECT"
                ? Array.from((node as HTMLSelectElement).options).map((o) => ({
                    label: o.label,
                    value: o.value,
                    selected: o.selected,
                  }))
                : undefined,
          };
        }),
      );
    return {
      url: page.url(),
      title: await page.title(),
      text: (await page.locator("body").innerText()).slice(0, 18000),
      accessibility: (await page.locator("body").ariaSnapshot()).slice(0, 12000),
      controls,
      links: await page
        .locator("a[href]")
        .evaluateAll((nodes) =>
          nodes
            .slice(0, 60)
            .map((node) => ({
              text: node.textContent?.slice(0, 120),
              href: (node as HTMLAnchorElement).href,
            })),
        ),
      tabs: await Promise.all(
        (session.context?.pages() ?? []).map(async (tab, index) => ({
          index,
          active: tab === page,
          url: tab.url(),
          title: await tab.title().catch(() => ""),
        })),
      ),
    };
  }
  private execute(session: Session, args: Record<string, unknown>, signal: AbortSignal) {
    if (typeof args.command !== "string" || !args.command || args.command.length > 16000)
      throw new Error("Invalid command");
    if ([...session.jobs.values()].filter((p) => p.exitCode === null).length >= 2)
      throw new Error("Process limit reached");
    const timeoutMs = args.timeoutMs === undefined ? 30000 : Number(args.timeoutMs);
    if (!Number.isFinite(timeoutMs) || timeoutMs < 100 || timeoutMs > 60000)
      throw new Error("Invalid process timeout");
    const proc = spawn("/bin/sh", ["-c", args.command], {
      cwd: session.workspace,
      detached: true,
      env: this.environment(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    const id = crypto.randomUUID();
    let finish!: () => void;
    const done = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let killing = false;
    const job: Job = {
      proc,
      output: "",
      bytes: 0,
      exitCode: null,
      truncated: false,
      done,
      kill: () => {
        if (job.exitCode !== null || killing) return;
        killing = true;
        if (proc.pid) {
          try {
            process.kill(-proc.pid, "SIGKILL");
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
          }
        }
      },
    };
    session.jobs.set(id, job);
    const append = (text: string) => {
      job.bytes += Buffer.byteLength(text);
      if (job.bytes > 1000000) {
        job.truncated = true;
        job.kill();
      } else job.output += text;
    };
    proc.stdout!.setEncoding("utf8").on("data", append);
    proc.stderr!.setEncoding("utf8").on("data", append);
    const timer = setTimeout(job.kill, timeoutMs);
    signal.addEventListener("abort", job.kill, { once: true });
    proc.on("error", (error) => {
      append(`Process failed: ${error.message}\n`);
    });
    proc.on("close", (code) => {
      job.kill(); // Also clean up background descendants that closed their stdio.
      job.exitCode = code ?? 137;
      clearTimeout(timer);
      signal.removeEventListener("abort", job.kill);
      finish();
    });
    if (signal.aborted) job.kill();
    return { processId: id, workspace: session.workspace };
  }
  async call(
    taskId: string,
    mode: "code" | "browser",
    action: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<unknown> {
    signal.throwIfAborted();
    const session = await this.session(taskId);
    signal.throwIfAborted();
    if (session.closed) throw new Error("Task workspace closed");
    if (mode === "browser") {
      // Closing this task's context interrupts navigation without affecting siblings.
      const cancel = () => {
        void session.context?.close().catch(() => {});
      };
      signal.addEventListener("abort", cancel, { once: true });
      try {
        const page = await this.getPage(session);
        signal.throwIfAborted();
        if (action === "browser.goto") {
          const url = new URL(String(args.url));
          if (!["http:", "https:"].includes(url.protocol)) throw new Error("Use an HTTP(S) URL");
          await page.goto(url.href, { waitUntil: "domcontentloaded", timeout: 20000 });
        } else if (action === "browser.click") {
          const control = page.locator(String(args.selector));
          if ((await control.getAttribute("target")) === "_blank") {
            const [popup] = await Promise.all([page.waitForEvent("popup"), control.click()]);
            session.page = Promise.resolve(popup);
            await popup.waitForLoadState("domcontentloaded");
          } else await control.click();
        } else if (action === "browser.type")
          await page.locator(String(args.selector)).fill(String(args.text));
        else if (action === "browser.select")
          await page.locator(String(args.selector)).selectOption({ label: String(args.label) });
        else if (action === "browser.press")
          await page.locator(String(args.selector)).press(String(args.key));
        else if (action === "browser.wait")
          await page.locator(String(args.selector)).waitFor({ state: args.state === "hidden" ? "hidden" : "visible", timeout: Number(args.timeoutMs) || 5000 });
        else if (action === "browser.state" && typeof args.query === "string") {
          const text = await page.locator("body").innerText();
          const index = text.toLocaleLowerCase().indexOf(args.query.toLocaleLowerCase());
          const offset = Math.max(0, index - 300);
          return { url: page.url(), title: await page.title(), query: args.query, found: index >= 0, offset, fullTextLength: text.length, text: index < 0 ? "" : text.slice(offset, offset + 5000) };
        }
        else if (action === "browser.tab") {
          const selected = session.context?.pages()[Number(args.index)];
          if (!selected)
            throw new Error("Unknown browser tab; read browser_state for current indices");
          session.page = Promise.resolve(selected);
        } else if (action === "browser.upload") {
          const paths = args.paths as string[];
          const files = paths.map((path) => this.workspaceFile(session, path));
          for (const file of files)
            if ((await stat(file)).size > 10 * 1024 * 1024)
              throw new Error("Upload exceeds 10 MiB per file");
          await page.locator(String(args.selector)).setInputFiles(files);
          return { ...(await this.pageState(session)), selectedFiles: paths, submitted: false };
        } else if (action === "browser.download") {
          const file = this.workspaceFile(session, args.path);
          await mkdir(dirname(file), { recursive: true });
          const [download] = await Promise.all([
            page.waitForEvent("download", { timeout: 15000 }),
            page.locator(String(args.selector)).click(),
          ]);
          await download.saveAs(file);
          const bytes = (await stat(file)).size;
          if (bytes > 10 * 1024 * 1024) {
            await rm(file, { force: true });
            throw new Error("Download exceeds 10 MiB");
          }
          return {
            ...(await this.pageState(session)),
            downloaded: {
              path: relative(session.workspace, file),
              suggestedFilename: download.suggestedFilename(),
              bytes,
            },
          };
        } else if (action === "browser.screenshot")
          return {
            url: page.url(),
            mime: "image/png",
            base64: (await page.screenshot({ fullPage: false })).toString("base64"),
          };
        else if (action !== "browser.state") throw new Error("Unknown browser action");
        const result = await this.pageState(session);
        signal.throwIfAborted();
        return result;
      } finally {
        signal.removeEventListener("abort", cancel);
        if (signal.aborted) cancel();
      }
    }
    if (action === "file.export") {
      const file = this.workspaceFile(session, args.path);
      const info = await stat(file);
      if (!info.isFile() || info.size > 10 * 1024 * 1024)
        throw new Error("Export requires a file of at most 10 MiB");
      return {
        filename: basename(file),
        mime: Bun.file(file).type || "application/octet-stream",
        bytes: info.size,
        base64: (await readFile(file)).toString("base64"),
      };
    }
    if (action === "file.write") {
      if (typeof args.text !== "string" || args.text.length > 100000)
        throw new Error("Invalid file content");
      const file = this.workspaceFile(session, args.path);
      await mkdir(dirname(file), { recursive: true });
      signal.throwIfAborted();
      await writeFile(file, args.text);
      return { written: true };
    }
    if (action === "file.read")
      return {
        text: (await readFile(this.workspaceFile(session, args.path), "utf8")).slice(0, 40000),
      };
    if (action === "exec") return this.execute(session, args, signal);
    const job = session.jobs.get(String(args.processId));
    if (!job) throw new Error("Unknown process (handles do not survive runner restart)");
    if (action === "cancel") {
      job.kill();
      await job.done;
      return { cancelled: true };
    }
    if (action === "poll") {
      const waitMs = Math.max(0, Math.min(10000, Number(args.waitMs) || 0));
      if (job.exitCode === null && job.output.length <= (Number(args.cursor) || 0) && waitMs) {
        const done = new AbortController();
        try {
          await Promise.race([
            job.done,
            delay(waitMs, undefined, { signal: AbortSignal.any([signal, done.signal]) }),
          ]);
        } finally {
          done.abort();
        }
        signal.throwIfAborted();
      }
      const cursor = Math.max(0, Math.min(Number(args.cursor) || 0, job.output.length));
      const output = job.output.slice(cursor, cursor + 32000);
      return {
        output,
        cursor: cursor + output.length,
        exitCode: job.exitCode,
        truncated: job.truncated,
      };
    }
    throw new Error("Unknown code action");
  }
  close(taskId: string): Promise<void> {
    const current = this.closing.get(taskId);
    if (current) return current;
    const pending = this.sessions.get(taskId);
    if (!pending) return Promise.resolve();
    const closing = (async () => {
      const session = await pending;
      session.closed = true;
      for (const job of session.jobs.values()) if (job.exitCode === null) job.kill();
      await Promise.all([...session.jobs.values()].map((job) => job.done));
      if (session.page) await session.page.catch(() => {});
      await session.context?.close();
      await rm(session.workspace, { recursive: true, force: true });
    })().finally(() => {
      this.sessions.delete(taskId);
      this.closing.delete(taskId);
    });
    this.closing.set(taskId, closing);
    return closing;
  }
  async reap(isActive: (id: string) => boolean) {
    await Promise.all(
      [...this.sessions.keys()].filter((id) => !isActive(id)).map((id) => this.close(id)),
    );
  }
  dispose() {
    if (!this.disposal) {
      this.disposed = true;
      this.disposal = (async () => {
        try {
          await this.reap(() => false);
        } finally {
          if (this.browser) await (await this.browser.catch(() => undefined))?.close();
        }
      })();
    }
    return this.disposal;
  }
}
