// Same-page navigation: three views in one document. Switching only toggles which section is presented; the Run
// (camera, microphone, sockets, timers) lives in module state and is never touched by navigation.
export const VIEWS = ['live', 'memory', 'debug'] as const;
export type View = typeof VIEWS[number];
export const VIEW_LABEL: Record<View, string> = { live: 'Live', memory: 'Memory', debug: 'Debug' };

export function isView(v: unknown): v is View { return typeof v === 'string' && (VIEWS as readonly string[]).includes(v); }
/** `#memory` → memory; anything else (empty, unknown, `#notification…`) → live. */
export function viewFromHash(hash: string): View {
  const h = hash.startsWith('#') ? hash.slice(1) : hash;
  return isView(h) ? h : 'live';
}
export function hashForView(v: View): string { return `#${v}`; }

/** Which presentation each section gets for the selected view. Live is kept painted (off-stage) so a running preview keeps decoding. */
export function presentation(selected: View, section: View): 'shown' | 'offstage' | 'hidden' {
  if (selected === section) return 'shown';
  return section === 'live' ? 'offstage' : 'hidden';
}
