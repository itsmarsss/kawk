// Memory browser: pure logic for the Memory view (GET /api/memory/browse and GET /api/agent/memory/browse).
//   - one Apply = one generation; a page that arrives for an older generation is dropped (stale async), so a slow
//     "keys" result can never overwrite the "bowl" list the user asked for afterwards;
//   - "all" fans out to every kind in parallel; each kind keeps its own cursor and total, so Load more extends every
//     kind that still has a cursor; the merged list is newest source time first across what has loaded so far;
//   - responses are validated leniently: an item without id/kind/at is dropped and counted, never rendered as garbage;
//   - reads only: nothing here records, deletes, notifies or asks for a permission.

export const MEMORY_KINDS = ['observations', 'captures', 'transcripts', 'entities', 'state'] as const;
export const AGENT_KINDS = ['facts', 'reminders'] as const;
export type BrowseKind = typeof MEMORY_KINDS[number] | typeof AGENT_KINDS[number];
export type BrowseCategory = 'all' | BrowseKind;
export const ALL_KINDS: readonly BrowseKind[] = [...MEMORY_KINDS, ...AGENT_KINDS];
export const ENTITY_KINDS = ['person', 'object', 'place', 'event'] as const;
export const MAX_LIMIT = 40;

export const CATEGORY_OPTIONS: readonly { value: BrowseCategory; label: string; hint: string }[] = [
  { value: 'all', label: 'All', hint: 'every category, newest source time first (each category loads its own pages)' },
  { value: 'observations', label: 'Observations', hint: 'current supported facts derived from photos and speech' },
  { value: 'captures', label: 'Photos', hint: 'retained raw frames: 5 s cadence and agent-requested captures' },
  { value: 'transcripts', label: 'Speech', hint: 'latest transcript revision per segment, across all sessions' },
  { value: 'entities', label: 'Entities', hint: 'active people, objects, places and events' },
  { value: 'state', label: 'State', hint: 'current-state timeline: location, activity, summary' },
  { value: 'facts', label: 'Agent facts', hint: 'agent graph entities, relations and summaries with their sources' },
  { value: 'reminders', label: 'Reminders', hint: 'reminders in every state (pending, fired, cancelled…)' },
];
export const KIND_LABEL: Record<BrowseKind, string> = { observations: 'Observation', captures: 'Photo', transcripts: 'Speech', entities: 'Entity', state: 'State', facts: 'Agent fact', reminders: 'Reminder' };

export interface BrowseFilter { category: BrowseCategory; query: string; from: number | null; to: number | null; history: boolean; entityKind: string | null; limit: number }
export const DEFAULT_FILTER: BrowseFilter = { category: 'all', query: '', from: null, to: null, history: false, entityKind: null, limit: MAX_LIMIT };

export interface BrowseItem { id: string; kind: BrowseKind; at: number; title: string; text: string; status: string | null; captureId: string | null; entityId: string | null; data: Record<string, unknown> }
export interface BrowsePage { kind: BrowseKind; items: BrowseItem[]; nextCursor: string | null; total: number | null }

export function normalizeCategory(v: unknown): BrowseCategory {
  return typeof v === 'string' && (v === 'all' || (ALL_KINDS as readonly string[]).includes(v)) ? (v as BrowseCategory) : 'all';
}
export function isBrowseKind(v: unknown): v is BrowseKind { return typeof v === 'string' && (ALL_KINDS as readonly string[]).includes(v); }
export function kindsFor(category: BrowseCategory): BrowseKind[] { return category === 'all' ? [...ALL_KINDS] : [category]; }

/** Form values → filter. Dates are `datetime-local` strings (local time); unparsable values are omitted, an inverted range is swapped. */
export function filterFromForm(input: { category: string; query: string; from: string; to: string; history: boolean; entityKind: string; limit?: number | string }): BrowseFilter {
  const parse = (s: string): number | null => { const t = s.trim() ? Date.parse(s.trim()) : NaN; return Number.isFinite(t) ? t : null; };
  let from = parse(input.from); let to = parse(input.to);
  if (from !== null && to !== null && from > to) [from, to] = [to, from];
  const category = normalizeCategory(input.category);
  const limit = Math.min(MAX_LIMIT, Math.max(1, Math.floor(Number(input.limit) || MAX_LIMIT)));
  const entityKind = category === 'entities' && (ENTITY_KINDS as readonly string[]).includes(input.entityKind) ? input.entityKind : null;
  return { category, query: input.query.trim().slice(0, 500), from, to, history: input.history === true, entityKind, limit };
}

