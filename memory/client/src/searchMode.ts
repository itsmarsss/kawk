// Memory search request assembly. Keyword is the default (the user chose history grep on 2026-09-20);
// semantic stays available as an explicit option. The result shape is unchanged either way.
export type SearchMode = 'keyword' | 'semantic';
export const SEARCH_MODE_OPTIONS: { value: SearchMode; label: string }[] = [
  { value: 'keyword', label: 'Keyword (default)' },
  { value: 'semantic', label: 'Semantic (embeddings)' },
];
export function normalizeSearchMode(v: unknown): SearchMode { return v === 'semantic' ? 'semantic' : 'keyword'; }

export interface SearchFields { query: string; mode: unknown; entityId: string; from: string; to: string; limit: string }
export interface SearchBody { query: string; mode: SearchMode; entityId?: string; from?: number; to?: number; limit?: number }
/** Returns null when the query is blank. Invalid dates/limits are omitted rather than sent as NaN. */
export function buildSearchBody(f: SearchFields): SearchBody | null {
  const query = f.query.trim();
  if (!query) return null;
  const body: SearchBody = { query, mode: normalizeSearchMode(f.mode) };
  if (f.entityId) body.entityId = f.entityId;
  const from = f.from ? Date.parse(f.from) : Number.NaN;
  const to = f.to ? Date.parse(f.to) : Number.NaN;
  if (Number.isFinite(from)) body.from = from;
  if (Number.isFinite(to)) body.to = to;
  const limit = Number(f.limit);
  if (Number.isFinite(limit) && limit > 0) body.limit = Math.min(50, Math.round(limit));
  return body;
}
export function searchResultNote(mode: SearchMode, count: number, elapsedMs: number): string {
  const ms = `${Math.round(elapsedMs)} ms`;
  return mode === 'semantic'
    ? `${count} result(s) in ${ms} · semantic mode · distance shown; lower is closer`
    : `${count} result(s) in ${ms} · keyword mode · exact-term matches over stored observations`;
}
/** Per-row score label: distance is only meaningful for semantic results. */
export function scoreLabel(mode: SearchMode, distance: unknown): string {
  return mode === 'semantic' && typeof distance === 'number' && Number.isFinite(distance) ? `distance ${distance.toFixed(3)}` : 'keyword match';
}
