// Web Push for the merged page. Pure logic + injectable browser seams so the state machine runs in Node.
//   - support is classified honestly: secure context, service worker, PushManager, Notification, and the iOS
//     rule that push only exists for a web app added to the Home Screen;
//   - `prepare()` (page load / Retry) does every awaited step: agent key, ready registration, existing subscription,
//     key rotation, re-sync. `enable()` (the click) calls `pushManager.subscribe()` synchronously with the cached key —
//     Safari requires the subscribe call itself inside the user gesture, and the browser prompts for permission there;
//   - one operation in flight at a time; every step's failure is visible (`lastError`) and leaves the browser and
//     the agent consistent (a browser subscription the agent did not record is rolled back);
//   - the page never creates system notifications itself: the service worker shows push notifications, so a
//     notification that also arrives over SSE renders as a row, never as a second banner;
//   - none of this proves Apple/OS background delivery. `sendTest()` only queues a real notification on the agent;
//     whether it arrives is visible in the delivery counters and in the browser, not asserted here.
import type { Clock } from './types.ts';

export type PushPermission = 'default' | 'granted' | 'denied' | 'unknown';
export interface PushEnvironment {
  hasServiceWorker: boolean; hasPushManager: boolean; hasNotification: boolean;
  isSecureContext: boolean; protocol: string; hostname: string;
  isIOS: boolean; standalone: boolean; permission: PushPermission;
}
export type PushSupport =
  | { kind: 'supported' }
  | { kind: 'insecure-context' }
  | { kind: 'ios-not-installed' }
  | { kind: 'unsupported'; missing: string[] };

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

export function readPushEnvironment(w: Window & typeof globalThis): PushEnvironment {
  const nav = w.navigator as Navigator & { standalone?: boolean };
  const ua = nav.userAgent ?? '';
  const isIOS = /iPad|iPhone|iPod/.test(ua) || (nav.platform === 'MacIntel' && (nav.maxTouchPoints ?? 0) > 1);
  let standalone = nav.standalone === true;
  try { standalone = standalone || Boolean(w.matchMedia?.('(display-mode: standalone)').matches); } catch { /* matchMedia unavailable */ }
  const permission = 'Notification' in w ? (w.Notification.permission as PushPermission) : 'unknown';
  return {
    hasServiceWorker: 'serviceWorker' in nav, hasPushManager: 'PushManager' in w, hasNotification: 'Notification' in w,
    isSecureContext: Boolean(w.isSecureContext), protocol: w.location.protocol, hostname: w.location.hostname,
    isIOS, standalone, permission,
  };
}

/** Why push can or cannot work here. Order matters: the most actionable reason wins. */
export function classifyPushSupport(env: PushEnvironment): PushSupport {
  if (!env.isSecureContext && !LOCAL_HOSTS.has(env.hostname)) return { kind: 'insecure-context' };
  if (env.isIOS && !env.standalone && !env.hasPushManager) return { kind: 'ios-not-installed' };
  const missing: string[] = [];
  if (!env.hasServiceWorker) missing.push('service worker');
  if (!env.hasPushManager) missing.push('PushManager');
  if (!env.hasNotification) missing.push('Notification');
  if (missing.length) return { kind: 'unsupported', missing };
  return { kind: 'supported' };
}

/** One plain sentence telling the wearer what to do next. */
export function pushGuidance(env: PushEnvironment, support: PushSupport, subscribed: boolean): string {
  switch (support.kind) {
    case 'insecure-context': return `Push needs HTTPS (or localhost). This page is ${env.protocol}//${env.hostname}; open it over HTTPS or on this machine.`;
    case 'ios-not-installed': return 'On iPhone/iPad, push only works for a web app added to the Home Screen: Share → Add to Home Screen, then open KAWK from there and press Enable notifications.';
    case 'unsupported': return `This browser lacks ${support.missing.join(', ')}; push notifications cannot be enabled here.`;
    default: break;
  }
  if (env.permission === 'denied') return env.isIOS
    ? 'Notifications are blocked for KAWK. Allow them in iOS Settings → Notifications → KAWK, then press Enable notifications again.'
    : 'Notifications are blocked for this site in the browser. Allow them in the site settings (address-bar lock icon), then press Enable notifications again.';
  if (subscribed) return `Push covers the closed/background case. It is proven only when a test push shows up on this ${env.isIOS ? 'iPhone/iPad' : 'device'}${env.isIOS ? ' — iOS background receipt still needs that real test' : ''}.`;
  return `Enable notifications asks the ${env.isIOS ? 'system' : 'browser'} for permission (a click is required) and registers this ${env.standalone ? 'installed app' : 'browser'} with the agent. No token is needed.`;
}

