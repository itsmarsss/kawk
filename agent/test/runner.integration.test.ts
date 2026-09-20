import { expect, test } from "bun:test";
import { access, realpath } from "node:fs/promises";
import { LocalRunner } from "../src/runner";
import { until } from "./helpers";

const signal = () => new AbortController().signal;
type Started = { processId: string; workspace: string };
type Output = { output: string; cursor: number; exitCode: number | null; truncated: boolean };
async function completed(runner: LocalRunner, task: string, processId: string) {
  let result: Output;
  const start = Date.now();
  do {
    result = (await runner.call(
      task,
      "code",
      "poll",
      { processId, cursor: 0 },
      signal(),
    )) as Output;
    if (result.exitCode !== null) return result;
    if (Date.now() - start > 5000) throw new Error("Local process did not finish");
    await Bun.sleep(10);
  } while (true);
}

test("local code uses a task /tmp workspace with real files, incremental output and cleanup", async () => {
  const runner = new LocalRunner();
  let workspace = "";
  try {
    await runner.call(
      "one",
      "code",
      "file.write",
      { path: "input.txt", text: "hello 🦆" },
      signal(),
    );
    const job = (await runner.call(
      "one",
      "code",
      "exec",
      {
        command: "pwd; cat input.txt; printf '\n'; sleep 0.05; printf 'done'",
        timeoutMs: 2000,
      },
      signal(),
    )) as Started;
    workspace = job.workspace;
    expect(workspace.startsWith("/tmp/kawk-")).toBe(true);
    const result = await completed(runner, "one", job.processId);
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain(await realpath(workspace));
    expect(result.output).toContain("hello 🦆");
    expect(result.output).toContain("done");
    expect(
      (
        (await runner.call(
          "one",
          "code",
          "poll",
          { processId: job.processId, cursor: result.cursor },
          signal(),
        )) as Output
      ).output,
    ).toBe("");
    expect(await runner.call("one", "code", "file.read", { path: "input.txt" }, signal())).toEqual({
      text: "hello 🦆",
    });
    await expect(
      runner.call("two", "code", "file.read", { path: "input.txt" }, signal()),
    ).rejects.toThrow();
    await expect(
      runner.call("one", "code", "file.write", { path: "../outside.txt", text: "no" }, signal()),
    ).rejects.toThrow("workspace");
  } finally {
    await runner.dispose();
  }
  await expect(access(workspace)).rejects.toThrow();
});

test("local process cancellation, task abort, timeout and output limits still work", async () => {
  const runner = new LocalRunner();
  try {
    const job = (await runner.call(
      "one",
      "code",
      "exec",
      { command: "sleep 30" },
      signal(),
    )) as Started;
    await runner.call("one", "code", "cancel", { processId: job.processId }, signal());
    expect((await completed(runner, "one", job.processId)).exitCode).not.toBe(0);
    const abort = new AbortController();
    const second = (await runner.call(
      "one",
      "code",
      "exec",
      { command: "sleep 30" },
      abort.signal,
    )) as Started;
    abort.abort();
    expect((await completed(runner, "one", second.processId)).exitCode).not.toBe(0);
    const timeout = (await runner.call(
      "one",
      "code",
      "exec",
      { command: "sleep 30", timeoutMs: 100 },
      signal(),
    )) as Started;
    expect((await completed(runner, "one", timeout.processId)).exitCode).not.toBe(0);
    const flood = (await runner.call(
      "one",
      "code",
      "exec",
      {
        command: "node -e 'process.stdout.write(\"x\".repeat(1100000));setInterval(()=>{},1000)'",
      },
      signal(),
    )) as Started;
    const capped = await completed(runner, "one", flood.processId);
    expect(capped.truncated).toBe(true);
    expect(capped.output.length).toBeLessThanOrEqual(32000);
  } finally {
    await runner.dispose();
  }
});

test("code can use localhost and provider credentials are not automatically copied to the child", async () => {
  const runner = new LocalRunner();
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response("local-network-ok"),
  });
  try {
    const job = (await runner.call(
      "one",
      "code",
      "exec",
      {
        command: `node -e 'fetch("http://127.0.0.1:${server.port}").then(r=>r.text()).then(console.log)' && test -z "$OPENAI_API_KEY" && test -z "$BASETEN_API_KEY"`,
      },
      signal(),
    )) as Started;
    const result = await completed(runner, "one", job.processId);
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("local-network-ok");
  } finally {
    await runner.dispose();
    await server.stop(true);
  }
});