export function browseUrl(kind: BrowseKind, f: BrowseFilter, cursor: string | null = null): string {
  const q = new URLSearchParams({ kind, limit: String(f.limit), history: f.history ? 'true' : 'false' });
  if (f.query) q.set('query', f.query);
  if (f.from !== null) q.set('from', String(f.from));
  if (f.to !== null) q.set('to', String(f.to));
  if (kind === 'entities' && f.entityKind) q.set('entityKind', f.entityKind);
  if (cursor) q.set('cursor', cursor);
  const base = (AGENT_KINDS as readonly string[]).includes(kind) ? '/api/agent/memory/browse' : '/api/memory/browse';
  return `${base}?${q.toString()}`;
}

/** Lenient page parser: bad items are dropped and counted; the page shape itself must be an object with an array. */
export function parseBrowsePage(raw: unknown, kind: BrowseKind): { page: BrowsePage; dropped: number } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('browse response is not an object');
  const o = raw as Record<string, unknown>;
  if (!Array.isArray(o.items)) throw new Error('browse response has no items array');
  let dropped = 0;
  const items: BrowseItem[] = [];
  for (const x of o.items) {
    const it = parseBrowseItem(x, kind);
    if (it) items.push(it); else dropped += 1;
  }
  const total = typeof o.total === 'number' && Number.isFinite(o.total) && o.total >= 0 ? Math.floor(o.total) : null;
  const nextCursor = typeof o.nextCursor === 'string' && o.nextCursor ? o.nextCursor : null;
  return { page: { kind, items, nextCursor, total }, dropped };
}
export function parseBrowseItem(x: unknown, fallbackKind: BrowseKind): BrowseItem | null {
  if (!x || typeof x !== 'object') return null;
  const o = x as Record<string, unknown>;
  const id = typeof o.id === 'string' && o.id ? o.id : typeof o.id === 'number' ? String(o.id) : null;
  const at = typeof o.at === 'number' && Number.isFinite(o.at) ? o.at : null;
  if (id === null || at === null) return null;
  const kind = isBrowseKind(o.kind) ? o.kind : fallbackKind;
  const str = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : '');
  return {
    id, kind, at, title: str(o.title, 300), text: str(o.text, 8000),
    status: typeof o.status === 'string' && o.status ? o.status.slice(0, 80) : null,
    captureId: typeof o.captureId === 'string' && o.captureId ? o.captureId : null,
    entityId: typeof o.entityId === 'string' && o.entityId ? o.entityId : null,
    data: o.data && typeof o.data === 'object' && !Array.isArray(o.data) ? (o.data as Record<string, unknown>) : {},
  };
}

/** Newest source time first; ties by kind then id. Duplicates (same kind+id) keep the first occurrence. */
export function mergeItems(lists: BrowseItem[][]): BrowseItem[] {
  const seen = new Set<string>(); const out: BrowseItem[] = [];
  for (const list of lists) for (const it of list) { const k = `${it.kind}:${it.id}`; if (seen.has(k)) continue; seen.add(k); out.push(it); }
  return out.sort((a, b) => b.at - a.at || a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id));
}

