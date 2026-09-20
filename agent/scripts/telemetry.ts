import { modelTable, type ModelDiagnostics, type TelemetryEvent } from "../src/telemetry";

const path = process.argv[2] ?? "data/telemetry.jsonl";
const text = await Bun.file(path).text();
const events: TelemetryEvent[] = [];
for (const line of text.split("\n")) {
  if (!line.trim()) continue;
  try {
    events.push(JSON.parse(line));
  } catch {
    /* A live writer may have an incomplete final line. */
  }
}
const models = events.filter((e) => e.name === "model.metrics" && e.diagnostics);
console.log(
  modelTable(
    models.map((e) => ({
      label: `${e.taskId ?? "?"} turn ${e.turn ?? "?"}`,
      diagnostics: e.diagnostics as ModelDiagnostics,
    })),
  ).join("\n"),
);
console.log("\nOther completed spans (inclusive; finish includes delivery review):");
for (const name of [...new Set(events.filter((e) => e.name.endsWith(".end")).map((e) => e.name))]) {
  const rows = events.filter((e) => e.name === name);
  console.log(
    `${name}: ${rows.length} calls, ${(rows.reduce((n, e) => n + (e.durationMs ?? 0), 0) / 1000).toFixed(3)}s summed`,
  );
}
console.log(
  `\n${events.filter((e) => e.name.endsWith(".error")).length} failed spans. Source: ${path}`,
);
