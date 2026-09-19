// Node tests for the speech client's reconnect session (live/perception.js createSpeechStream) and
// the V1 provider's stream.state handling around it. Fake sockets and clock; fully offline.
import { check, eq, fakeClock } from './harness.mjs';

globalThis.location = globalThis.location || { protocol: 'http:', host: 'localhost:8000' };

const perception = await import('../live/perception.js');
const { createSpeechStream, SPEECH_READY_TIMEOUT_MS, SPEECH_RECONNECT_DELAYS_MS, SPEECH_MAX_RECONNECTS, SPEECH_RECONNECT_RESET_MS } = perception;

class FakeWebSocket {
  static instances = [];
  constructor(url) {
    this.url = url; this.readyState = 0; this.sent = []; this.bufferedAmount = 0; this.closeCalls = 0;
    this.onopen = null; this.onmessage = null; this.onclose = null; this.onerror = null;
    FakeWebSocket.instances.push(this);
  }
  send(data) { this.sent.push(data); }
  close() { this.closeCalls += 1; this.readyState = 3; }
  open() { this.readyState = 1; this.onopen?.(); }
  message(obj) { this.onmessage?.({ data: JSON.stringify(obj) }); }
  serverClose(code = 1006) { this.readyState = 3; this.onclose?.({ code }); }
  error() { this.onerror?.({}); }
  jsonSent() { return this.sent.filter((m) => typeof m === 'string').map((m) => JSON.parse(m)); }
  binarySent() { return this.sent.filter((m) => m instanceof ArrayBuffer); }
}

function makeCapture(clock) {
  const chunkFns = new Set();
  return {
    onChunk(fn) { chunkFns.add(fn); return () => chunkFns.delete(fn); },
    emitChunk(bytes = 1024) { for (const fn of [...chunkFns]) fn({ buffer: new ArrayBuffer(bytes), sampleCount: 512, captureTsMs: clock.nowMs() - 32 }); },
    listenerCount: () => chunkFns.size,
  };
}

function rig() {
  FakeWebSocket.instances = [];
  const fc = fakeClock();
  const clock = { nowMs: () => fc.now(), setTimeout: fc.setTimeout, clearTimeout: fc.clearTimeout, pending: fc.pending };
  const capture = makeCapture(clock);
  const statuses = [];
  const transcripts = [];
  const stream = createSpeechStream({
    backend: 'baseten', capture,
    onTranscript: (msg, meta) => transcripts.push({ msg, meta }),
    onStatus: (s) => statuses.push(s),
    deps: { WebSocketImpl: FakeWebSocket, clock },
  });
  const sockets = FakeWebSocket.instances;
  return {
    fc, clock, capture, statuses, transcripts, stream, sockets,
    last: () => sockets.at(-1),
    terminal: () => statuses.filter((s) => s.phase === 'stopped' || s.phase === 'error'),
    reconnecting: () => statuses.filter((s) => s.phase === 'reconnecting'),
    running: () => statuses.filter((s) => s.phase === 'running' && s.ready),
    ready(ws = sockets.at(-1)) { ws.open(); ws.message({ type: 'ready', backend: 'baseten', model_id: 'whisper' }); },
  };
}

