import { perceptionProviders } from "../src/capture";
import { SpeechSession } from "../src/speech";
import { Store } from "../src/store";
import { mkdirSync, writeFileSync } from "node:fs";
if (!process.argv.includes("--live"))
  throw new Error("Pass --live for existing Baseten and OpenAI calls");
const report: Record<string, unknown> = {
  startedAt: new Date().toISOString(),
  scope:
    "Prerecorded supplied photo and synthesized speech through actual cloud adapters. Not a live glasses test.",
};
const providers = perceptionProviders(process.env),
  s = new Store(":memory:");
const image = Buffer.from(await Bun.file("data/perception-smoke/table.jpg").arrayBuffer()).toString(
  "base64",
);
const faceStart = performance.now();
const faces = providers.detect!(image)
  .then((result) => {
    report.face = {
      ms: Math.round(performance.now() - faceStart),
      detectedCount: Array.isArray(result) ? result.length : result.detectedCount,
      acceptedFaces: Array.isArray(result) ? result.length : result.faces.length,
    };
    console.log("face", JSON.stringify(report.face));
  })
  .catch(() => {
    report.face = { error: "Provider request failed" };
    console.log("face failed");
  });
const sceneStart = performance.now();
const scene = providers.scene!(image)
  .then((text) => {
    report.scene = { ms: Math.round(performance.now() - sceneStart), text };
    console.log("scene", JSON.stringify(report.scene));
  })
  .catch(() => {
    report.scene = { error: "Provider request failed" };
    console.log("scene failed");
  });
const pcm = Buffer.from(await Bun.file("data/perception-smoke/speech.pcm").arrayBuffer());
let ready = false;
let finished = false;
let speech: SpeechSession;
const began = performance.now();
speech = new SpeechSession(
  {
    send(raw) {
      const data = JSON.parse(raw);
      if (data.type === "ready") ready = true;
      if (data.type === "error") {
        report.speechError = data.message;
        finished = true;
      }
      if (data.type === "transcript") {
        console.log("speech", JSON.stringify(data.event));
        if (data.event.final) {
          report.speech = { ms: Math.round(performance.now() - began), event: data.event };
          finished = true;
        }
      }
    },
    close() {},
  },
  (e) => s.ingest("smoke", e, false),
  { apiKey: process.env.BASETEN_API_KEY, modelId: process.env.BASETEN_STT_MODEL_ID },
);
speech.message(
  JSON.stringify({
    type: "start",
    deviceId: "smoke",
    streamId: crypto.randomUUID(),
    capturedAt: Date.now(),
    uncertaintyMs: 1,
  }),
);
const deadline = Date.now() + 60000;
while (!ready && !finished && Date.now() < deadline) await Bun.sleep(20);
if (ready) {
  speech.message(JSON.stringify({ type: "audio-start", capturedAt: Date.now(), uncertaintyMs: 1 }));
  const audioStart = performance.now();
  const padded = Buffer.concat([pcm, Buffer.alloc(32000)]);
  for (let offset = 0; offset < padded.length && !finished; offset += 1024) {
    speech.message(padded.subarray(offset, Math.min(padded.length, offset + 1024)));
    await Bun.sleep(Math.max(0, (offset + 1024) / 32 - (performance.now() - audioStart)));
  }
}
while (!finished && Date.now() < deadline) await Bun.sleep(100);
report.transcriptRevisions = s.all("SELECT id,revision FROM evidence");
report.speechFinal = !!report.speech;
speech.close();
await Promise.all([faces, scene]);
s.close();
mkdirSync("data/perception-smoke", { recursive: true });
writeFileSync("data/perception-smoke/report.json", JSON.stringify(report, null, 2), {
  mode: 0o600,
});
console.log("Saved data/perception-smoke/report.json");
