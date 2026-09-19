// Face overlay for the live camera preview: boxes + the stable recognised name (or "Unknown").
// Draws only what the existing /ws/faces stream already returned; it never promotes the raw
// `match` candidate to an identity, never touches inference/clip images, and is independent of
// the LCD. Coordinates come in the SENT frame's pixel space (`input_wh`); they are mapped through
// the preview's object-fit so boxes line up even when the video is cropped or letterboxed.

/**
 * Map a box from source pixels to preview CSS pixels.
 * @param {[number,number,number,number]} box   x1,y1,x2,y2 in source pixels
 * @param {[number,number]} inputWh              source (sent frame) size
 * @param {{w:number,h:number}} view             preview element size in CSS px
 * @param {{fit?: 'cover'|'contain', mirrored?: boolean}} [opts]
 * @returns {{x:number,y:number,w:number,h:number}|null}
 */
export function mapBox(box, inputWh, view, { fit = 'cover', mirrored = false } = {}) {
  const [sw, sh] = inputWh ?? [];
  if (!(sw > 0 && sh > 0 && view?.w > 0 && view?.h > 0) || !Array.isArray(box) || box.length < 4) return null;
  const scale = fit === 'contain' ? Math.min(view.w / sw, view.h / sh) : Math.max(view.w / sw, view.h / sh);
  const offX = (view.w - sw * scale) / 2;   // negative when cropped (cover), positive when letterboxed (contain)
  const offY = (view.h - sh * scale) / 2;
  let x1 = box[0] * scale + offX, x2 = box[2] * scale + offX;
  const y1 = box[1] * scale + offY, y2 = box[3] * scale + offY;
  if (mirrored) { const m1 = view.w - x2, m2 = view.w - x1; x1 = m1; x2 = m2; }
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}

/** Intersection of a mapped rect with the visible preview, or null when it is fully off-screen. */
export function visibleRect(r, view) {
  if (!r || !view) return null;
  const x1 = Math.max(0, r.x), y1 = Math.max(0, r.y), x2 = Math.min(view.w, r.x + r.w), y2 = Math.min(view.h, r.y + r.h);
  return x2 > x1 && y2 > y1 ? { x: x1, y: y1, w: x2 - x1, h: y2 - y1 } : null;
}

/**
 * Choose where the name tag goes so it is always inside the preview: above the box when there is
 * room, else below it, else pinned inside the visible part of the box. x is clamped so the tag
 * never runs off the right edge; the tag can never be wider than the preview.
 */
export function placeLabel(rect, labelW, view, { h = 18, gap = 2 } = {}) {
  const vis = visibleRect(rect, view);
  if (!vis) return null;
  const w = Math.min(labelW, view.w);
  let y;
  if (rect.y - h - gap >= 0) y = rect.y - h - gap;                              // above
  else if (rect.y + rect.h + gap + h <= view.h) y = rect.y + rect.h + gap;      // below
  else y = Math.min(Math.max(vis.y + gap, 0), view.h - h);                      // inside the visible part
  const x = Math.min(Math.max(rect.x, 0), Math.max(0, view.w - w));
  return { x, y, w, h };
}

/** Shorten a label with an ellipsis until it fits `maxW` under `measure(text) → width`. */
export function fitLabel(text, maxW, measure) {
  if (measure(text) <= maxW) return text;
  let t = text;
  while (t.length > 1 && measure(t + '…') > maxW) t = t.slice(0, -1);
  return t.length > 1 ? t + '…' : '…';
}

/** Label policy: only the server's stable identity counts; the raw match is never shown as a name. */
export function faceLabel(face) {
  return typeof face?.stable_name === 'string' && face.stable_name.trim() ? face.stable_name.trim() : 'Unknown';
}

/**
 * @param {HTMLCanvasElement} canvas   absolutely positioned over the video
 * @param {{ measure?: () => {w:number,h:number}, isMirrored?: () => boolean, fit?: 'cover'|'contain',
 *   holdMs?: number, clock?: {setTimeout, clearTimeout}, dpr?: () => number, observeResize?: (fn) => (() => void) }} [opts]
 */