/** VAPID public key: URL-safe base64 → raw bytes for `applicationServerKey`. */
export function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const trimmed = base64String.trim();
  if (!trimmed || /[^A-Za-z0-9_\-=]/.test(trimmed)) throw new Error('push key is not URL-safe base64');
  const padding = '='.repeat((4 - (trimmed.length % 4)) % 4);
  const base64 = (trimmed + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
  return out;
}
export function sameKey(a: ArrayBuffer | null | undefined, b: Uint8Array): boolean {
  if (!a) return false;
  const x = new Uint8Array(a);
  if (x.length !== b.length) return false;
  for (let i = 0; i < x.length; i += 1) if (x[i] !== b[i]) return false;
  return true;
}

// ---- browser seams -------------------------------------------------------------------------------------
export interface PushSubscriptionLike { endpoint: string; toJSON(): unknown; unsubscribe(): Promise<boolean>; options?: { applicationServerKey?: ArrayBuffer | null } }
export interface PushRegistrationLike {
  pushManager: {
    getSubscription(): Promise<PushSubscriptionLike | null>;
    subscribe(options: { userVisibleOnly: boolean; applicationServerKey: BufferSource }): Promise<PushSubscriptionLike>;
  };
}
export interface PushDeliveryStatus { subscriptions: number; pending: number; sent: number; failed: number }
export interface PushApi {
  key(): Promise<{ publicKey: string }>;
  subscribe(json: unknown): Promise<unknown>;
  unsubscribe(endpoint: string): Promise<unknown>;
  status(): Promise<PushDeliveryStatus>;
  test(): Promise<{ id?: string; [k: string]: unknown }>;
}
export interface PushDeps {
  env: () => PushEnvironment;
  /** The ready same-origin registration (or null when none can be obtained). Awaited only in prepare(), never in enable(). */
  registration: () => Promise<PushRegistrationLike | null>;
  api: PushApi; clock: Clock;
  onState: (s: PushState) => void;
}

export type PushStage = 'unsupported' | 'preparing' | 'not-ready' | 'ready' | 'subscribing' | 'subscribed' | 'unsubscribing' | 'denied' | 'error';
export interface PushState {
  stage: PushStage; support: PushSupport; permission: PushPermission;
  /** Key + registration cached: Enable may be pressed and subscribe() runs directly from the click. */
  prepared: boolean;
  subscribed: boolean; endpointHost: string | null; busy: boolean;
  message: string; lastError: string | null; guidance: string;
  delivery: PushDeliveryStatus | null; deliveryError: string | null; deliveryAt: number | null;
  lastTest: { id: string; at: number } | null;
  counts: { prepares: number; enables: number; disables: number; tests: number; syncs: number; errors: number };
}

/**
 * Safari (and the Push API in general) treats `pushManager.subscribe()` as the user-activation-sensitive call, so it
 * MUST run synchronously from the click. Everything that needs the network or the registration happens in
 * `prepare()` beforehand (key, registration, existing subscription, key rotation, re-sync); `enable()` only reads
 * the cached values and calls subscribe() before its first await.
 */
export class PushController {
  private state: PushState;
  private op: Promise<void> | null = null;
  private pollTimer: unknown = null;
  private pollInFlight = false;
  private stopped = false;
  private cached: { keyBytes: Uint8Array; registration: PushRegistrationLike } | null = null;
  constructor(private readonly deps: PushDeps, private readonly deliveryPollMs = 5000) {
    const env = deps.env();
    const support = classifyPushSupport(env);
    this.state = { stage: support.kind === 'supported' ? 'not-ready' : 'unsupported', support, permission: env.permission, prepared: false, subscribed: false, endpointHost: null, busy: false,
      message: support.kind === 'supported' ? 'push setup not run yet' : 'push unavailable here', lastError: null, guidance: pushGuidance(env, support, false),
      delivery: null, deliveryError: null, deliveryAt: null, lastTest: null, counts: { prepares: 0, enables: 0, disables: 0, tests: 0, syncs: 0, errors: 0 } };
  }
  get snapshot(): PushState { return { ...this.state, counts: { ...this.state.counts } }; }
  get busy(): boolean { return this.op !== null; }

