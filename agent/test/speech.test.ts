import { test, expect } from "bun:test";
import WebSocket from "ws";
import { SpeechSession } from "../src/speech";
import { Store } from "../src/store";
import { until } from "./helpers";

test("Whisper relay journals partial revisions and maps words to first actual audio capture, excluding cloud startup", async () => {
  let packet = 0;
  const cloud = Bun.serve({
    port: 0,
    fetch(r, s) {
      if (s.upgrade(r)) return;
      return new Response(null, { status: 400 });
    },
    websocket: {
      message(ws, data) {
        if (typeof data === "string") return;
        packet++;
        ws.send(
          JSON.stringify({
            type: "transcription",
            transcription_num: 1,
            is_final: packet === 2,
            segments: [
              {
                text: packet === 1 ? "blue" : "blue notebook",
                start_time: 0,
                end_time: 0.032,
                word_timestamps: [
                  { word: "blue", start_time: 0, end_time: 0.016, prob: 0.98 },
                  ...(packet === 2
                    ? [{ word: "notebook", start_time: 0.016, end_time: 0.032, prob: 0.98 }]
                    : []),
                ],
              },
            ],
          }),
        );
      },
    },
  });
  let now = Date.now(),
    ready = false;
  const store = new Store(":memory:", () => now);
  const output: any[] = [];
  const speech = new SpeechSession(
    {
      send(data) {
        const d = JSON.parse(data);
        output.push(d);
        if (d.type === "ready") ready = true;
      },
      close() {},
    },
    (e) => store.ingest("owner", e, false),
    { apiKey: "fixture", modelId: "fixture" },
    () => now,
    () => new WebSocket(`ws://127.0.0.1:${cloud.port}`),
  );
  try {
    speech.message(
      JSON.stringify({
        type: "start",
        deviceId: "glasses",
        streamId: "session",
        capturedAt: now,
        uncertaintyMs: 20,
      }),
    );
    await until(() => ready);
    now += 12000;
    const anchor = now;
    speech.message(JSON.stringify({ type: "audio-start", capturedAt: anchor, uncertaintyMs: 30 }));
    speech.message(Buffer.alloc(1024));
    await until(() => store.all("SELECT * FROM evidence").length === 1);
    speech.message(Buffer.alloc(1024));
    await until(() => store.all("SELECT * FROM evidence").length === 2);
    const e = store.latest("owner", "speech-session-1")!;
    expect(e.final).toBe(true);
    expect(e.revision).toBe(1);
    expect(e.sourceStart).toBe(anchor);
    expect(e.words?.at(-1)?.sourceEnd).toBe(anchor + 32);
    expect(store.stats().events).toBeGreaterThan(0);
    expect(output.some((d) => d.type === "error")).toBe(false);
  } finally {
    speech.close();
    await cloud.stop(true);
    store.close();
  }
});

test("PCM sent before cloud readiness fails instead of replaying stale audio", () => {
  const messages: any[] = [];
  const speech = new SpeechSession(
    {
      send(s) {
        messages.push(JSON.parse(s));
      },
      close() {},
    },
    () => {
      throw new Error("unexpected ingest");
    },
    {},
  );
  speech.message(Buffer.alloc(1024));
  expect(messages[0]?.type).toBe("error");
  speech.close();
});
