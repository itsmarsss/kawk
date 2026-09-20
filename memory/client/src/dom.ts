// Tiny DOM helpers. All user/model text goes through textContent; no innerHTML anywhere.
type Child = Node | string | null | undefined | false;
export function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string | boolean | null | undefined> | null = null, ...children: Child[]): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') node.className = String(v);
    else if (v === true) node.setAttribute(k, '');
    else node.setAttribute(k, String(v));
  }
  for (const c of children) if (c !== null && c !== undefined && c !== false) node.append(typeof c === 'string' ? document.createTextNode(c) : c);
  return node;
}
export function setText(node: Element, value: string): void { if (node.textContent !== value) node.textContent = value; }
export function clear(node: Element): void { while (node.firstChild) node.removeChild(node.firstChild); }
export function replaceChildren(node: Element, children: Child[]): void { clear(node); for (const c of children) if (c) node.append(typeof c === 'string' ? document.createTextNode(c) : c); }

const two = (n: number) => String(n).padStart(2, '0');
export function fmtTime(ms: number | null | undefined): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return '—';
  const d = new Date(ms);
  return `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, '0')}`;
}
export function fmtDateTime(ms: number | null | undefined): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return '—';
  const d = new Date(ms);
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
}
export function fmtMs(ms: number | null | undefined): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return '—';
  return ms >= 10_000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`;
}
export function fmtAgo(ms: number | null | undefined, now: number): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return '—';
  const d = Math.max(0, now - ms);
  if (d < 60_000) return `${Math.round(d / 1000)} s ago`;
  if (d < 3_600_000) return `${Math.round(d / 60_000)} min ago`;
  return `${(d / 3_600_000).toFixed(1)} h ago`;
}
export function short(id: string | null | undefined, n = 10): string { return id ? (id.length > n ? `…${id.slice(-n)}` : id) : '—'; }
export function link(href: string, label: string, newTab = true): HTMLAnchorElement {
  return el('a', { href, ...(newTab ? { target: '_blank', rel: 'noopener' } : {}) }, label);
}
