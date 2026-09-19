// Tiny DOM + formatting helpers. No framework.

/** h('div.card#x', {attrs}, ...children) — class/id shorthand, props, event handlers via on*. */
export function h(tag, props, ...children) {
  if (props && (props instanceof Node || typeof props !== 'object' || Array.isArray(props))) { children.unshift(props); props = null; }
  const [name, ...rest] = tag.split(/(?=[.#])/);
  const el = document.createElement(name || 'div');
  for (const part of rest) { if (part[0] === '.') el.classList.add(part.slice(1)); else el.id = part.slice(1); }
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'class') el.className = [el.className, v].filter(Boolean).join(' ');
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k in el && k !== 'list' && k !== 'form' && typeof v !== 'object') el[k] = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  append(el, children);
  return el;
}
export function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}
export const frag = (...children) => append(document.createDocumentFragment(), children);
export function replaceChildren(el, ...children) { el.replaceChildren(); append(el, children); return el; }

/* --------------------------------------------------------------- formatting */

const timeFmt = new Intl.DateTimeFormat([], { hour: '2-digit', minute: '2-digit' });
const dayFmt = new Intl.DateTimeFormat([], { weekday: 'short', day: 'numeric', month: 'short' });
const fullFmt = new Intl.DateTimeFormat([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit' });

/** Relative + absolute, e.g. "2 h ago · 12:04" / "Yesterday · 16:40" / "Just now". */
export function when(isoStr, nowMs = Date.now()) {
  if (!isoStr) return 'unknown';
  const t = Date.parse(isoStr);
  if (Number.isNaN(t)) return 'unknown';
  const d = nowMs - t;
  const time = timeFmt.format(t);
  if (d < 45_000) return 'Just now';
  if (d < 3_600_000) return `${Math.round(d / 60_000)} min ago · ${time}`;
  if (sameDay(t, nowMs)) return `${Math.round(d / 3_600_000)} h ago · ${time}`;
  if (sameDay(t, nowMs - 86_400_000)) return `Yesterday · ${time}`;
  return `${dayFmt.format(t)} · ${time}`;
}
export const clock = (isoStr) => (isoStr ? timeFmt.format(Date.parse(isoStr)) : '—');
const timeFmtS = new Intl.DateTimeFormat([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
export const clockS = (isoStr) => (isoStr ? timeFmtS.format(Date.parse(isoStr)) : '—');
export const full = (isoStr) => (isoStr ? fullFmt.format(Date.parse(isoStr)) : '—');
function sameDay(a, b) { const x = new Date(a), y = new Date(b); return x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth() && x.getDate() === y.getDate(); }

export function initials(name) {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('') || '?';
}

/** Re-render `fn()` into `root` while keeping focus + input value on the focused element by id. */
export function renderPreservingFocus(root, fn) {
  const active = document.activeElement;
  const keep = active && root.contains(active) && active.id ? { id: active.id, value: 'value' in active ? active.value : null, start: active.selectionStart, end: active.selectionEnd } : null;
  const scrollY = window.scrollY;
  replaceChildren(root, fn());
  if (keep) {
    const el = document.getElementById(keep.id);
    if (el) {
      if (keep.value !== null && 'value' in el && el.value !== keep.value) el.value = keep.value;
      el.focus({ preventScroll: true });
      try { if (keep.start != null && el.setSelectionRange) el.setSelectionRange(keep.start, keep.end); } catch { /* not a text control */ }
    }
  }
  window.scrollTo(0, scrollY);
}

let toastTimer = 0;
export function toast(message) {
  document.querySelector('.toast')?.remove();
  const el = h('div.toast', { role: 'status' }, message);
  document.body.append(el);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.remove(), 2600);
}