export async function run() {
  console.log('\n# speech reconnect: cold-start deadline exceeds the server upstream timeout');
  {
    check(SPEECH_READY_TIMEOUT_MS > 120_000 && SPEECH_READY_TIMEOUT_MS <= 140_000, `ready deadline is ~130 s (got ${SPEECH_READY_TIMEOUT_MS})`);
    const t = rig();
    await t.stream.start();
    const first = t.stream.streamId;
    t.last().open();
    t.last().message({ type: 'connecting' });
    t.fc.advance(20_000);
    eq(t.terminal().length + t.reconnecting().length, 0, 'still waiting at 20 s (old deadline) — no failure');
    eq(t.stream.state, 'connecting', 'state is connecting at 20 s');
    t.fc.advance(SPEECH_READY_TIMEOUT_MS - 20_000 - 1);
    eq(t.reconnecting().length, 0, 'still waiting 1 ms before the deadline');
    t.fc.advance(1);
    eq(t.terminal().length, 0, 'deadline does not end the session');
    eq(t.reconnecting().length, 1, 'deadline schedules a reconnect');
    const rc = t.reconnecting()[0];
    eq(rc.previousStreamId, first, 'reconnecting names the failed stream id');
    eq([rc.attempt, rc.maxAttempts, rc.retryInMs], [1, SPEECH_MAX_RECONNECTS, SPEECH_RECONNECT_DELAYS_MS[0]], 'attempt 1 with the first backoff');
    check(/waking from zero/.test(rc.message) && /Reconnecting speech/.test(rc.message), 'reconnecting message explains the cold start and the retry');
    eq(t.sockets[0].readyState, 3, 'timed-out socket closed');
    eq(t.stream.streamId, null, 'no stream id while waiting to reconnect');
    eq(t.stream.state, 'reconnecting', 'state reconnecting between attempts');
    eq(t.sockets.length, 1, 'no new socket before the backoff elapses');
    t.fc.advance(SPEECH_RECONNECT_DELAYS_MS[0]);
    eq(t.sockets.length, 2, 'second socket opened after the backoff');
    check(t.stream.streamId && t.stream.streamId !== first, 'second attempt has a fresh stream id');
    const conn = t.statuses.filter((s) => s.phase === 'connecting').at(-1);
    eq(conn.streamId, t.stream.streamId, 'connecting status carries the new stream id');
    check(/attempt 1 of/.test(conn.message), 'connecting status says which attempt this is');
    t.stream.stop();
    eq(t.terminal().map((s) => s.phase), ['stopped'], 'stop ends cleanly');
    eq(t.clock.pending(), 0, 'no timers left');
  }

  console.log('\n# speech reconnect: id rollover, status forwarding, audio after recovery, stale callbacks');
  {
    const t = rig();
    await t.stream.start();
    t.ready();
    const ws1 = t.sockets[0];
    const id1 = t.stream.streamId;
    eq(t.running().length, 1, 'first running');
    eq(t.running()[0].streamId, id1, 'running status carries the stream id');
    eq(t.capture.listenerCount(), 1, 'one chunk subscription');
    t.capture.emitChunk();
    eq(ws1.binarySent().length, 1, 'audio flows on the first connection');
    ws1.message({ type: 'transcript', segment_id: 0, text: 'hello', is_final: false });
    eq(t.transcripts.length, 1, 'transcript from the first connection delivered');
    eq(t.transcripts[0].meta.streamId, id1, 'transcript tagged with the first id');

    ws1.serverClose();
    eq(t.terminal().length, 0, 'server close does not end the session');
    eq(t.reconnecting().length, 1, 'server close schedules a reconnect');
    eq(t.reconnecting()[0].previousStreamId, id1, 'reconnecting names the closed stream id');
    check(/Speech connection closed/.test(t.reconnecting()[0].message), 'reconnecting message carries the failure');
    eq(t.capture.listenerCount(), 0, 'chunks unsubscribed while reconnecting');
    t.capture.emitChunk();
    eq(ws1.binarySent().length, 1, 'no audio queued/sent while reconnecting');
    // stale callbacks from the dead socket are ignored
    ws1.message({ type: 'transcript', segment_id: 1, text: 'stale', is_final: true });
    ws1.onclose?.({ code: 1000 });
    eq(t.transcripts.length, 1, 'transcript from the dead socket ignored');
    eq(t.sockets.length, 1, 'stale close does not open a second reconnect');

    t.fc.advance(SPEECH_RECONNECT_DELAYS_MS[0]);
    eq(t.sockets.length, 2, 'reconnected once');
    const ws2 = t.sockets[1];
    eq(ws2.url, ws1.url, 'same endpoint');
    const id2 = t.stream.streamId;
    check(id2 && id2 !== id1, 'fresh stream id after reconnect');
    // audio during CONNECTING of the new attempt is dropped, not queued
    t.capture.emitChunk();
    eq(ws2.binarySent().length, 0, 'no audio before the new connection is ready');
    t.ready(ws2);
    eq(t.running().length, 2, 'running again');
    eq(t.running()[1].streamId, id2, 'second running status carries the new id');
    eq(t.running()[1].attempt, 1, 'running status reports the attempt count');
    eq(t.capture.listenerCount(), 1, 'exactly one chunk subscription after recovery (no duplicates)');
    t.capture.emitChunk();
    eq([ws1.binarySent().length, ws2.binarySent().length], [1, 1], 'audio after recovery goes only to the new socket');
    ws2.message({ type: 'transcript', segment_id: 0, text: 'again', is_final: true });
    eq(t.transcripts.length, 2, 'transcript from the new connection delivered');
    eq(t.transcripts[1].meta.streamId, id2, 'new transcript tagged with the new id');
    // late message on the old socket after the new one is live
    ws1.message({ type: 'transcript', segment_id: 9, text: 'ghost', is_final: true });
    eq(t.transcripts.length, 2, 'late transcript on the old socket ignored');
    eq(t.terminal().length, 0, 'still no terminal status');
    t.stream.stop();
    t.fc.advance(32 * 17 + 3000);
    eq(t.terminal().map((s) => s.phase), ['stopped'], 'graceful stop ends with stopped once');
    eq(t.clock.pending(), 0, 'no timers after stop');
  }

  console.log('\n# speech reconnect: stop during backoff cancels the retry');
  {
    const t = rig();
    await t.stream.start();
    t.ready();
    t.sockets[0].serverClose();
    eq(t.reconnecting().length, 1, 'waiting to reconnect');
    t.stream.stop('user');
    eq(t.terminal().map((s) => s.phase), ['stopped'], 'stopped exactly once');
    eq(t.terminal()[0].message, 'user', 'stop reason forwarded');
    eq(t.clock.pending(), 0, 'retry timer cancelled');
    t.fc.advance(60_000);
    eq(t.sockets.length, 1, 'no socket opened after stop');
    eq(t.terminal().length, 1, 'nothing after stop');
    eq(t.stream.state, 'idle', 'idle after stop');
    t.stream.stop();
    eq(t.terminal().length, 1, 'stop after stop is a no-op');
  }

  console.log('\n# speech reconnect: stop while CONNECTING and graceful stop never reconnect');
  {
    const t = rig();
    await t.stream.start();
    t.stream.stop();
    eq(t.terminal().map((s) => s.phase), ['stopped'], 'stop while connecting → stopped');
    t.fc.advance(SPEECH_READY_TIMEOUT_MS + 10_000);
    eq(t.sockets.length, 1, 'no reconnect after stop while connecting');
    eq(t.reconnecting().length, 0, 'no reconnecting status after stop');
  }
  {
    const t = rig();
    await t.stream.start();
    t.ready();
    t.stream.stop();
    eq(t.capture.listenerCount(), 0, 'stop unsubscribes at once');
    t.fc.advance(32 * 17);
    eq(t.last().jsonSent(), [{ type: 'stop' }], 'stop JSON sent after the flush');
    t.last().message({ type: 'error', message: 'upstream went away' });
    t.last().serverClose();
    eq(t.terminal().map((s) => s.phase), ['stopped'], 'server close after our stop → stopped, not error');
    t.fc.advance(60_000);
    eq(t.sockets.length, 1, 'graceful stop never reconnects');
    eq(t.clock.pending(), 0, 'no timers');
  }
  {
    // server never closes after our stop: grace expiry still ends with stopped and no retry
    const t = rig();
    await t.stream.start();
    t.ready();
    t.stream.stop('done');
    t.fc.advance(32 * 17 + 3000);
    eq(t.terminal().map((s) => s.phase), ['stopped'], 'grace expiry → stopped');
    eq(t.terminal()[0].message, 'done', 'grace expiry keeps the stop reason');
    t.fc.advance(60_000);
    eq(t.sockets.length, 1, 'no reconnect after grace expiry');
  }

  console.log('\n# speech reconnect: audio backlog and WebSocket error are retryable');
  {
    const t = rig();
    await t.stream.start();
    t.ready();
    const ws1 = t.sockets[0];
    ws1.bufferedAmount = 16385;
    t.capture.emitChunk();
    eq(ws1.binarySent().length, 0, 'backlogged chunk not sent');
    eq(ws1.readyState, 3, 'backlog closes the connection at once');
    eq(t.capture.listenerCount(), 0, 'backlog unsubscribes chunks');
    eq(t.reconnecting().length, 1, 'backlog schedules a reconnect instead of stopping for good');
    check(/backlog/i.test(t.reconnecting()[0].message), 'backlog named in the message');
    t.fc.advance(SPEECH_RECONNECT_DELAYS_MS[0]);
    t.ready();
    t.capture.emitChunk();
    eq(t.sockets[1].binarySent().length, 1, 'audio resumes on the fresh connection');
    t.stream.stop();
  }
  {
    const t = rig();
    await t.stream.start();
    t.last().error();
    eq(t.terminal().length + t.reconnecting().length, 0, 'onerror alone is informational (onclose follows)');
    t.last().serverClose();
    eq(t.reconnecting().length, 1, 'close after error reconnects');
    check(/WebSocket error/.test(t.statuses.find((s) => /WebSocket error/.test(s.message ?? ''))?.message ?? ''), 'error message forwarded');
    t.stream.stop();
  }

  console.log('\n# speech reconnect: retryable:false from the server is permanent');
  {
    const t = rig();
    await t.stream.start();
    t.ready();
    t.last().message({ type: 'error', message: 'Baseten API key missing', retryable: false });
    t.last().serverClose();
    eq(t.terminal().map((s) => s.phase), ['error'], 'permanent error ends the session');
    check(/Baseten API key missing/.test(t.terminal()[0].message) && !/Reconnecting/.test(t.terminal()[0].message), 'permanent error message forwarded without a retry promise');
    eq(t.terminal()[0].retryable, false, 'terminal status flags retryable:false');
    eq(t.reconnecting().length, 0, 'no reconnect for a permanent error');
    t.fc.advance(60_000);
    eq(t.sockets.length, 1, 'no socket after a permanent error');
    eq(t.clock.pending(), 0, 'no timers');
    eq(t.stream.state, 'idle', 'idle after permanent error');
  }
  {
    // an error WITHOUT retryable:false (or with retryable:true) still retries
    const t = rig();
    await t.stream.start();
    t.ready();
    t.last().message({ type: 'error', message: 'Whisper closed the connection. Start again to reconnect.', retryable: true });
    t.last().serverClose();
    eq(t.terminal().length, 0, 'retryable error does not end the session');
    eq(t.reconnecting().length, 1, 'retryable error reconnects');
    check(/Whisper closed the connection/.test(t.reconnecting()[0].message), 'server message kept');
    t.stream.stop();
  }

  console.log('\n# speech reconnect: bounded exhaustion and counter reset after a healthy run');
  {
    const t = rig();
    await t.stream.start();
    const ids = [t.stream.streamId];
    for (let i = 0; i < SPEECH_MAX_RECONNECTS; i += 1) {
      t.last().open();
      t.last().serverClose();
      eq(t.reconnecting().length, i + 1, `reconnect ${i + 1} scheduled`);
      eq(t.reconnecting()[i].attempt, i + 1, `attempt counter ${i + 1}`);
      const expectedDelay = SPEECH_RECONNECT_DELAYS_MS[Math.min(i, SPEECH_RECONNECT_DELAYS_MS.length - 1)];
      eq(t.reconnecting()[i].retryInMs, expectedDelay, `backoff ${expectedDelay} ms for attempt ${i + 1}`);
      t.fc.advance(expectedDelay - 1);
      eq(t.sockets.length, i + 1, 'no early reconnect');
      t.fc.advance(1);
      eq(t.sockets.length, i + 2, `socket ${i + 2} opened`);
      ids.push(t.stream.streamId);
    }
    eq(new Set(ids).size, ids.length, 'every attempt used a unique stream id');
    const lastId = t.stream.streamId;
    t.last().open();
    t.last().serverClose();
    eq(t.terminal().map((s) => s.phase), ['error'], 'gives up with a single error after the last allowed attempt');
    check(/gave up after 5 reconnect attempts/.test(t.terminal()[0].message), 'exhaustion message counts the attempts');
    eq(t.terminal()[0].streamId, lastId, 'exhaustion error names the last stream id');
    eq(t.terminal()[0].retryable, true, 'exhaustion is retryable by a fresh start');
    t.fc.advance(600_000);
    eq(t.sockets.length, SPEECH_MAX_RECONNECTS + 1, 'no further sockets after giving up');
    eq(t.clock.pending(), 0, 'no timers after giving up');
    eq(t.stream.state, 'idle', 'idle after giving up');
    // a fresh start() begins a new bounded session
    await t.stream.start();
    eq(t.sockets.length, SPEECH_MAX_RECONNECTS + 2, 'start after exhaustion opens a new connection');
    eq(t.stream.attempt, 0, 'attempt counter reset by start');
    t.stream.stop();
  }
  {
    const t = rig();
    await t.stream.start();
    // burn 4 attempts
    for (let i = 0; i < SPEECH_MAX_RECONNECTS - 1; i += 1) {
      t.last().open(); t.last().serverClose();
      t.fc.advance(SPEECH_RECONNECT_DELAYS_MS[Math.min(i, SPEECH_RECONNECT_DELAYS_MS.length - 1)]);
    }
    eq(t.stream.attempt, SPEECH_MAX_RECONNECTS - 1, 'one attempt left');
    t.ready();
    t.fc.advance(SPEECH_RECONNECT_RESET_MS);
    t.last().serverClose();
    eq(t.terminal().length, 0, 'a drop after a healthy run does not exhaust the budget');
    eq(t.reconnecting().at(-1).attempt, 1, 'attempt counter reset to 1 after a healthy run');
    t.stream.stop();
  }
  {
    // a run shorter than the reset window does NOT reset the counter (flapping server cannot loop forever)
    const t = rig();
    await t.stream.start();
    let closes = 0;
    for (let i = 0; i < SPEECH_MAX_RECONNECTS + 3; i += 1) {
      if (!t.last() || t.last().readyState === 3) break;
      t.ready();
      t.fc.advance(SPEECH_RECONNECT_RESET_MS - 1);
      t.last().serverClose();
      closes += 1;
      if (t.terminal().length) break;
      t.fc.advance(10_000);
    }
    eq(closes, SPEECH_MAX_RECONNECTS + 1, 'flapping ready→close exhausts after the bounded number of attempts');
    eq(t.terminal().map((s) => s.phase), ['error'], 'flapping ends in one error');
  }

  console.log('\n# speech reconnect: restart during backoff or graceful stop');
  {
    const t = rig();
    await t.stream.start();
    t.ready();
    t.sockets[0].serverClose();
    await t.stream.start();
    eq(t.terminal().map((s) => s.phase), ['stopped'], 'restart ends the previous session with stopped');
    eq(t.terminal()[0].message, 'Restarted', 'restart reason');
    eq(t.sockets.length, 2, 'restart opens a new socket at once');
    t.fc.advance(60_000);
    eq(t.sockets.length, 2, 'cancelled retry never fires');
    t.ready();
    eq(t.running().length, 2, 'new session runs');
    t.stream.stop();
  }
  {
    const t = rig();
    await t.stream.start();
    t.ready();
    t.stream.stop();
    t.fc.advance(64);
    await t.stream.start();
    eq(t.terminal().map((s) => s.phase), ['stopped'], 'restart during a graceful flush ends it immediately');
    eq(t.sockets[0].readyState, 3, 'old socket closed');
    eq(t.sockets.length, 2, 'new socket opened');
    t.ready();
    t.capture.emitChunk();
    eq(t.sockets[1].binarySent().length, 1, 'audio flows on the new session');
    eq(t.capture.listenerCount(), 1, 'one subscription');
    t.stream.stop();
    t.fc.advance(32 * 17 + 3000);
    eq(t.terminal().length, 2, 'second session stopped once');
    eq(t.clock.pending(), 0, 'no timers');
  }
}
