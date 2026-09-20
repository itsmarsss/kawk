import type { Clock } from '../src/types.ts';

export class FakeClock implements Clock {
  t = 1_700_000_000_000;
  private seq = 0;
  private timers = new Map<number, { at: number; fn: () => void }>();
  now(): number { return this.t; }
  setTimeout(fn: () => void, ms: number): number { const id = ++this.seq; this.timers.set(id, { at: this.t + ms, fn }); return id; }
  clearTimeout(h: unknown): void { this.timers.delete(h as number); }
  /** Advance wall time, firing due timers in due order (timers armed while firing are honoured). */
  advance(ms: number): void {
    const target = this.t + ms;
    for (;;) {
      let next: [number, { at: number; fn: () => void }] | null = null;
      for (const e of this.timers) if (e[1].at <= target && (!next || e[1].at < next[1].at || (e[1].at === next[1].at && e[0] < next[0]))) next = e;
      if (!next) break;
      this.timers.delete(next[0]);
      this.t = Math.max(this.t, next[1].at);
      next[1].fn();
    }
    this.t = target;
  }
  get pending(): number { return this.timers.size; }
}

/** Minimal in-memory WebSocket. The test drives the server side via serverSend / serverClose. */
export class FakeWebSocket {
  static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
  static instances: FakeWebSocket[] = [];
  readyState = 0;
  binaryType = 'blob';
  bufferedAmount = 0;
  sent: (ArrayBuffer | string)[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  constructor(public url: string) { FakeWebSocket.instances.push(this); }
  send(data: ArrayBuffer | string): void { if (this.readyState !== 1) throw new Error('not open'); this.sent.push(data); }
  close(): void { this.readyState = 3; }
  // server side
  serverOpen(): void { this.readyState = 1; this.onopen?.(); }
  serverSend(obj: unknown): void { this.onmessage?.({ data: JSON.stringify(obj) }); }
  serverClose(): void { this.readyState = 3; this.onclose?.(); }
  get binarySent(): ArrayBuffer[] { return this.sent.filter((s): s is ArrayBuffer => typeof s !== 'string'); }
}

export function installFakeWebSocket(): void {
  FakeWebSocket.instances = [];
  (globalThis as unknown as { WebSocket: unknown }).WebSocket = FakeWebSocket;
  (globalThis as unknown as { location: unknown }).location = { protocol: 'http:', host: 'localhost:8082' };
}

export const bytes = (n: number, fill = 1): ArrayBuffer => { const b = new Uint8Array(n); b.fill(fill); return b.buffer; };