test("local browser navigation, typing, clicking and screenshots preserve separate task contexts", async () => {
  const runner = new LocalRunner();
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () =>
      new Response(
        `<title>Local fixture</title><body><input id="value"><button id="save" onclick="localStorage.setItem('value',document.querySelector('#value').value);document.querySelector('#saved').textContent=localStorage.getItem('value')">Save</button><p id="saved"></p><script>document.querySelector('#saved').textContent=localStorage.getItem('value') || 'empty'</script></body>`,
        { headers: { "Content-Type": "text/html" } },
      ),
  });
  const url = `http://127.0.0.1:${server.port}`;
  try {
    const first = (await runner.call("one", "browser", "browser.goto", { url }, signal())) as {
      title: string;
      text: string;
    };
    expect(first.title).toBe("Local fixture");
    await runner.call(
      "one",
      "browser",
      "browser.type",
      { selector: "#value", text: "task-one" },
      signal(),
    );
    const changed = (await runner.call(
      "one",
      "browser",
      "browser.click",
      { selector: "#save" },
      signal(),
    )) as { text: string };
    expect(changed.text).toContain("task-one");
    const second = (await runner.call("two", "browser", "browser.goto", { url }, signal())) as {
      text: string;
    };
    expect(second.text).toContain("empty");
    expect(second.text).not.toContain("task-one");
    await runner.close("two");
    const shot = (await runner.call("one", "browser", "browser.screenshot", {}, signal())) as {
      mime: string;
      base64: string;
    };
    expect(shot.mime).toBe("image/png");
    expect(Buffer.from(shot.base64, "base64").subarray(0, 8)).toEqual(
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    );
    expect(
      ((await runner.call("one", "browser", "browser.state", {}, signal())) as { text: string })
        .text,
    ).toContain("task-one");
  } finally {
    await runner.dispose();
    await server.stop(true);
  }
}, 30000);

test("browser abort interrupts navigation without closing other tasks", async () => {
  const runner = new LocalRunner();
  let waiting = false;
  let release = () => {};
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) => {
      if (new URL(request.url).pathname === "/slow") {
        waiting = true;
        return new Promise<Response>((resolve) => {
          release = () => resolve(new Response("released"));
        });
      }
      return new Response("<body>still works</body>", { headers: { "Content-Type": "text/html" } });
    },
  });
  try {
    const url = `http://127.0.0.1:${server.port}`;
    await runner.call("other", "browser", "browser.goto", { url }, signal());
    const abort = new AbortController();
    const pending = runner.call(
      "slow",
      "browser",
      "browser.goto",
      { url: url + "/slow" },
      abort.signal,
    );
    const outcome = pending.then(
      () => null,
      (error: unknown) => error,
    );
    await until(() => waiting);
    abort.abort();
    expect(await outcome).toBeInstanceOf(Error);
    expect(
      ((await runner.call("other", "browser", "browser.state", {}, signal())) as { text: string })
        .text,
    ).toContain("still works");
  } finally {
    release();
    await runner.dispose();
    await server.stop(true);
  }
}, 30000);

test("reaping touches only this runner's ended tasks; disposal stops active jobs and removes workspaces", async () => {
  const first = new LocalRunner(),
    second = new LocalRunner();
  let workspace = "";
  try {
    await first.call("same-id", "code", "file.write", { path: "first.txt", text: "one" }, signal());
    await second.call(
      "same-id",
      "code",
      "file.write",
      { path: "second.txt", text: "two" },
      signal(),
    );
    await first.reap(() => false);
    await second.reap(() => true);
    expect(
      await second.call("same-id", "code", "file.read", { path: "second.txt" }, signal()),
    ).toEqual({ text: "two" });
    const job = (await second.call(
      "same-id",
      "code",
      "exec",
      { command: "sleep 30" },
      signal(),
    )) as Started;
    workspace = job.workspace;
    await second.dispose();
    await expect(second.call("new", "code", "exec", { command: "true" }, signal())).rejects.toThrow(
      "stopped",
    );
  } finally {
    await first.dispose();
    await second.dispose();
  }
  await expect(access(workspace)).rejects.toThrow();
});
