import { mkdir, writeFile, access, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { runProcess } from "../src/process";

// Explicit operator command. Building/testing the harness never installs a background service.
if (process.platform !== "darwin")
  throw new Error(
    "This helper targets macOS launchd; run bun start under your Linux supervisor instead.",
  );
const command = process.argv[2] ?? "status";
const root = resolve(import.meta.dir, ".."),
  label = "com.kawk.agent";
const file = join(homedir(), "Library/LaunchAgents", `${label}.plist`);
const domain = `gui/${process.getuid!()}`;
const xml = (text: string) =>
  text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
if (command === "install" || command === "prepare") {
  if (command === "install") {
    await access(join(root, ".env"));
    if (!process.env.TYPESAFE_API_KEY)
      throw new Error("Set TYPESAFE_API_KEY in agent/.env before installing.");
  }
  const logs = join(homedir(), "Library/Logs/KAWK");
  await mkdir(logs, { recursive: true, mode: 0o700 });
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array><string>${xml(process.execPath)}</string><string>--env-file=${xml(join(root, ".env"))}</string><string>${xml(join(root, "src/main.ts"))}</string></array>
<key>WorkingDirectory</key><string>${xml(root)}</string>
<key>EnvironmentVariables</key><dict><key>PATH</key><string>${xml(process.env.PATH ?? "/usr/bin:/bin")}</string></dict>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>10</integer>
<key>StandardOutPath</key><string>${xml(join(logs, "agent.log"))}</string>
<key>StandardErrorPath</key><string>${xml(join(logs, "agent-error.log"))}</string>
</dict></plist>\n`;
  const target = command === "prepare" ? join(root, "data", `${label}.plist`) : file;
  await mkdir(resolve(target, ".."), { recursive: true, mode: 0o700 });
  await writeFile(target, plist, { mode: 0o600, flag: command === "install" ? "wx" : "w" });
  const validated = await runProcess(["plutil", "-lint", target]);
  if (validated.code) throw new Error("Generated launchd configuration failed validation");
  if (command === "install") {
    const result = await runProcess(["launchctl", "bootstrap", domain, target]);
    if (result.code)
      throw new Error(`launchctl bootstrap failed (${result.code}); inspect ${target}`);
  }
  console.log(`${command === "prepare" ? "Prepared, not installed" : "Installed"}: ${target}`);
} else if (command === "remove") {
  await runProcess(["launchctl", "bootout", `${domain}/${label}`]);
  await unlink(file).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });
  console.log("Agent service removed; evidence and memory retained.");
} else if (command === "status") {
  const result = await runProcess(["launchctl", "print", `${domain}/${label}`]);
  console.log(result.code === 0 ? result.stdout : "KAWK launchd service is not installed/running.");
} else throw new Error("Usage: bun scripts/service.ts prepare|install|status|remove");
