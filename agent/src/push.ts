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
    this.store.run(
      "DELETE FROM push_subscriptions WHERE owner=? AND json_extract(payload,'$.endpoint')=?",
      owner,
      endpoint,
    );
    return { subscribed: false };
  }
  start() {
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
        try {
          await this.send(
            JSON.parse(sub.payload),
            JSON.stringify({ id: n.id, title: "KAWK", body: n.text, url: "/" }),
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
            this.store.run("DELETE FROM push_subscriptions WHERE id=?", sub.id);
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