  /**
   * Page load (and Retry setup): everything that may take time. Fetches and caches the agent key and the ready
   * registration, drops a browser subscription made for another key, re-sends an existing one (idempotent upsert).
   * Never prompts. Leaves `prepared` true only when a click can subscribe immediately.
   */
  prepare(): Promise<void> { return this.run(async () => {
    this.state.counts.prepares += 1;
    const env = this.deps.env(); const support = classifyPushSupport(env);
    if (support.kind !== 'supported') { this.cached = null; this.set({ stage: 'unsupported', support, permission: env.permission, prepared: false, subscribed: false, endpointHost: null, message: 'push unavailable here' }); return; }
    this.set({ stage: 'preparing', support, permission: env.permission, prepared: false, message: 'preparing push (agent key + service worker)…' });
    let keyBytes: Uint8Array;
    try { const k = await this.deps.api.key(); if (typeof k?.publicKey !== 'string') throw new Error('agent returned no publicKey'); keyBytes = urlBase64ToUint8Array(k.publicKey); }
    catch (e) { this.cached = null; this.fail(/503|not configured/i.test(msg(e)) ? 'push is not configured on the agent' : 'push key unavailable', e, 'not-ready'); return; }
    const registration = await this.deps.registration();
    if (!registration) { this.cached = null; this.fail('service worker registration unavailable', null, 'not-ready'); return; }
    this.cached = { keyBytes, registration };
    let sub = await registration.pushManager.getSubscription().catch(() => null);
    if (sub && !sameKey(sub.options?.applicationServerKey ?? null, keyBytes)) { await sub.unsubscribe().catch(() => false); sub = null; this.set({ message: 'agent push key changed; the old browser subscription was dropped' }); } // never keep a subscription the agent cannot sign for
    const permission = this.deps.env().permission;
    if (!sub) { this.set({ stage: permission === 'denied' ? 'denied' : 'ready', prepared: true, permission, subscribed: false, endpointHost: null, message: permission === 'denied' ? 'notifications blocked by the browser' : 'ready: press Enable notifications' }); return; }
    try { await this.deps.api.subscribe(sub.toJSON()); this.state.counts.syncs += 1; this.set({ stage: 'subscribed', prepared: true, permission, subscribed: true, endpointHost: hostOf(sub.endpoint), message: `push enabled on this device · agent re-synced (${hostOf(sub.endpoint)})` }); }
    catch (e) { this.state.counts.errors += 1; this.set({ stage: 'subscribed', prepared: true, permission, subscribed: true, endpointHost: hostOf(sub.endpoint), lastError: `agent did not accept the existing subscription: ${msg(e)}`, message: 'push enabled in the browser, but the agent could not be re-synced; press Retry push setup' }); }
    this.armPoll();
  }); }

