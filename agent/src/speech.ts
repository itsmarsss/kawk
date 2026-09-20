import WebSocket from "ws";
import { z } from "zod";
import { Id, type PerceptionEvent } from "./contracts";
const Start = z.object({
  type: z.literal("start"),
  deviceId: Id,
  streamId: Id,
  capturedAt: z.number().finite(),
  uncertaintyMs: z.number().min(0).max(5000),
});
const Anchor = z.object({
  type: z.literal("audio-start"),
  capturedAt: z.number().finite(),
  uncertaintyMs: z.number().min(0).max(5000),
});
const Transcript = z.object({
  type: z.literal("transcription"),
  transcription_num: z.union([z.string(), z.number()]),
  is_final: z.boolean(),
  segments: z.array(
    z.object({
      text: z.string(),
      start_time: z.number().nonnegative(),
      end_time: z.number().nonnegative().optional(),
      word_timestamps: z
        .array(
          z.object({
            word: z.string(),
            start_time: z.number().nonnegative(),
            end_time: z.number().nonnegative(),
            prob: z.number().optional(),
          }),
        )
        .optional(),
    }),
  ),
});
export interface SpeechClient {
  send(data: string): unknown;
  close(): unknown;
}
export class SpeechSession {
  private cloud?: WebSocket;
  private start?: z.infer<typeof Start>;
  private anchor?: z.infer<typeof Anchor>;
  private revisions = new Map<string, number>();
  private finalized = new Set<string>();
  private closed = false;
  private ready = false;
  private bytes = 0;
  private connectionTimer?: ReturnType<typeof setTimeout>;
  constructor(
    private client: SpeechClient,
    private ingest: (event: PerceptionEvent) => unknown,
    private config: { apiKey?: string; modelId?: string },
    private now = Date.now,
    private connector = (url: string, options: WebSocket.ClientOptions) =>
      new WebSocket(url, options),
  ) {}
  message(data: string | Buffer | ArrayBuffer) {
    try {
      if (typeof data === "string") {
        const value = JSON.parse(data);
        if (value.type === "start") {
          if (this.start) throw new Error("Audio session already started");
          this.start = Start.parse(value);
          this.connect();
          return;
        }
        if (value.type === "audio-start" && this.ready && !this.anchor) {
          this.anchor = Anchor.parse(value);
          if (Math.abs(this.anchor.capturedAt - this.now()) > 2000)
            throw new Error("Stale audio start");
          return;
        }
        throw new Error("Unexpected audio control message");
      }
      const pcm = Buffer.isBuffer(data) ? data : Buffer.from(data);
      if (!this.ready || !this.anchor || !this.cloud || pcm.length % 2 || pcm.length > 16000)
        throw new Error("Audio is not ready or PCM packet is invalid");
      if (this.cloud.bufferedAmount > 32000)
        throw new Error("Audio backpressure: reconnect with a fresh stream");
      this.cloud.send(pcm);
      this.bytes += pcm.length;
    } catch {
      this.fail("Audio session failed; restart microphone with a fresh stream");
    }
  }
  private connect() {
    const { apiKey, modelId } = this.config;
    if (!apiKey || !modelId || !/^[a-zA-Z0-9_-]+$/.test(modelId))
      return this.fail("Speech service is not configured");
    const cloud = this.connector(
      `wss://model-${modelId}.api.baseten.co/environments/production/websocket`,
      { headers: { Authorization: `Bearer ${apiKey}` } },
    );
    this.cloud = cloud;
    this.connectionTimer = setTimeout(
      () => this.fail("Speech service connection timed out"),
      60000,
    );
    cloud.addEventListener("open", () => {
      clearTimeout(this.connectionTimer);
      cloud.send(
        JSON.stringify({
          streaming_vad_config: { threshold: 0.5, min_silence_duration_ms: 300, speech_pad_ms: 30 },
          streaming_params: {
            encoding: "pcm_s16le",
            sample_rate: 16000,
            enable_partial_transcripts: true,
            partial_transcript_interval_s: 0.5,
            final_transcript_max_duration_s: 30,
          },
          whisper_params: { audio_language: "en", show_word_timestamps: true },
        }),
      );
      this.ready = true;
      this.client.send(JSON.stringify({ type: "ready", needsAudioStart: true }));
    });
    cloud.addEventListener("error", (e) => {
      const code = e.message.match(/response: (\d+)/)?.[1];
      this.fail(`Speech service connection failed${code ? ` (HTTP ${code})` : ""}`);
    });
    cloud.addEventListener("close", () => {
      if (!this.closed) this.fail("Speech connection ended; restart microphone");
    });
    cloud.addEventListener("message", (e) => {
      try {
        const parsed = Transcript.safeParse(JSON.parse(String(e.data)));
        if (!parsed.success) return;
        if (!this.anchor || !this.start) return;
        const t = parsed.data,
          id = `speech-${this.start.streamId}-${String(t.transcription_num)}`;
        if (this.finalized.has(id)) return;
        const words = t.segments.flatMap((s) => s.word_timestamps ?? []);
        const start = Math.min(...t.segments.map((s) => s.start_time));
        const end = Math.max(
          ...t.segments.map(
            (s) => s.end_time ?? s.word_timestamps?.at(-1)?.end_time ?? s.start_time,
          ),
        );
        if (
          !Number.isFinite(start) ||
          !Number.isFinite(end) ||
          end < start ||
          end > this.bytes / 32000 + 2
        )
          return;
        const revision = (this.revisions.get(id) ?? -1) + 1;
        this.revisions.set(id, revision);
        const event: PerceptionEvent = {
          id,
          deviceId: this.start.deviceId,
          streamId: this.start.streamId,
          revision,
          kind: "transcript",
          final: t.is_final,
          sourceStart: this.anchor.capturedAt + start * 1000,
          sourceEnd: this.anchor.capturedAt + end * 1000,
          text: t.segments
            .map((s) => s.text)
            .join(" ")
            .trim()
            .slice(0, 12000),
          confidence: words.length
            ? words.reduce((sum, w) => sum + (w.prob ?? 0.8), 0) / words.length
            : 0.8,
          speakerId: null,
          personIds: [],
          provenance: "baseten-whisper",
          timing: {
            method: "clock-mapped",
            clockSessionId: this.start.streamId,
            uncertaintyMs: this.anchor.uncertaintyMs + 100,
          },
          words: words
            .slice(0, 2000)
            .map((w) => ({
              text: w.word,
              sourceStart: this.anchor!.capturedAt + w.start_time * 1000,
              sourceEnd: this.anchor!.capturedAt + w.end_time * 1000,
            })),
        };
        if (!event.text) return;
        this.ingest(event);
        if (t.is_final) this.finalized.add(id);
        this.client.send(JSON.stringify({ type: "transcript", event }));
      } catch {
        this.fail("Speech result could not be timestamped reliably");
      }
    });
  }
  private fail(message: string) {
    if (this.closed) return;
    this.client.send(JSON.stringify({ type: "error", message }));
    this.close();
    this.client.close();
  }
  close() {
    this.closed = true;
    clearTimeout(this.connectionTimer);
    this.cloud?.close();
  }
}
