import { Temporal } from "@js-temporal/polyfill";
import type { PerceptionEvent } from "./contracts";

export interface ClockSample {
  clientSent: number;
  serverReceived: number;
  serverSent: number;
  clientReceived: number;
}
export interface ClockMapping {
  sessionId: string;
  offsetMs: number;
  uncertaintyMs: number;
  measuredAt: number;
  maxAgeMs: number;
  driftPpm: number;
}

// Bounds assume nonnegative network transit and a stable server wall clock during
// the exchange. They are not a calibrated probability or a guarantee of UTC accuracy.
export function mapClock(sessionId: string, samples: ClockSample[], driftPpm = 100): ClockMapping {
  if (!sessionId || !samples.length || !Number.isFinite(driftPpm) || driftPpm < 0)
    throw new Error("Clock mapping needs a session and valid samples");
  const estimates = samples
    .map((s) => {
      if (
        Object.values(s).some((n) => !Number.isFinite(n)) ||
        s.clientReceived < s.clientSent ||
        s.serverSent < s.serverReceived
      )
        throw new Error("Invalid clock exchange");
      // The server uses integer-millisecond Date.now(), while the client uses a
      // fractional monotonic clock. Include that precision in the bounds BEFORE
      // testing for a clock jump; a sub-ms localhost round trip can cross a tick.
      const lo = s.serverSent - s.clientReceived - 1;
      const hi = s.serverReceived - s.clientSent + 1;
      if (lo > hi) throw new Error("Clock changed during exchange");
      return { lo, hi, at: s.clientReceived };
    })
    .sort((a, b) => a.hi - a.lo - (b.hi - b.lo));
  const best = estimates[0]!;
  return {
    sessionId,
    offsetMs: (best.lo + best.hi) / 2,
    uncertaintyMs: (best.hi - best.lo) / 2,
    measuredAt: best.at,
    maxAgeMs: 60000,
    driftPpm,
  };
}

export function mapCapture(
  mapping: ClockMapping,
  sessionId: string,
  start: number,
  end: number,
  sourceErrorMs = 0,
) {
  if (
    sessionId !== mapping.sessionId ||
    !Number.isFinite(start) ||
    !Number.isFinite(end) ||
    end < start ||
    !Number.isFinite(sourceErrorMs) ||
    sourceErrorMs < 0
  )
    throw new Error("Invalid capture clock/session");
  const age = Math.max(Math.abs(start - mapping.measuredAt), Math.abs(end - mapping.measuredAt));
  if (age > mapping.maxAgeMs) throw new Error("Clock mapping expired; recalibrate");
  return {
    sourceStart: start + mapping.offsetMs,
    sourceEnd: end + mapping.offsetMs,
    timing: {
      method: "clock-mapped" as const,
      clockSessionId: sessionId,
      uncertaintyMs: mapping.uncertaintyMs + (age * mapping.driftPpm) / 1e6 + sourceErrorMs,
      captureStart: start,
      captureEnd: end,
    },
  };
}

export function interval(e: PerceptionEvent) {
  const error = e.timing?.uncertaintyMs;
  return {
    start: e.sourceStart - (error ?? 0),
    end: e.sourceEnd + (error ?? 0),
    uncertaintyKnown: error !== undefined,
    method: e.timing?.method ?? "unspecified",
  };
}

export function relateTime(a: PerceptionEvent, b: PerceptionEvent) {
  const x = interval(a),
    y = interval(b);
  const possible = x.start <= y.end && y.start <= x.end;
  const aError = a.timing?.uncertaintyMs ?? 0,
    bError = b.timing?.uncertaintyMs ?? 0;
  return {
    possibleOverlap: possible,
    overlapCertainWithinBounds:
      x.uncertaintyKnown &&
      y.uncertaintyKnown &&
      a.sourceStart + aError <= b.sourceEnd - bError &&
      b.sourceStart + bError <= a.sourceEnd - aError,
    uncertaintyKnown: x.uncertaintyKnown && y.uncertaintyKnown,
    provesSpeakerIdentity: false as const,
  };
}

export function validateTimeZone(zone: string) {
  Temporal.Instant.fromEpochMilliseconds(0).toZonedDateTimeISO(zone);
  return zone;
}
export function currentTime(at: number, timeZone: string) {
  const instant = Temporal.Instant.fromEpochMilliseconds(at);
  return {
    epochMs: at,
    iso: instant.toString(),
    timeZone,
    local: instant.toZonedDateTimeISO(timeZone).toString(),
  };
}

/** Temporal rejects invalid dates and DST gaps/duplicates rather than choosing
 * a reminder time silently. Callers can supply an explicit offset when needed. */
export function resolveLocalTime(local: string, timeZone: string): number {
  return Temporal.ZonedDateTime.from(`${local}[${validateTimeZone(timeZone)}]`, {
    overflow: "reject",
    disambiguation: "reject",
    offset: "reject",
  }).epochMilliseconds;
}
