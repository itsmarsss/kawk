// Provider interface (see contracts/types.d.ts `Provider`). Shared plumbing for concrete providers.

/**
 * @typedef {import('../contracts/types').Provider} Provider
 * @typedef {import('../contracts/types').Envelope} Envelope
 * @typedef {import('../contracts/types').Command} Command
 */

/** Minimal listener set + emit helper used by every provider implementation. */
export function createEmitter() {
  const listeners = new Set();
  return {
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    emit(envelope) { for (const fn of [...listeners]) fn(envelope); },
    get size() { return listeners.size; },
  };
}

/** Real-time clock; tests inject a fake one with the same shape. */
export const realClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (id) => globalThis.clearTimeout(id),
};