  /**
   * The click. `pushManager.subscribe()` is called synchronously (no await before it) with the cached key; the browser
   * prompts for permission itself. Only afterwards is the subscription recorded on the agent (rolled back on refusal).
   */
  enable(): Promise<void> {
    this.state.counts.enables += 1;
    const cached = this.cached;
    if (this.op) return this.op;
    if (!cached || !this.state.prepared) { this.set({ stage: this.state.stage === 'unsupported' ? 'unsupported' : 'not-ready', message: this.state.stage === 'unsupported' ? 'push unavailable here' : 'push setup has not completed; press Retry push setup' }); return Promise.resolve(); }
    let pending: Promise<PushSubscriptionLike>;
    try { pending = cached.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: cached.keyBytes as BufferSource }); } // synchronous from the gesture
    catch (e) { pending = Promise.reject(e); }
    return this.run(async () => {
      this.set({ stage: 'subscribing', lastError: null, message: 'browser is asking for permission / subscribing…' });
      let sub: PushSubscriptionLike;
      try { sub = await pending; }
      catch (e) {
        const permission = this.deps.env().permission;
        const err = e as { name?: string } | null;
        // Browsers reject subscribe() with NotAllowedError both for "Block" (permission → denied) and for a dismissed prompt (stays default).
        if (permission === 'denied') { this.set({ stage: 'denied', permission, subscribed: false, message: 'notification permission denied' }); return; }
        if (err?.name === 'NotAllowedError' || permission === 'default') { this.set({ stage: 'ready', permission, subscribed: false, message: 'notification permission not granted (prompt dismissed); press Enable notifications again' }); return; }
        this.fail('browser push subscription failed', e); return;
      }
      this.set({ permission: this.deps.env().permission, message: 'recording the subscription on the agent…' });
      try { await this.deps.api.subscribe(sub.toJSON()); }
      catch (e) { await sub.unsubscribe().catch(() => false); this.fail('agent did not record the subscription (browser subscription rolled back)', e); return; }
      this.set({ stage: 'subscribed', subscribed: true, endpointHost: hostOf(sub.endpoint), lastError: null, message: `push enabled on this device (${hostOf(sub.endpoint)}) · send a test push to check it actually arrives` });
      this.armPoll();
      void this.refreshDelivery();
    });
  }

  disable(): Promise<void> { return this.run(async () => {
    this.state.counts.disables += 1;
    this.set({ stage: 'unsubscribing', lastError: null, message: 'disabling push…' });
    const reg = this.cached?.registration ?? await this.deps.registration();
    const sub = reg ? await reg.pushManager.getSubscription().catch(() => null) : null;
    if (!sub) { this.set({ stage: 'ready', subscribed: false, endpointHost: null, message: 'push was not enabled on this device' }); this.disarmPoll(); return; }
    const endpoint = sub.endpoint;
    let browserOk = true; let agentErr: string | null = null;
    try { browserOk = await sub.unsubscribe(); } catch (e) { browserOk = false; this.set({ lastError: `browser unsubscribe failed: ${msg(e)}` }); }
    try { await this.deps.api.unsubscribe(endpoint); } catch (e) { agentErr = msg(e); }
    if (agentErr) { this.state.counts.errors += 1; this.set({ stage: browserOk ? 'ready' : 'subscribed', subscribed: !browserOk, endpointHost: browserOk ? null : hostOf(endpoint), lastError: `agent did not remove the subscription: ${agentErr}`, message: browserOk ? 'push disabled in the browser; the agent may still list this device until it fails to deliver' : 'push could not be disabled' }); }
    else this.set({ stage: browserOk ? 'ready' : 'subscribed', subscribed: !browserOk, endpointHost: browserOk ? null : hostOf(endpoint), message: browserOk ? 'push disabled on this device and removed from the agent' : 'agent removed the device, but the browser kept its subscription; disable it in the site settings' });
    if (browserOk) this.disarmPoll();
  }); }

  /** Queues ONE real notification on the agent. Arrival is observed, never assumed. */
  sendTest(): Promise<void> { return this.run(async () => {
    this.state.counts.tests += 1;
    this.set({ lastError: null, message: 'queuing a test notification on the agent…' });
    try {
      const r = await this.deps.api.test();
      const id = typeof r?.id === 'string' ? r.id : '(no id returned)';
      this.set({ lastTest: { id, at: this.deps.clock.now() }, message: `test ${id} queued · wait for the system notification; "sent" below means the push service accepted it, not that the device showed it` });
    } catch (e) { this.fail('test push could not be queued', e); }
    void this.refreshDelivery();
  }); }

  async refreshDelivery(): Promise<void> {
    if (this.pollInFlight || this.stopped) return;
    this.pollInFlight = true;
    try { const d = await this.deps.api.status(); this.set({ delivery: normalizeDelivery(d), deliveryError: null, deliveryAt: this.deps.clock.now() }); }
    catch (e) { this.set({ deliveryError: msg(e), deliveryAt: this.deps.clock.now() }); }
    finally { this.pollInFlight = false; }
  }

  /** Clears status/error text and the last test marker; subscription and preparation state are untouched. */
  clearStatus(): void {
    this.set({ lastError: null, deliveryError: null, lastTest: null, message: this.state.subscribed ? 'push enabled on this device' : this.state.stage === 'denied' ? 'notifications blocked by the browser' : this.state.stage === 'unsupported' ? 'push unavailable here' : this.state.prepared ? 'ready: press Enable notifications' : 'push setup has not completed; press Retry push setup' });
  }

  stop(): void { this.stopped = true; this.disarmPoll(); }

  // ---- internals --------------------------------------------------------------------------------------
  private run(fn: () => Promise<void>): Promise<void> {
    if (this.op) return this.op; // one operation at a time: a second click joins the first
    this.state.busy = true; this.deps.onState(this.snapshot);
    this.op = fn().catch((e) => this.fail('unexpected push failure', e)).finally(() => { this.op = null; this.set({ busy: false }); });
    return this.op;
  }
  private fail(what: string, e: unknown, stage: PushStage = this.state.subscribed ? 'subscribed' : 'error'): void {
    this.state.counts.errors += 1;
    const detail = e === null || e === undefined ? '' : `: ${msg(e)}`;
    this.set({ stage, prepared: stage === 'not-ready' ? false : this.state.prepared, lastError: `${what}${detail}`, message: `${what}${detail}` });
  }
  private armPoll(): void {
    if (this.pollTimer !== null || this.stopped) return;
    const tick = () => { this.pollTimer = null; if (this.stopped || !this.state.subscribed) return; void this.refreshDelivery().finally(() => { if (!this.stopped && this.state.subscribed && this.pollTimer === null) this.pollTimer = this.deps.clock.setTimeout(tick, this.deliveryPollMs); }); };
    this.pollTimer = this.deps.clock.setTimeout(tick, this.deliveryPollMs);
  }
  private disarmPoll(): void { if (this.pollTimer !== null) this.deps.clock.clearTimeout(this.pollTimer); this.pollTimer = null; }
  private set(patch: Partial<Omit<PushState, 'counts'>>): void {
    const next = { ...this.state, ...patch, counts: this.state.counts };
    const env = this.deps.env();
    next.guidance = pushGuidance({ ...env, permission: next.permission }, next.support, next.subscribed);
    this.state = next;
    this.deps.onState(this.snapshot);
  }
}