// ---- status honesty ------------------------------------------------------------------------------------------
export type Tone = '' | 'ok' | 'warn' | 'bad' | 'muted';
const STATUS_TONES: [RegExp, Tone][] = [
  [/superseded|replaced|stale|revised|hidden|removed|deleted|cancel/i, 'muted'],
  [/candidate|possible|unconfirmed|provisional|partial|pending|queued|observing|reducing|ready|due|snoozed|scheduled/i, 'warn'],
  [/fail|error|expired|rejected/i, 'bad'],
  [/committed|final|active|current|confirmed|enrolled|fired|done|delivered|supported/i, 'ok'],
];
/** The status the server sent, unchanged, plus a tone. Superseded/candidate flags in `data` are surfaced even when `status` is null. */
export function describeStatus(item: BrowseItem): { label: string; tone: Tone } {
  const d = item.data;
  const flags: string[] = [];
  if (item.status) flags.push(item.status);
  if (d.superseded === true && !/supersed/i.test(item.status ?? '')) flags.push('superseded');
  if (Array.isArray(d.candidateEntityIds) && d.candidateEntityIds.length && !/candidate/i.test(item.status ?? '')) flags.push('possible match — identity unconfirmed');
  if (d.isFinal === false && !/partial/i.test(item.status ?? '')) flags.push('partial');
  const label = flags.join(' · ');
  let tone: Tone = '';
  for (const [re, t] of STATUS_TONES) if (re.test(label)) { tone = t; break; }
  return { label, tone };
}
/** Whether the item is a superseded/older version (rendered struck-through and only when history is on). */
export function isSuperseded(item: BrowseItem): boolean {
  return item.data.superseded === true || /superseded|replaced/i.test(item.status ?? '');
}
/** Which clock the `at` value comes from, for the card label. */
export function timeLabel(kind: BrowseKind): string { return kind === 'facts' || kind === 'reminders' ? 'recorded' : 'source time'; }

