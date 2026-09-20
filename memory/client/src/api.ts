// Thin HTTP layer for the memory service on the same origin. GET-only helpers are safe on page load;
// POST helpers are called only from explicit user actions or a running session.
import type { CaptureInput, Transcript } from './types.ts';

export interface ClientConfig { captureIntervalMs: number; transcriptWords: number; perceptionUrl?: string; provider?: string; model?: string; writerModel?: string; speechBackend?: string; speechNotice?: string }
export interface SessionInfo { id: string; startedAt: number }
export interface HttpResult { ok: boolean; status: number; text: string }

// Every request is bounded: a stalled endpoint must never hold a capture/revision slot or block Stop.
export const TIMEOUTS = { get: 8000, capture: 15000, transcript: 8000, search: 20000, session: 8000, delete: 15000 } as const;
export function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(new Error(`timeout after ${timeoutMs} ms`)), timeoutMs);
  return fetch(url, { ...init, signal: ctl.signal }).finally(() => clearTimeout(timer));
}
async function getJson<T>(url: string): Promise<T> {
  const res = await fetchWithTimeout(url, { headers: { accept: 'application/json' } }, TIMEOUTS.get);
  if (!res.ok) throw new Error(`GET ${url} → HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return (await res.json()) as T;
}
async function postJson<T>(url: string, body: unknown, timeoutMs: number): Promise<T> {
  const res = await fetchWithTimeout(url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(body) }, timeoutMs);
  if (!res.ok) throw new Error(`POST ${url} → HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return (await res.json()) as T;
}
async function deleteJson<T>(url: string, timeoutMs: number): Promise<T> {
  const res = await fetchWithTimeout(url, { method: 'DELETE', headers: { accept: 'application/json' } }, timeoutMs);
  if (!res.ok) throw new Error(`DELETE ${url} → HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return (await res.json()) as T;
}
async function postRaw(url: string, body: unknown, timeoutMs: number): Promise<HttpResult> {
  const res = await fetchWithTimeout(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, timeoutMs);
  const text = await res.text();
  return { ok: res.ok, status: res.status, text: res.ok ? text.slice(0, 500) : text };
}

export const api = {
  config: () => getJson<ClientConfig>('/api/config'),
  dashboard: () => getJson<Dashboard>('/api/dashboard'),
  packet: (id: string) => getJson<Packet>(`/api/packets/${encodeURIComponent(id)}`),
  packetHistory: (id: string) => getJson<Packet[] | { versions: Packet[] }>(`/api/packets/${encodeURIComponent(id)}/history`),
  entity: (id: string) => getJson<EntityDetail>(`/api/entities/${encodeURIComponent(id)}`),
  createSession: () => postJson<SessionInfo>('/api/sessions', {}, TIMEOUTS.session),
  search: (body: { query: string; mode?: 'keyword' | 'semantic'; entityId?: string; from?: number; to?: number; limit?: number }) => postJson<{ results: SearchHit[] }>('/api/search', body, TIMEOUTS.search),
  postCapture: (body: CaptureInput) => postRaw('/api/captures', body, TIMEOUTS.capture),
  postTranscript: (body: Transcript) => postRaw('/api/transcripts', body, TIMEOUTS.transcript),
  frameUrl: (captureId: string) => `/api/frames/${encodeURIComponent(captureId)}`,
  // People: provisional (in-memory) and enrolled (gallery) persons. Deletes are explicit user actions only.
  people: () => getJson<PeopleResponse>('/api/people'),
  deletePerson: (id: string) => deleteJson<{ deleted: boolean }>(`/api/people/${encodeURIComponent(id)}`, TIMEOUTS.delete),
  deleteAllPeople: () => deleteJson<{ deleted: boolean; count: number }>('/api/people', TIMEOUTS.delete),
};
export interface Person { id: string; name: string; enrolled: boolean; lastSeenAt: number | null }
export interface PeopleResponse { people: Person[]; resetBefore: number | null }

// ---- server shapes (mirrors of memory/src/contracts.ts; loosely typed where the API doc is vague) ----
export interface CurrentState { version: number; observedAt: number; location: string | null; activity: string | null; summary: string; uncertainties: string[]; packetId: string | null }
export interface Entity { id: string; kind: string; label: string; description: string; personId: string | null; createdAt: number; lastSeenAt: number; attributes: Record<string, { value: string; observedAt: number; observationId: string }> }
export interface Observation { id: string; packetId: string; packetVersion: number; entityIds: string[]; candidateEntityIds?: string[]; text: string; observedAt: number; endAt: number; confidence: string; visual: boolean; transcriptKeys: string[]; superseded: boolean }
export interface SearchHit extends Observation { distance: number }
export interface CaptureRecord { id: string; sessionId: string; sequence: number; capturedAt: number; width: number; height: number; receivedAt: number; status: string; error: string | null; faces?: { status: string; faces: { name: string | null; identityStatus: string }[] }; vision?: { scene: string; observations: string[]; readableText: string[]; uncertainties: string[] } | null }
export interface Packet { id: string; version: number; sessionId: string; sequence: number; capturedAt: number; faces: { status: string; streamId: string; faces: { trackId: string; personId: string | null; name: string | null; identityStatus: string; box: number[] }[] }; audio: { text: string; wordCount: number; status: string; throughAt: number; segments: { streamId: string; segmentId: string; revision: number; isFinal: boolean; text: string }[] }; vision: { scene: string; observations: string[]; readableText: string[]; uncertainties: string[] }; createdAt: number; correction: boolean }
export interface Dashboard {
  state?: CurrentState | null; entities?: Entity[]; observations?: Observation[]; events?: unknown[]; encounters?: unknown[];
  captures?: CaptureRecord[]; stats?: Record<string, unknown>;
  pipeline?: { running?: boolean; queue?: number; observing?: number | string[]; reducing?: string | number | null; indexing?: boolean | number; lastError?: string | null; latencies?: { id?: string; stage: string; ms: number; at?: number }[] | Record<string, number> };
}
export interface EntityDetail { entity: Entity; observations: Observation[]; encounters: unknown[]; events: unknown[] }

// ---- agent bridge (same-origin; no tokens in the browser). Bounded timeouts; the command poll is short so a
// stalled endpoint cannot hold the single in-flight slot for long. ----
export const AGENT_TIMEOUTS = { status: 5000, ask: 15000, list: 8000, ack: 8000, cancel: 8000, commands: 3000, claim: 5000, result: 8000 } as const;
export interface AgentStatus { connected: boolean; bridge?: { pending?: number; lastError?: string | null }; agent?: { running?: boolean; activeTurns?: number; lastError?: string | null } }
export interface AgentNotificationRaw { id: string; taskId?: string | null; text: string; createdAt?: number; refs?: unknown; [k: string]: unknown }
export interface AgentTask { id: string; status: string; goal?: string | null; result?: unknown; createdAt?: number; updatedAt?: number; [k: string]: unknown }
export interface AgentCommandRaw { id: string; type: string; reason?: string | null; createdAt?: number; expiresAt?: number }
export const agentApi = {
  status: () => getJsonTimeout<AgentStatus>('/api/agent/status', AGENT_TIMEOUTS.status),
  ask: (body: { text: string; sessionId?: string }) => postJson<{ eventId: string }>('/api/agent/ask', body, AGENT_TIMEOUTS.ask),
  notifications: () => getJsonTimeout<{ notifications: AgentNotificationRaw[] }>('/api/agent/notifications', AGENT_TIMEOUTS.list),
  ack: (id: string) => postJson<{ acked: boolean }>(`/api/agent/notifications/${encodeURIComponent(id)}/ack`, {}, AGENT_TIMEOUTS.ack),
  tasks: () => getJsonTimeout<{ tasks: AgentTask[] }>('/api/agent/tasks', AGENT_TIMEOUTS.list),
  cancelTask: (id: string) => postJson<unknown>(`/api/agent/tasks/${encodeURIComponent(id)}/cancel`, {}, AGENT_TIMEOUTS.cancel),
  commands: (sessionId: string) => getJsonTimeout<{ commands: AgentCommandRaw[] }>(`/api/agent/commands?${new URLSearchParams({ sessionId }).toString()}`, AGENT_TIMEOUTS.commands),
  claim: (id: string, sessionId: string) => postJson<{ claimed: boolean }>(`/api/agent/commands/${encodeURIComponent(id)}/claim`, { sessionId }, AGENT_TIMEOUTS.claim),
  result: (id: string, body: { sessionId: string; captureId?: string; error?: string }) => postJson<unknown>(`/api/agent/commands/${encodeURIComponent(id)}/result`, body, AGENT_TIMEOUTS.result),
  eventsUrl: '/api/agent/events',
};
async function getJsonTimeout<T>(url: string, timeoutMs: number): Promise<T> {
  const res = await fetchWithTimeout(url, { headers: { accept: 'application/json' } }, timeoutMs);
  if (!res.ok) throw new Error(`GET ${url} → HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return (await res.json()) as T;
}
