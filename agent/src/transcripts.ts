import { createHash } from "node:crypto";
import { mkdir, open } from "node:fs/promises";
import writeFileAtomic from "write-file-atomic";
import { join } from "node:path";
import type { Store } from "./store";

/** SQLite is the write-ahead journal; hourly JSONL is a restartable materialization.
 * Every revision is included, regardless of Jev. Hour = server receipt UTC hour,
 * so late finals/corrections never pretend to have arrived at source capture time. */
export class TranscriptArchive {
  private pending: Promise<void> = Promise.resolve();
  constructor(
    private store: Store,
    readonly directory: string,
  ) {
    store.run(`INSERT OR IGNORE INTO transcript_exports(owner,hour)
      SELECT owner,CAST(received_at/3600000 AS INTEGER)*3600000 FROM evidence
      WHERE deleted=0 AND json_extract(payload,'$.kind')='transcript' GROUP BY owner,2`);
  }
  file(owner: string, hour: number) {
    const scope = createHash("sha256").update(owner).digest("hex").slice(0, 24);
    return join(
      this.directory,
      `${scope}-${new Date(hour).toISOString().slice(0, 13).replace("T", "-")}.jsonl`,
    );
  }
  flush(includeCurrentHour = true) {
    this.pending = this.pending.catch(() => {}).then(() => this.drain(includeCurrentHour));
    return this.pending;
  }
  private async drain(includeCurrentHour = true) {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    while (true) {
      const bucket = this.store.one<{ owner: string; hour: number; version: number }>(
        "SELECT owner,hour,version FROM transcript_exports WHERE version>exported_version AND hour<? ORDER BY hour LIMIT 1",
        includeCurrentHour
          ? Number.MAX_SAFE_INTEGER
          : Math.floor(this.store.now() / 3600000) * 3600000,
      );
      if (!bucket) return;
      const rows = this.store.all<{ payload: string; received_at: number }>(
        "SELECT payload,received_at FROM evidence WHERE owner=? AND received_at>=? AND received_at<? AND deleted=0 AND json_extract(payload,'$.kind')='transcript' ORDER BY received_at,id,revision",
        bucket.owner,
        bucket.hour,
        bucket.hour + 3600000,
      );
      const body = rows
        .map(
          (row) =>
            JSON.stringify({
              schemaVersion: 1,
              type: "transcript",
              owner: bucket.owner,
              receivedAt: row.received_at,
              ...JSON.parse(row.payload),
            }) + "\n",
        )
        .join("");
      await writeFileAtomic(this.file(bucket.owner, bucket.hour), body, {
        mode: 0o600,
        fsync: true,
      });
      const directory = await open(this.directory, "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
      this.store.run(
        "UPDATE transcript_exports SET exported_version=? WHERE owner=? AND hour=?",
        bucket.version,
        bucket.owner,
        bucket.hour,
      );
      // An ingest/delete during file IO increments version and forces another pass.
    }
  }
}
