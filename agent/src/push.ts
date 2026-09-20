import webpush from "web-push";
import { readFile, writeFile } from "node:fs/promises";
import { z } from "zod";
import type { Store } from "./store";

export const Subscription = z.object({
  endpoint: z.url().refine((s) => new URL(s).protocol === "https:"),
  keys: z.object({ p256dh: z.string().min(16).max(256), auth: z.string().min(8).max(256) }),
});
type Sender = (
  subscription: webpush.PushSubscription,
  payload: string,
  options: webpush.RequestOptions,
) => Promise<unknown>;
export class PushDelivery {
  private active?: Promise<void>;
  private timer?: ReturnType<typeof setInterval>;
  constructor(
    private store: Store,
    readonly keys: { publicKey: string; privateKey: string },
    private send: Sender = webpush.sendNotification,
  ) {
    store.run(
      "CREATE TABLE IF NOT EXISTS push_subscriptions(id TEXT PRIMARY KEY,owner TEXT NOT NULL,payload TEXT NOT NULL)",
    );
    store.run(
      "CREATE TABLE IF NOT EXISTS push_deliveries(notification_id TEXT,subscription_id TEXT,state TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,due_at INTEGER NOT NULL,PRIMARY KEY(notification_id,subscription_id))",
    );
  }
  static async open(store: Store, path: string) {
    let keys: { publicKey: string; privateKey: string };
    try {
      keys = JSON.parse(await readFile(path, "utf8"));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      keys = webpush.generateVAPIDKeys();
      await writeFile(path, JSON.stringify(keys), { mode: 0o600, flag: "wx" });
    }
    return new PushDelivery(store, keys);
  }
  subscribe(owner: string, value: unknown) {
    const subscription = Subscription.parse(value);
    const id = new Bun.CryptoHasher("sha256").update(subscription.endpoint).digest("hex");
    this.store.run(
      "INSERT INTO push_subscriptions VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET owner=excluded.owner,payload=excluded.payload",
      id,
      owner,
      JSON.stringify(subscription),
    );
    return { subscribed: true };
  }
  unsubscribe(owner: string, endpoint: string) {
    this.store.atomic(() => {
      this.store.run("DELETE FROM push_deliveries WHERE subscription_id IN (SELECT id FROM push_subscriptions WHERE owner=? AND json_extract(payload,'$.endpoint')=?)", owner, endpoint);
      this.store.run(
      "DELETE FROM push_subscriptions WHERE owner=? AND json_extract(payload,'$.endpoint')=?",
      owner,
      endpoint,
      );
    });
    return { subscribed: false };
  }
  status(owner: string) {
    const subscriptions = this.store.one<{ n: number }>("SELECT count(*) AS n FROM push_subscriptions WHERE owner=?", owner)!.n;
    const counts = { pending: 0, sent: 0, failed: 0 };
    for (const row of this.store.all<{ state: keyof typeof counts; n: number }>(
      `SELECT d.state,count(*) AS n FROM push_deliveries d JOIN push_subscriptions s ON s.id=d.subscription_id
       JOIN notifications n ON n.id=d.notification_id WHERE s.owner=?
       AND (d.state!='pending' OR (n.state='pending' AND n.expires_at>?)) GROUP BY d.state`, owner, this.store.now()))
      if (row.state in counts) counts[row.state] = row.n;
    return { subscriptions, ...counts };
  }
  testNotification(owner: string) {
    return this.store.atomic(() => {
      const id = `push-test:${crypto.randomUUID()}`, now = this.store.now();
      this.store.ingest(owner, { id, deviceId: 'notification-settings', streamId: 'push-test', revision: 0,
        kind: 'context', final: true, sourceStart: now, sourceEnd: now,
        text: 'The user requested a notification delivery test.', confidence: 1, speakerId: null,
        personIds: [], provenance: 'user:push-test' }, false);
      const refs = [{ eventId: id, revision: 0 }];
      const task = this.store.createTask({ owner, goal: 'Test this device notification delivery', refs, capabilities: [] });
      this.store.setTask(task.id, 'completed');
      return this.store.notify(task, 'Test notification from KAWK.', refs, 300_000, id);
    });
  }
  start() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      if (!this.active)
        this.active = this.flush()
          .catch(() => {})
          .finally(() => {
            this.active = undefined;
          });
    }, 250);
  }
  async stop() {
    clearInterval(this.timer);
    await this.active;
  }
  async flush() {
    for (const sub of this.store.all<{ id: string; owner: string; payload: string }>(
      "SELECT * FROM push_subscriptions",
    )) {
      for (const n of this.store.notifications(sub.owner)) {
        this.store.run(
          "INSERT OR IGNORE INTO push_deliveries VALUES(?,?,'pending',0,?)",
          n.id,
          sub.id,
          this.store.now(),
        );
        const delivery = this.store.one<{ attempts: number }>(
          "SELECT attempts FROM push_deliveries WHERE notification_id=? AND subscription_id=? AND state='pending' AND due_at<=?",
          n.id,
          sub.id,
          this.store.now(),
        );
        if (!delivery) continue;
        // A previous endpoint may have taken seconds to send. Revalidate immediately
        // before sending so expiry, acknowledgement, corrections and unsubscribe win.
        if (!this.store.notifications(sub.owner).some(current => current.id === n.id) ||
            !this.store.one("SELECT id FROM push_subscriptions WHERE id=?", sub.id)) continue;
        try {
          await this.send(
            JSON.parse(sub.payload),
            JSON.stringify({ id: n.id, title: "KAWK", body: n.text, url: "/", expiresAt: n.expiresAt }),
            {
              TTL: Math.max(1, Math.floor((n.expiresAt - this.store.now()) / 1000)),
              timeout: 5000,
              vapidDetails: { subject: "https://localhost", ...this.keys },
            },
          );
          this.store.run(
            "UPDATE push_deliveries SET state='sent' WHERE notification_id=? AND subscription_id=?",
            n.id,
            sub.id,
          );
        } catch (e) {
          const status = (e as { statusCode?: number }).statusCode;
          if (status === 404 || status === 410) {
            this.unsubscribe(sub.owner, JSON.parse(sub.payload).endpoint);
            break;
          }
          const attempts = delivery.attempts + 1;
          this.store.run(
            "UPDATE push_deliveries SET attempts=?,due_at=?,state=? WHERE notification_id=? AND subscription_id=?",
            attempts,
            this.store.now() + Math.min(60000, 1000 * 2 ** attempts),
            attempts >= 6 ? "failed" : "pending",
            n.id,
            sub.id,
          );
        }
      }
    }
  }
}
