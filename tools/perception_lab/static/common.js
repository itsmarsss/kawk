// Shared helpers for the Remember testing lab pages. No keys, no vendors.

export async function fetchJson(path, options) {
  const response = await fetch(path, options);
  if (!response.ok) {
    let detail = '';
    try { detail = (await response.text()).slice(0, 300); } catch { /* ignore */ }
    throw new Error(`${options?.method || 'GET'} ${path} failed: ${response.status}${detail ? ' ' + detail : ''}`);
  }
  return response.json();
}

export function fetchStatus() {
  return fetchJson('/api/status');
}

// ws:// on http pages, wss:// on https pages, same host and port. params -> query string.
export function wsUrl(path, params) {
  const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const query = params ? new URLSearchParams(params).toString() : '';
  return `${scheme}//${location.host}${path}${query ? '?' + query : ''}`;
}

// Plain names for each backend choice. The <select> shows these; nothing else is implied.
export const BACKEND_LABELS = {
  face: { local: 'Face local buffalo_l CoreML', baseten: 'Face Baseten buffalo_l' },
  objects: { local: 'Objects local YOLO-World', baseten: 'Objects Baseten SAM 3.1' },
  speech: { local: 'Speech local Whisper Small int8', baseten: 'Speech Baseten Whisper Large v3' },
};

// Backend selector bound to /api/status.backends[kind]. "configured" means the server found the
// assets or endpoint configuration for that choice; it does not mean the model is loaded, warm,
// or verified. When the server does not report backends at all, Start stays allowed.
export function setupBackendSelector({ select, detail, recheck, kind, defaultBackend, onChange }) {
  const labels = BACKEND_LABELS[kind];
  const state = { value: defaultBackend, configured: true, detail: '', reported: false };
  select.replaceChildren(...['local', 'baseten'].map((key) => new Option(labels[key], key)));
  select.value = defaultBackend;

  function apply(backends) {
    state.value = select.value;
    const info = backends?.[kind]?.[state.value];
    state.reported = Boolean(backends && backends[kind]);
    if (!state.reported) {
      state.configured = true;
      state.detail = 'Server did not report backend configuration for this component.';
    } else {
      state.configured = Boolean(info?.configured);
      state.detail = info?.detail || (state.configured ? 'Configured.' : 'Not configured.');
    }
    for (const option of select.options) {
      const item = backends?.[kind]?.[option.value];
      option.textContent = labels[option.value] + (item && !item.configured ? ' (not configured)' : '');
    }
    detail.textContent = state.configured
      ? `${labels[state.value]}: ${state.detail} Configured means assets or endpoint settings exist, not that the model is loaded or warm.`
      : `${labels[state.value]} is not available: ${state.detail} Start is disabled for this choice.`;
    detail.className = state.configured ? 'small muted' : 'small error-text';
  }

  async function refresh() {
    detail.textContent = 'Checking server status…';
    try {
      const status = await fetchStatus();
      apply(status.backends);
      return status;
    } catch (e) {
      state.configured = false;
      state.detail = e.message;
      detail.textContent = `Could not read server status: ${e.message}`;
      detail.className = 'small error-text';
      return null;
    }
  }

  select.addEventListener('change', async () => {
    if (onChange) onChange(select.value);
    await refresh();
    if (onChange) onChange(select.value, 'refreshed');
  });
  recheck.addEventListener('click', async () => { await refresh(); if (onChange) onChange(select.value, 'refreshed'); });
  return { refresh, get value() { return select.value; }, get configured() { return state.configured; }, get label() { return labels[select.value]; } };
}

export function fmtMs(value) {
  if (value === null || value === undefined || Number.isNaN(value)) return 'n/a';
  return `${Math.round(value)} ms`;
}

export function fmtSeconds(totalSeconds) {
  const s = Math.max(0, Math.floor(totalSeconds));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

// kind: 'ok' | 'warn' | 'err' | '' (neutral)
export function setStatus(element, text, kind = '') {
  element.textContent = text;
  element.className = `status ${kind}`.trim();
}

export function setError(element, text) {
  element.textContent = text || '';
}

// Fill a <select> with media devices of one kind. Keeps the current selection when possible.
export async function fillDeviceSelect(select, kind, placeholder) {
  if (!navigator.mediaDevices?.enumerateDevices) {
    select.replaceChildren(new Option('Media devices are not available in this browser', ''));
    return [];
  }
  const previous = select.value;
  const devices = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === kind);
  const options = [];
  let unlabeled = 0;
  devices.forEach((device, index) => {
    if (!device.label) unlabeled += 1;
    const label = device.label || `${placeholder} ${index + 1} (label appears after access is granted)`;
    options.push(new Option(label, device.deviceId));
  });
  if (options.length === 0) options.push(new Option(`No ${placeholder.toLowerCase()} found`, ''));
  select.replaceChildren(...options);
  if (previous && devices.some((d) => d.deviceId === previous)) select.value = previous;
  return { devices, unlabeled };
}

export function describeMediaError(error, what) {
  const name = error?.name || '';
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return `${what} permission was denied. Allow access in the browser address bar or in System Settings > Privacy & Security, then click Start again. Camera and microphone also need a secure page: localhost or trusted HTTPS.`;
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError') {
    return `The selected ${what.toLowerCase()} was not found. It may be unplugged or disconnected. Click Refresh devices and pick another one.`;
  }
  if (name === 'NotReadableError' || name === 'AbortError') {
    return `The ${what.toLowerCase()} could not be started (${name}). Another app may be using it. Close that app and try again.`;
  }
  return `${what} error: ${error?.message || String(error)}`;
}

// Run cleanup when the tab is hidden, navigated away, or closed.
export function onPageLeave(cleanup) {
  window.addEventListener('pagehide', cleanup);
  window.addEventListener('beforeunload', cleanup);
}

export function stopTracks(stream) {
  if (!stream) return;
  for (const track of stream.getTracks()) {
    try { track.stop(); } catch { /* ignore */ }
  }
}
