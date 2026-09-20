import type { z } from "zod";
import type { HistoryQuery, HistoryResult } from "../src/history";
import type { Notification, PerceptionEvent, Task } from "../src/contracts";
import { mapClock, mapCapture, type ClockMapping, type ClockSample } from "../src/temporal";

/** Supply the device-scoped client token, never a model-provider credential. */
export class KawkClient {
  readonly clockSessionId = crypto.randomUUID();
  private clock?: ClockMapping;
  constructor(
    readonly url: string,
    private token: string,
  ) {}
  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await fetch(new URL(path, this.url), {
      ...init,
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
        ...init.headers,
      },
    });
    if (!response.ok) throw new Error(`KAWK HTTP ${response.status}`);
    return response.json() as Promise<T>;
  }
  send(events: PerceptionEvent[]) {
    return this.request<{
      accepted: { id: string; revision: number; duplicate: boolean; current: boolean }[];
    }>("/v1/events", { method: "POST", body: JSON.stringify({ events }) });
  }
  async syncClock() {
    const samples: ClockSample[] = [];
    for (let i = 0; i < 3; i++) {
      const clientSent = performance.now();
      const response = await this.request<{ receivedAt: number; sentAt: number }>("/v1/time");
      samples.push({
        clientSent,
        serverReceived: response.receivedAt,
        serverSent: response.sentAt,
        clientReceived: performance.now(),
      });
    }
    this.clock = mapClock(this.clockSessionId, samples);
    return this.clock;
  }
  captureTimes(monotonicStart: number, monotonicEnd = monotonicStart, sourceErrorMs = 0) {
    if (!this.clock) throw new Error("Call syncClock before capture");
    return mapCapture(this.clock, this.clockSessionId, monotonicStart, monotonicEnd, sourceErrorMs);
  }
  transcripts(
    filter: {
      query?: string;
      from?: number;
      to?: number;
      personId?: string;
      speakerId?: string;
      limit?: number;
      offset?: number;
    } = {},
  ) {
    return this.request<{ evidence: import("../src/contracts").Evidence[] }>(
      "/v1/transcripts/search",
      {
        method: "POST",
        body: JSON.stringify(filter),
      },
    );
  }
  grepHistory(query: z.input<typeof HistoryQuery>) {
    return this.request<HistoryResult>("/v1/history/grep", {
      method: "POST",
      body: JSON.stringify(query),
    });
  }
  reminders() {
    return this.request<{ reminders: unknown[] }>("/v1/reminders");
  }
  cancelReminder(id: string) {
    return this.request<{ cancelled: boolean }>(`/v1/reminders/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
  }
  tasks() {
    return this.request<{ tasks: Task[] }>("/v1/tasks");
  }
  cancel(id: string) {
    return this.request(`/v1/tasks/${encodeURIComponent(id)}/cancel`, { method: "POST" });
  }
  message(id: string, text: string, messageId = crypto.randomUUID()) {
    return this.request(`/v1/tasks/${encodeURIComponent(id)}/message`, {
      method: "POST",
      body: JSON.stringify({ id: messageId, text }),
    });
  }
  notifications() {
    return this.request<{ notifications: Notification[] }>("/v1/notifications");
  }
  ack(id: string) {
    return this.request(`/v1/notifications/${encodeURIComponent(id)}/ack`, { method: "POST" });
  }
  async *watch(signal: AbortSignal): AsyncGenerator<Notification> {
    while (!signal.aborted) {
      try {
        const response = await fetch(new URL("/v1/notifications/stream", this.url), {
          headers: { Authorization: `Bearer ${this.token}` },
          signal,
        });
        if (!response.ok || !response.body) throw new Error(`KAWK stream HTTP ${response.status}`);
        const reader = response.body.getReader(),
          decoder = new TextDecoder();
        let buffer = "";
        try {
          while (!signal.aborted) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            if (buffer.length > 1000000) throw new Error("Stream frame too large");
            let end: number;
            while ((end = buffer.indexOf("\n\n")) >= 0) {
              const frame = buffer.slice(0, end);
              buffer = buffer.slice(end + 2);
              const data = frame.split("\n").find((l) => l.startsWith("data: "));
              if (data) yield JSON.parse(data.slice(6)) as Notification;
            }
          }
        } finally {
          await reader.cancel().catch(() => {});
          reader.releaseLock();
        }
      } catch (error) {
        if (signal.aborted) return;
        if (error instanceof Error && /HTTP (401|403)/.test(error.message)) throw error;
      }
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          signal.removeEventListener("abort", done);
          resolve();
        };
        const timer = setTimeout(done, 1000);
        signal.addEventListener("abort", done, { once: true });
      });
    }
  }
}
