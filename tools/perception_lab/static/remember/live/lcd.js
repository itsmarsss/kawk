// Device-display renderer: a faithful 240×240 logical "LCD" preview on a <canvas>, driven by
// backend DisplayAction objects (see AGENTS.md §5/§9 and product.py `_action`).
//
// Two layers:
//   layoutCard(action, opts)            — PURE: DisplayAction → Layout (lines/regions/describe). No DOM.
//   createDeviceDisplay(canvas, opts)   — runtime: paints a Layout, owns TTL fallback, idle tick, clip video.
//
// The renderer never decides priority: it shows whatever action it is given last. Priority
// arbitration is the backend's job (product.py `_show`).

export const PALETTE = Object.freeze({
  bg: '#fbfaf7', fg: '#1c1b18', muted: '#6f6b63', line: '#e6e2da',
  accent: '#1f6f5b', accentSoft: '#e9f2ee', warn: '#8a6410', warnSoft: '#f7f0dd', danger: '#a33a2c',
});
export const FONT_FAMILY = '-apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif';
export const PADDING = 12;
export const TTL_BAR_H = 2;
export const CLIP_FPS_INTERVAL_MS = 100; // ≤ 10 fps
const LINE_HEIGHT = 1.25;
const GAP = 6;

const WEIGHT = { normal: 400, semibold: 600, bold: 700 };

/** Default measurer: ~0.55 em per character, so layout is testable in Node without a canvas. */
export function approxMeasure(text, sizePx /* , weight */) { return String(text ?? '').length * sizePx * 0.55; }