function normalizeDelivery(d: unknown): PushDeliveryStatus {
  const o = (d && typeof d === 'object' ? d : {}) as Record<string, unknown>;
  const n = (k: string) => (typeof o[k] === 'number' && Number.isFinite(o[k]) ? (o[k] as number) : 0);
  return { subscriptions: n('subscriptions'), pending: n('pending'), sent: n('sent'), failed: n('failed') };
}
const hostOf = (endpoint: string): string => { try { return new URL(endpoint).host; } catch { return 'unknown push service'; } };
const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

// ---- service worker ↔ page messages -------------------------------------------------------------------------
export type WorkerMessage =
  | { type: 'push'; id: string; text: string; foreground: boolean; duplicate: boolean; displayed: boolean }
  | { type: 'open'; id: string | null; url: string | null };
/** Messages posted by public/sw.js. Anything else (other extensions, malformed) is ignored. */
export function parseWorkerMessage(data: unknown): WorkerMessage | null {
  if (!data || typeof data !== 'object') return null;
  const o = data as Record<string, unknown>;
  if (o.type === 'kawk-push' && typeof o.id === 'string' && o.id) return { type: 'push', id: o.id, text: typeof o.body === 'string' ? o.body : '', foreground: o.foreground === true, duplicate: o.duplicate === true, displayed: o.displayed !== false };
  if (o.type === 'kawk-notification-open') return { type: 'open', id: typeof o.id === 'string' && o.id ? o.id : null, url: typeof o.url === 'string' && o.url.startsWith('/') && !o.url.startsWith('//') ? o.url : null };
  return null;
}
/** `?notification=<id>` set by the service worker when it opens the page from a notification click. */
export function notificationIdFromSearch(search: string): string | null {
  try { const v = new URLSearchParams(search).get('notification'); return v && v.length <= 200 ? v : null; } catch { return null; }
}
export const NOTIFICATION_TAG_PREFIX = 'kawk-notification:';