export function createFaceOverlay(canvas, opts = {}) {
  const measure = opts.measure ?? (() => ({ w: canvas.clientWidth, h: canvas.clientHeight }));
  const isMirrored = opts.isMirrored ?? (() => false);
  const fit = opts.fit ?? 'cover';
  const holdMs = opts.holdMs ?? 1500;          // freshness window measured from CAPTURE time, not receipt
  const clock = opts.clock ?? { nowMs: () => Math.floor(performance.now()), setTimeout: (f, ms) => globalThis.setTimeout(f, ms), clearTimeout: (id) => globalThis.clearTimeout(id) };
  const nowMs = () => (typeof clock.nowMs === 'function' ? clock.nowMs() : null);
  const dpr = opts.dpr ?? (() => globalThis.devicePixelRatio || 1);
  let last = null;        // { faces, inputWh, capturedAtMs }
  let holdTimer = null;
  let destroyed = false;
  const unobserve = opts.observeResize ? opts.observeResize(() => { if (last) paint(); }) : null;

  function ctx2d() { return canvas.getContext?.('2d') ?? null; }

  function paint() {
    const c = ctx2d();
    if (!c) return;
    const view = measure();
    const scale = dpr();
    const pw = Math.max(1, Math.round(view.w * scale)), ph = Math.max(1, Math.round(view.h * scale));
    if (canvas.width !== pw || canvas.height !== ph) { canvas.width = pw; canvas.height = ph; }
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, pw, ph);
    if (!last || !last.faces.length) return;
    c.scale(scale, scale);
    const mirrored = isMirrored();
    c.font = '600 13px -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif';
    c.textBaseline = 'top';
    const textWidth = (t) => (c.measureText?.(t)?.width ?? t.length * 7);
    for (const face of last.faces) {
      const r = mapBox(face.box, last.inputWh, view, { fit, mirrored });
      if (!r || r.w <= 0 || r.h <= 0 || !visibleRect(r, view)) continue; // fully off-screen → skip entirely
      const known = Boolean(face.stable_name);
      const colour = known ? '#4cc26a' : '#e2b04a';
      c.lineWidth = 2;
      c.strokeStyle = colour;
      c.strokeRect(r.x, r.y, r.w, r.h); // true geometry; the canvas clips whatever is outside
      const label = fitLabel(faceLabel(face), view.w - 10, textWidth);
      const tag = placeLabel(r, textWidth(label) + 10, view);
      if (!tag) continue;
      c.fillStyle = colour;
      c.fillRect(tag.x, tag.y, tag.w, tag.h);
      c.fillStyle = '#111';
      c.fillText(label, tag.x + 5, tag.y + 2);
    }
  }

  function armHold(remainingMs) {
    clock.clearTimeout(holdTimer);
    holdTimer = clock.setTimeout(() => { last = null; paint(); }, Math.max(0, remainingMs));
  }

  return {
    /**
     * Show one frame's faces. `frame.faces[].box` in `frame.input_wh` pixels. `meta.captureTsMs`
     * (same clock domain as `clock.nowMs`) dates the observation: a reply already older than the
     * freshness window is ignored, and a fresh one is held only for its remaining lifetime.
     * An older observation never replaces a newer one that is still on screen.
     */
    show(frame, meta = {}) {
      if (destroyed) return;
      const faces = Array.isArray(frame?.faces) ? frame.faces.filter((f) => Array.isArray(f?.box) && f.box.length >= 4) : [];
      const inputWh = Array.isArray(frame?.input_wh) && frame.input_wh.length === 2 ? frame.input_wh : null;
      const now = nowMs();
      const capturedAtMs = Number.isFinite(meta?.captureTsMs) ? meta.captureTsMs : now;
      const age = now !== null && capturedAtMs !== null ? now - capturedAtMs : 0;
      if (age >= holdMs) return;                                              // already stale on arrival
      if (last && last.capturedAtMs !== null && capturedAtMs < last.capturedAtMs) return; // out-of-order: keep the newer one
      last = faces.length && inputWh ? { faces, inputWh, capturedAtMs } : null;
      paint();
      if (last) armHold(holdMs - Math.max(0, age)); else clock.clearTimeout(holdTimer);
    },
    clear() { clock.clearTimeout(holdTimer); last = null; if (!destroyed) paint(); },
    destroy() { destroyed = true; clock.clearTimeout(holdTimer); unobserve?.(); last = null; const c = ctx2d(); c?.setTransform?.(1, 0, 0, 1, 0, 0); c?.clearRect?.(0, 0, canvas.width, canvas.height); },
    get current() { return last; },
  };
}