// ---- readable details (no giant raw JSON by default) -----------------------------------------------------------
export interface Fact { label: string; text?: string; time?: number; href?: string; list?: string[] }
const TIME_KEY = /(At|Time|Start|End|Due|Until|Since)$|^(at|from|to|due|when|start|end)$/;
const SKIP_KEYS = new Set(['id', 'kind', 'title', 'text', 'at']);
const HUMAN: Record<string, string> = {
  observedAt: 'observed', endAt: 'until', receivedAt: 'received', capturedAt: 'captured', createdAt: 'created', updatedAt: 'updated', lastSeenAt: 'last seen', dueAt: 'due', firedAt: 'fired', cancelledAt: 'cancelled',
  packetId: 'packet', packetVersion: 'packet version', entityIds: 'entities', candidateEntityIds: 'possible (unconfirmed) entities', transcriptKeys: 'transcript keys', confidence: 'confidence', visual: 'seen (visual)',
  superseded: 'superseded', revision: 'revision', isFinal: 'final', sessionId: 'session', streamId: 'stream', segmentId: 'segment', sourceStart: 'source start', sourceEnd: 'source end', sequence: 'sequence',
  width: 'width', height: 'height', status: 'status', key: 'key', refs: 'refs', personId: 'gallery id', label: 'label', description: 'description', location: 'location', activity: 'activity', summary: 'summary', uncertainties: 'uncertainties',
};
const isTimestamp = (k: string, v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 1e11 && v < 1e13 && TIME_KEY.test(k);
/**
 * Flattens `data` into labelled facts: scalars as text, timestamps as times, string arrays as lists, objects as a count.
 * Known keys get plain-language labels. Bounded (`max`) so a huge blob cannot flood a card; the raw JSON stays behind a toggle.
 */
export function itemFacts(item: BrowseItem, max = 24): Fact[] {
  const out: Fact[] = [];
  const d = item.data;
  const push = (f: Fact) => { if (out.length < max) out.push(f); };
  // Sources of an agent fact: [{eventId, revision, text, sourceStart, sourceEnd}] → one list entry each.
  if (Array.isArray(d.sources) && d.sources.length) {
    push({ label: `sources (${d.sources.length})`, list: d.sources.slice(0, 12).map((s) => {
      const o = (s && typeof s === 'object' ? s : {}) as Record<string, unknown>;
      const ev = typeof o.eventId === 'string' ? `event ${o.eventId}` : 'event ?';
      const rev = typeof o.revision === 'number' ? ` r${o.revision}` : '';
      const span = typeof o.sourceStart === 'number' ? ` · ${new Date(o.sourceStart).toISOString().slice(11, 19)}${typeof o.sourceEnd === 'number' ? `–${new Date(o.sourceEnd).toISOString().slice(11, 19)}` : ''} UTC` : '';
      const text = typeof o.text === 'string' && o.text ? `: “${o.text.slice(0, 240)}”` : '';
      return `${ev}${rev}${span}${text}`;
    }) });
  }
  for (const [k, v] of Object.entries(d)) {
    if (SKIP_KEYS.has(k) || k === 'sources' || v === null || v === undefined) continue;
    const label = HUMAN[k] ?? k.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
    if (isTimestamp(k, v)) push({ label, time: v });
    else if (typeof v === 'string') { if (v) push({ label, text: v.length > 600 ? `${v.slice(0, 600)}… (truncated: ${v.length} characters; full value in raw data)` : v }); }
    else if (typeof v === 'number' || typeof v === 'boolean') push({ label, text: String(v) });
    else if (Array.isArray(v)) {
      if (!v.length) continue;
      if (v.every((x) => typeof x === 'string' || typeof x === 'number')) push({ label, list: v.slice(0, 20).map(String) });
      else push({ label, text: `${v.length} item(s) — see raw data` });
    } else if (typeof v === 'object') {
      const keys = Object.keys(v as object);
      const scalars = Object.entries(v as Record<string, unknown>).filter(([, x]) => typeof x === 'string' || typeof x === 'number' || typeof x === 'boolean').slice(0, 6);
      push({ label, text: scalars.length ? scalars.map(([a, b]) => `${a} = ${String(b)}`).join(' · ') + (keys.length > scalars.length ? ` · (+${keys.length - scalars.length} more, see raw data)` : '') : `${keys.length} field(s) — see raw data` });
    }
  }
  return out;
}

// ---- controller ----------------------------------------------------------------------------------------------
export interface KindState { kind: BrowseKind; items: BrowseItem[]; nextCursor: string | null; total: number | null; loading: boolean; error: string | null; pages: number; dropped: number }
export interface BrowseState {
  generation: number; filter: BrowseFilter; kinds: KindState[]; items: BrowseItem[];
  loading: boolean; hasMore: boolean; loaded: number; total: number | null; dropped: number; errors: { kind: BrowseKind; message: string }[];
  startedAt: number | null; finishedAt: number | null; stale: number; requests: number;
}
export interface BrowseDeps { fetchPage(url: string): Promise<unknown>; onState(s: BrowseState): void; now?: () => number }

export class BrowseController {
  private gen = 0;
  private filter: BrowseFilter = DEFAULT_FILTER;
  private kinds = new Map<BrowseKind, KindState>();
  private stale = 0; private requests = 0;
  private startedAt: number | null = null; private finishedAt: number | null = null;
  constructor(private readonly deps: BrowseDeps) {}
  private now(): number { return this.deps.now ? this.deps.now() : Date.now(); }

  get snapshot(): BrowseState {
    const kinds = [...this.kinds.values()].map((k) => ({ ...k, items: k.items.slice() }));
    const items = mergeItems(kinds.map((k) => k.items));
    const totals = kinds.map((k) => k.total);
    return {
      generation: this.gen, filter: this.filter, kinds, items,
      loading: kinds.some((k) => k.loading), hasMore: kinds.some((k) => k.nextCursor !== null && !k.error), loaded: items.length,
      total: totals.length && totals.every((t) => t !== null) ? totals.reduce<number>((a, b) => a + (b ?? 0), 0) : null,
      dropped: kinds.reduce((a, k) => a + k.dropped, 0), errors: kinds.filter((k) => k.error).map((k) => ({ kind: k.kind, message: k.error! })),
      startedAt: this.startedAt, finishedAt: this.finishedAt, stale: this.stale, requests: this.requests,
    };
  }
  private emit(): void { this.deps.onState(this.snapshot); }

  /** New filter → new generation: the list is cleared, every kind of the category is fetched in parallel. */
  load(filter: BrowseFilter): Promise<void> {
    this.gen += 1; this.filter = filter; this.kinds.clear();
    this.startedAt = this.now(); this.finishedAt = null;
    for (const kind of kindsFor(filter.category)) this.kinds.set(kind, { kind, items: [], nextCursor: null, total: null, loading: false, error: null, pages: 0, dropped: 0 });
    return this.fetchKinds([...this.kinds.keys()], null);
  }
  /** Next page for every kind that still has a cursor (and is not already loading). */
  loadMore(): Promise<void> {
    const due = [...this.kinds.values()].filter((k) => k.nextCursor !== null && !k.loading && !k.error).map((k) => k.kind);
    return this.fetchKinds(due, 'cursor');
  }
  /** Re-request the kinds that failed: their first page if nothing loaded, else the page after what loaded. */
  retry(): Promise<void> {
    const due = [...this.kinds.values()].filter((k) => k.error && !k.loading).map((k) => k.kind);
    for (const kind of due) { const k = this.kinds.get(kind)!; k.error = null; }
    return this.fetchKinds(due, 'cursor');
  }
  private async fetchKinds(kinds: BrowseKind[], mode: 'cursor' | null): Promise<void> {
    if (!kinds.length) { this.emit(); return; }
    const gen = this.gen;
    await Promise.all(kinds.map((kind) => this.fetchOne(gen, kind, mode)));
    if (gen === this.gen && ![...this.kinds.values()].some((k) => k.loading)) { this.finishedAt = this.now(); this.emit(); }
  }
  private async fetchOne(gen: number, kind: BrowseKind, mode: 'cursor' | null): Promise<void> {
    const k = this.kinds.get(kind);
    if (!k || k.loading) return;
    const cursor = mode === 'cursor' ? k.nextCursor : null;
    k.loading = true; this.requests += 1; this.emit();
    let raw: unknown;
    try { raw = await this.deps.fetchPage(browseUrl(kind, this.filter, cursor)); }
    catch (e) {
      if (gen !== this.gen) { this.stale += 1; this.emit(); return; } // an older filter's failure is irrelevant now
      k.loading = false; k.error = e instanceof Error ? e.message : String(e); this.emit(); return;
    }
    if (gen !== this.gen) { this.stale += 1; this.emit(); return; } // stale: the user applied another filter meanwhile
    k.loading = false;
    try {
      const { page, dropped } = parseBrowsePage(raw, kind);
      k.items = cursor ? mergeItems([k.items, page.items]) : page.items;
      k.nextCursor = page.nextCursor; k.total = page.total; k.pages += 1; k.dropped += dropped; k.error = null;
    } catch (e) { k.error = e instanceof Error ? e.message : String(e); }
    this.emit();
  }
}

/** One line for the note under the filter bar. */
export function describeBrowse(s: BrowseState, now: number): string {
  if (!s.kinds.length) return 'nothing loaded yet';
  const parts: string[] = [];
  if (s.loading) parts.push(s.loaded ? `loading more… ${s.loaded} shown` : 'loading…');
  else if (!s.loaded && !s.errors.length) parts.push('nothing matches this filter');
  else parts.push(`${s.loaded} shown${s.total !== null ? ` of ${s.total}` : ''}${s.hasMore ? ' · more available' : s.loaded ? ' · end of results' : ''}`);
  if (s.filter.category === 'all' && s.kinds.length > 1) parts.push(s.kinds.map((k) => `${KIND_LABEL[k.kind].toLowerCase()} ${k.items.length}${k.total !== null ? `/${k.total}` : ''}${k.error ? ' ✗' : k.nextCursor ? '+' : ''}`).join(', '));
  if (s.filter.query) parts.push(`text “${s.filter.query}” (literal)`);
  if (s.filter.from !== null || s.filter.to !== null) parts.push('date range on');
  if (s.filter.history) parts.push('history on (superseded / revisions included)');
  if (s.dropped) parts.push(`${s.dropped} unreadable item(s) skipped`);
  if (s.errors.length) parts.push(`${s.errors.length} category error(s): ${s.errors.map((e) => `${e.kind}: ${e.message}`).join('; ')}`);
  if (s.finishedAt !== null && !s.loading) parts.push(`refreshed ${Math.max(0, Math.round((now - s.finishedAt) / 1000))} s ago`);
  return parts.join(' · ');
}
