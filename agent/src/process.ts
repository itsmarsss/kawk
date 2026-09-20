/** Bounded subprocess output and cancellation, with no command-string interpolation. */
export async function runProcess(
  argv: string[],
  options: {
    cwd?: string;
    input?: string;
    signal?: AbortSignal;
    timeout?: number;
    maxBytes?: number;
    env?: Record<string, string | undefined>;
    onStdoutLine?: (line: string) => void;
  } = {},
) {
  const signal = AbortSignal.any([
    ...(options.signal ? [options.signal] : []),
    AbortSignal.timeout(options.timeout ?? 60000),
  ]);
  signal.throwIfAborted();
  const proc = Bun.spawn(argv, {
    cwd: options.cwd,
    env: options.env,
    stdin: options.input !== undefined ? new Blob([options.input]) : "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const kill = () => {
    try {
      proc.kill("SIGKILL");
    } catch {}
  };
  signal.addEventListener("abort", kill, { once: true });
  const read = async (stream: ReadableStream<Uint8Array>, onLine?: (line: string) => void) => {
    let size = 0;
    let pending = "";
    const decoder = new TextDecoder();
    const chunks: Uint8Array[] = [];
    for await (const chunk of stream) {
      size += chunk.length;
      if (size > (options.maxBytes ?? 2000000)) {
        kill();
        throw new Error("Process output exceeded limit");
      }
      chunks.push(chunk);
      if (onLine) {
        pending += decoder.decode(chunk, { stream: true });
        let at: number;
        while ((at = pending.indexOf("\n")) >= 0) {
          onLine(pending.slice(0, at));
          pending = pending.slice(at + 1);
        }
      }
    }
    if (onLine) {
      pending += decoder.decode();
      if (pending) onLine(pending);
    }
    return Buffer.concat(chunks).toString("utf8");
  };
  try {
    const [stdout, stderr, code] = await Promise.all([
      read(proc.stdout, options.onStdoutLine),
      read(proc.stderr),
      proc.exited,
    ]);
    signal.throwIfAborted();
    return { stdout, stderr, code };
  } finally {
    signal.removeEventListener("abort", kill);
    kill();
  }
}
