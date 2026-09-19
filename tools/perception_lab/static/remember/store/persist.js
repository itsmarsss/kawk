// Versioned localStorage namespace, one key per provider kind. Only these keys are ever read or
// written by the Remember UI; the lab's /api/gallery and everything else on the server are untouched.

export const NAMESPACE_PREFIX = 'remember.ui.v1';
export const namespaceFor = (providerKind) => `${NAMESPACE_PREFIX}.${providerKind}`;
/** Written (timestamp) when a tab resets its demo data, so other tabs can offer a reload. */
export const RESET_SIGNAL_KEY = `${NAMESPACE_PREFIX}.reset`;

export function createPersistence(storage = safeStorage(), key = namespaceFor('demo')) {
  return {
    key,
    load() {
      if (!storage) return null;
      try {
        const raw = storage.getItem(key);
        return raw ? JSON.parse(raw) : null;
      } catch { return null; }
    },
    save(state) {
      if (!storage) return false;
      try { storage.setItem(key, JSON.stringify(state)); return true; } catch { return false; }
    },
    clear() {
      if (!storage) return;
      try { storage.removeItem(key); } catch { /* ignore */ }
    },
  };
}

function safeStorage() {
  try { return globalThis.localStorage ?? null; } catch { return null; }
}

/** In-memory stand-in with the Storage subset we use (tests, private mode, live provider). */
export function memoryStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
}
