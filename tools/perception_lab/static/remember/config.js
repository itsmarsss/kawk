// The one place a provider is chosen. Two modes:
//   'live' — Live V1: real camera/mic → existing perception sockets → server V1 engine (default home).
//   'demo' — scripted fixtures for development; separate storage, never mixed with live data.
// The mode is remembered per browser; switching reloads the page so no store ever holds both.
import { createDemoProvider } from './providers/demo_provider.js';

export const MODE_KEY = 'remember.ui.mode';
export const LIVE_SETTINGS_KEY = 'remember.ui.v1.live.settings';

export function currentMode() {
  try { const m = globalThis.localStorage?.getItem(MODE_KEY); return m === 'demo' ? 'demo' : 'live'; } catch { return 'live'; }
}
export function setMode(mode) { try { globalThis.localStorage?.setItem(MODE_KEY, mode === 'demo' ? 'demo' : 'live'); } catch { /* ignore */ } }

export const CONFIG = {
  get provider() { return currentMode(); },
  snoozeMinutes: 15,
  defaultLiveSettings: {
    camera: true, microphone: true, cameraId: null, micId: null,
    faces: { enabled: true, backend: 'local' },
    objects: { enabled: true, backend: 'local', vocabulary: ['person', 'keys', 'phone', 'wallet', 'laptop', 'cup', 'backpack', 'glasses'] },
    speech: { enabled: true, backend: 'baseten' },
  },
};

/**
 * @param {{getState: () => any, live?: {capture, streams, createV1Provider}}} deps
 * live.createV1Provider is injected by app.js so the demo bundle never imports capture code.
 */
export function createProvider(deps, kind = CONFIG.provider) {
  if (kind === 'live') {
    if (!deps.live) throw new Error('Live mode needs capture dependencies');
    return deps.live.createV1Provider({ getState: deps.getState, capture: deps.live.capture, streams: deps.live.streams });
  }
  return createDemoProvider({ getState: deps.getState });
}