const lh = (size) => Math.round(size * LINE_HEIGHT);
const pad2 = (n) => String(n).padStart(2, '0');
/** Local wall-clock "HH:MM" for a millisecond timestamp. */
export function clockText(ms) { const d = new Date(ms); return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`; }

function flat(text) { return String(text ?? '').replace(/\s*\n\s*/g, ' ').replace(/\s+/g, ' ').trim(); }
function sentence(text) { const t = flat(text); return t && !/[.!?…]$/.test(t) ? `${t}.` : t; }

/** Shorten `text` (appending …) until it fits `maxWidth`. */
export function ellipsize(text, size, weight, maxWidth, measure = approxMeasure) {
  let t = String(text ?? '');
  if (measure(t, size, weight) <= maxWidth) return t;
  while (t.length && measure(`${t}…`, size, weight) > maxWidth) t = t.slice(0, -1).trimEnd();
  return `${t}…`;
}

/** Greedy word wrap honouring explicit "\n" breaks; over-long words are hard-broken by character. */
export function wrapText(text, size, weight, maxWidth, measure = approxMeasure) {
  const out = [];
  for (const para of String(text ?? '').split('\n')) {
    const words = para.trim().split(/\s+/).filter(Boolean);
    if (!words.length) continue;
    let line = '';
    for (const word of words) {
      const cand = line ? `${line} ${word}` : word;
      if (measure(cand, size, weight) <= maxWidth) { line = cand; continue; }
      if (line) out.push(line);
      if (measure(word, size, weight) > maxWidth) {
        let chunk = '';
        for (const ch of word) {
          if (chunk && measure(chunk + ch, size, weight) > maxWidth) { out.push(chunk); chunk = ''; }
          chunk += ch;
        }
        line = chunk;
      } else line = word;
    }
    if (line) out.push(line);
  }
  return out;
}

/** Keep at most `maxLines`; when truncating, the last kept line gets an ellipsis. */
function fitLines(lines, maxLines, size, weight, maxWidth, measure) {
  if (maxLines <= 0) return [];
  if (lines.length <= maxLines) return lines;
  const kept = lines.slice(0, maxLines);
  kept[maxLines - 1] = ellipsize(`${kept[maxLines - 1]}…`, size, weight, maxWidth, measure);
  return kept;
}

function ttlOf(action, nowMs) {
  if (!action?.expires_at) return null;
  const expires = Date.parse(action.expires_at);
  if (!Number.isFinite(expires)) return null;
  const issued = action.issued_at ? Date.parse(action.issued_at) : NaN;
  const total = Number.isFinite(issued) && expires > issued ? expires - issued : (action.ttl_ms > 0 ? action.ttl_ms : expires - nowMs);
  const remaining = expires - nowMs;
  const fraction = total > 0 ? Math.max(0, Math.min(1, remaining / total)) : 0;
  return { fraction, expired: remaining <= 0, remainingMs: Math.max(0, remaining), expiresAtMs: expires };
}

/**
 * Pure layout. `action` is a DisplayAction (or null → blank idle). Options:
 *   width/height  logical LCD size (default 240×240)
 *   nowMs         wall clock for TTL math (default Date.now())
 *   measure       (text, sizePx, weight) → widthPx  (default approxMeasure)
 *   resolveClip   (clipId) → {url, poster_url?} | null  — a clip region is reserved only when it returns a url
 */
export function layoutCard(action, { width = 240, height = 240, nowMs, measure = approxMeasure, resolveClip = () => null } = {}) {
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  const card = action?.card ?? { template: 'idle', title: '', body: '' };
  const template = String(card.template ?? 'idle');
  const title = String(card.title ?? '');
  const body = String(card.body ?? '');
  const ttl = ttlOf(action, now);
  const barH = ttl ? TTL_BAR_H : 0;
  const innerW = width - PADDING * 2;
  const regions = [];
  const lines = [];
  let reminder = null;
  let clipRegion = null;
  let contentBottom = height - PADDING - barH;
  let clipInfo = null;
  if (card.clip_id) {
    try { clipInfo = resolveClip(card.clip_id) ?? null; } catch { clipInfo = null; }
    if (clipInfo && !clipInfo.url) clipInfo = null;
  }

  const push = (role, texts, { size, weight, color, x = PADDING, y, align = 'left' }) => {
    let yy = y;
    for (const text of texts) { lines.push({ role, text, x, y: yy, size, weight, color, align }); yy += lh(size); }
    return yy;
  };
  const block = (role, text, size, weight, color, y, maxLines, maxWidth = innerW) => {
    const fitting = Math.floor((contentBottom - y) / lh(size));
    const wrapped = fitLines(wrapText(text, size, weight, maxWidth, measure), Math.min(maxLines, fitting), size, weight, maxWidth, measure);
    return wrapped.length ? push(role, wrapped, { size, weight, color, y }) : y;
  };

  let describe;
  switch (template) {
    case 'idle': {
      const tSize = 48, bSize = 13;
      const blockH = lh(tSize) + (body ? GAP + lh(bSize) : 0);
      const top = PADDING + Math.max(0, (contentBottom - PADDING - blockH) / 2);
      const t = ellipsize(title, tSize, WEIGHT.bold, innerW, measure);
      let y = push('title', [t], { size: tSize, weight: WEIGHT.bold, color: PALETTE.fg, x: width / 2, y: top, align: 'center' });
      if (body) push('body', [ellipsize(flat(body), bSize, WEIGHT.normal, innerW, measure)], { size: bSize, weight: WEIGHT.normal, color: PALETTE.muted, x: width / 2, y: y + GAP, align: 'center' });
      describe = `Idle: ${flat(title) || '--:--'}${body ? `, ${flat(body)}` : ''}`;
      break;
    }
    case 'answer': {
      if (clipInfo) {
        clipRegion = { x: 0, y: Math.floor(height / 2), w: width, h: height - Math.floor(height / 2) };
        contentBottom = clipRegion.y - GAP;
      }
      let y = PADDING;
      y = block('title', title, 13, WEIGHT.normal, PALETTE.muted, y, 2);
      if (y > PADDING) y += GAP;
      block('body', body, 18, WEIGHT.semibold, PALETTE.fg, y, Infinity);
      describe = `Answer: ${sentence(body)}${title ? ` Question: ${sentence(title)}` : ''}${clipRegion ? ' Clip attached.' : ''}`;
      break;
    }
    case 'enroll_prompt':
    case 'alert': {
      const color = template === 'alert' ? PALETTE.warn : PALETTE.accent;
      regions.push({ kind: 'border', x: 2, y: 2, w: width - 4, h: height - 4, stroke: color, lineWidth: 2 });
      let y = PADDING;
      y = block('title', title, 20, WEIGHT.bold, PALETTE.fg, y, 2);
      if (y > PADDING) y += GAP;
      block('body', body, 14, WEIGHT.normal, PALETTE.fg, y, Infinity);
      describe = `${template === 'alert' ? 'Alert' : 'Prompt'}: ${sentence(title)}${body ? ` ${sentence(body)}` : ''}`;
      break;
    }
    case 'profile':
    default: {
      let y = PADDING;
      const r = card.reminder;
      if (r && r.text) {
        const rSize = 13, barW = 4, padY = 7;
        const rLines = fitLines(wrapText(r.text, rSize, WEIGHT.normal, innerW, measure), 2, rSize, WEIGHT.normal, innerW, measure);
        const stripH = padY * 2 + rLines.length * lh(rSize);
        regions.push({ kind: 'reminder_strip', x: 0, y: 0, w: width, h: stripH, fill: PALETTE.accentSoft });
        regions.push({ kind: 'reminder_bar', x: 0, y: 0, w: barW, h: stripH, fill: PALETTE.accent });
        const rl = [];
        let yy = padY;
        for (const text of rLines) { rl.push({ role: 'reminder', text, x: PADDING, y: yy, size: rSize, weight: WEIGHT.normal, color: PALETTE.accent, align: 'left' }); yy += lh(rSize); }
        reminder = { id: r.id ?? null, text: String(r.text), lines: rl, height: stripH };
        y = stripH + 8;
      }
      y = block('title', title, 22, WEIGHT.bold, PALETTE.fg, y, 2);
      if (lines.length) y += GAP;
      block('body', body, 14, WEIGHT.normal, PALETTE.fg, y, Infinity);
      const label = template === 'profile' ? 'Profile' : template.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
      describe = `${reminder ? `Reminder: ${sentence(reminder.text)} ` : ''}${label}: ${sentence(title)}${body ? ` ${sentence(body)}` : ''}`;
      break;
    }
  }

  if (ttl) {
    regions.push({ kind: 'ttl_track', x: 0, y: height - TTL_BAR_H, w: width, h: TTL_BAR_H, fill: PALETTE.line });
    regions.push({ kind: 'ttl_bar', x: 0, y: height - TTL_BAR_H, w: Math.round(width * ttl.fraction), h: TTL_BAR_H, fill: PALETTE.accent });
  }

  return { template, width, height, padding: PADDING, contentBottom, regions, lines, reminder, clipRegion, clip: clipInfo, ttl, describe: describe.trim() };
}

function localIdleAction(nowMs, width, height, body = 'Ready') {
  return {
    schema_version: '1.0', id: `display_local_${nowMs}`, display: { w: width, h: height },
    card: { template: 'idle', title: clockText(nowMs), body, image_ref: null, reminder: null },
    blit: null, ttl_ms: 0, priority: 0, issued_at: new Date(nowMs).toISOString(), expires_at: null, local: true,
  };
}

/**
 * Runtime renderer bound to a <canvas>. See the module header for the contract.
 */
export function createDeviceDisplay(canvas, {
  width = 240, height = 240, now = () => Date.now(), resolveClip = () => null,
  clock = { setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms), clearTimeout: (id) => globalThis.clearTimeout(id) },
  createVideo = () => globalThis.document.createElement('video'),
} = {}) {
  const ctx = canvas.getContext('2d');
  const listeners = new Set();
  let current = null;
  let layout = null;
  let lastDescribe = null;
  let destroyed = false;
  let ttlTimer = null;
  let tickTimer = null;
  let clipTimer = null;
  let clipInfo = null;
  let video = null;
  let poster = null;
  let posterReady = false;

  const measure = (text, size, weight) => {
    ctx.font = `${weight} ${size}px ${FONT_FAMILY}`;
    const m = ctx.measureText(text);
    return m && Number.isFinite(m.width) ? m.width : approxMeasure(text, size, weight);
  };

  function drawRegion(r) {
    if (r.fill) { ctx.fillStyle = r.fill; ctx.fillRect(r.x, r.y, r.w, r.h); }
    if (r.stroke) {
      const lw = r.lineWidth ?? 1;
      ctx.fillStyle = r.stroke;
      ctx.fillRect(r.x, r.y, r.w, lw);
      ctx.fillRect(r.x, r.y + r.h - lw, r.w, lw);
      ctx.fillRect(r.x, r.y, lw, r.h);
      ctx.fillRect(r.x + r.w - lw, r.y, lw, r.h);
    }
  }
  function drawLine(l) {
    ctx.font = `${l.weight} ${l.size}px ${FONT_FAMILY}`;
    ctx.fillStyle = l.color;
    ctx.textBaseline = 'top';
    ctx.textAlign = l.align === 'center' ? 'center' : 'left';
    ctx.fillText(l.text, l.x, l.y);
  }
  function drawClip(rg) {
    ctx.fillStyle = PALETTE.fg;
    ctx.fillRect(rg.x, rg.y, rg.w, rg.h);
    ctx.fillStyle = PALETTE.line;
    ctx.fillRect(rg.x, rg.y, rg.w, 1);
    const ready = !!video && (video.readyState ?? 0) >= 2;
    const src = ready ? video : (poster && posterReady ? poster : null);
    if (src) {
      const sw = (ready ? video.videoWidth : poster.naturalWidth) || rg.w;
      const sh = (ready ? video.videoHeight : poster.naturalHeight) || rg.h;
      const s = Math.min(rg.w / sw, rg.h / sh);
      const dw = Math.max(1, Math.round(sw * s)), dh = Math.max(1, Math.round(sh * s));
      ctx.drawImage(src, rg.x + Math.round((rg.w - dw) / 2), rg.y + Math.round((rg.h - dh) / 2), dw, dh);
    } else {
      drawLine({ text: 'Loading clip…', x: rg.x + rg.w / 2, y: rg.y + rg.h / 2 - 7, size: 12, weight: WEIGHT.normal, color: PALETTE.line, align: 'center' });
    }
  }

  function paint() {
    if (destroyed || !current) return;
    const dpr = globalThis.devicePixelRatio || 1;
    if (canvas.width !== width * dpr) canvas.width = width * dpr;
    if (canvas.height !== height * dpr) canvas.height = height * dpr;
    if (canvas.style) { canvas.style.width = `${width}px`; canvas.style.height = `${height}px`; }
    layout = layoutCard(current, { width, height, nowMs: now(), measure, resolveClip: () => clipInfo });
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.scale(dpr, dpr);
    ctx.fillStyle = PALETTE.bg;
    ctx.fillRect(0, 0, width, height);
    ctx.fillStyle = PALETTE.line; // 1 px border
    ctx.fillRect(0, 0, width, 1); ctx.fillRect(0, height - 1, width, 1); ctx.fillRect(0, 0, 1, height); ctx.fillRect(width - 1, 0, 1, height);
    const top = [];
    for (const r of layout.regions) { if (r.kind.startsWith('ttl_')) top.push(r); else drawRegion(r); }
    if (layout.clipRegion) drawClip(layout.clipRegion);
    for (const l of layout.reminder?.lines ?? []) drawLine(l);
    for (const l of layout.lines) drawLine(l);
    for (const r of top) drawRegion(r);
    canvas.setAttribute?.('role', 'img');
    canvas.setAttribute?.('aria-label', layout.describe);
    if (layout.describe !== lastDescribe) {
      lastDescribe = layout.describe;
      for (const fn of listeners) { try { fn(layout.describe); } catch (e) { console.warn('lcd onChange listener failed', e); } }
    }
  }

  // ---- clip playback (≤10 fps, one hidden <video>) ----
  function stopClip() {
    if (clipTimer != null) { clock.clearTimeout(clipTimer); clipTimer = null; }
    if (video) {
      try { video.pause?.(); } catch { /* ignore */ }
      try { video.removeAttribute?.('src'); } catch { /* ignore */ }
      if ('src' in video && video.src) { try { video.src = ''; } catch { /* ignore */ } }
      try { video.load?.(); } catch { /* ignore */ }
      video = null;
    }
    poster = null; posterReady = false; clipInfo = null;
  }
  function clipFrame() {
    clipTimer = null;
    if (destroyed || !video) return;
    paint();
    if (video.ended) { ensureTicker(); return; } // last frame stays; TTL bar falls back to the 1 s ticker
    clipTimer = clock.setTimeout(clipFrame, CLIP_FPS_INTERVAL_MS);
  }
  function startClip(info) {
    clipInfo = info;
    if (info.poster_url && typeof globalThis.Image === 'function') {
      poster = new globalThis.Image();
      poster.onload = () => { posterReady = true; if (!destroyed && poster) paint(); };
      poster.src = info.poster_url;
    }
    try {
      video = createVideo();
      video.muted = true; video.playsInline = true; video.loop = false; video.preload = 'auto';
      video.setAttribute?.('muted', ''); video.setAttribute?.('playsinline', '');
      video.src = info.url;
      const p = video.play?.();
      if (p && typeof p.catch === 'function') p.catch(() => { /* autoplay refusal: poster/loading text stays */ });
    } catch (e) { console.warn('lcd: clip video unavailable', e); video = null; return; }
    clipTimer = clock.setTimeout(clipFrame, CLIP_FPS_INTERVAL_MS);
  }

  // ---- 1 s ticker while a TTL bar or idle clock is showing (skipped while the clip loop repaints) ----
  function ensureTicker() {
    const wants = !destroyed && !!current && clipTimer == null && (!!current.expires_at || current.card?.template === 'idle');
    if (wants && tickTimer == null) tickTimer = clock.setTimeout(onTick, 1000);
    else if (!wants && tickTimer != null) { clock.clearTimeout(tickTimer); tickTimer = null; }
  }
  function onTick() { tickTimer = null; tick(); }

  function clearTtl() { if (ttlTimer != null) { clock.clearTimeout(ttlTimer); ttlTimer = null; } }
  function armTtl(action) {
    clearTtl();
    if (!action.expires_at) return;
    const expires = Date.parse(action.expires_at);
    if (!Number.isFinite(expires)) return;
    ttlTimer = clock.setTimeout(() => {
      ttlTimer = null;
      if (destroyed || current !== action) return; // a newer action superseded this one
      showLocalIdle();
    }, Math.max(0, expires - now()));
  }
  function showLocalIdle(body = 'Ready') { show(localIdleAction(now(), width, height, body)); }

  function show(action) {
    if (destroyed || !action) return;
    stopClip();
    clearTtl();
    current = action;
    const clipId = action.card?.clip_id;
    if (clipId) {
      let info = null;
      try { info = resolveClip(clipId) ?? null; } catch { info = null; }
      if (info && info.url) startClip(info);
    }
    paint();
    armTtl(action);
    ensureTicker();
  }
  function tick() {
    if (destroyed || !current) return;
    if (current.local && current.card?.template === 'idle') current.card.title = clockText(now());
    paint();
    ensureTicker();
  }
  function destroy() {
    if (destroyed) return;
    stopClip();
    clearTtl();
    if (tickTimer != null) { clock.clearTimeout(tickTimer); tickTimer = null; }
    destroyed = true;
    listeners.clear();
    current = null; layout = null;
    canvas.removeAttribute?.('aria-label');
  }

  return {
    show,
    clear() { showLocalIdle(); },
    destroy,
    current() { return current; },
    describe() { return layout?.describe ?? ''; },
    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    tick,
  };
}
