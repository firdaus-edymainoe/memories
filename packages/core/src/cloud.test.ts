import { describe, expect, it } from "vitest";
import { type CatalogChangeFeed, type ChangeBatch, type SyncBatch, type SyncRecord, syncCatalog } from "./index.js";

function fileRecord(id: string): SyncRecord {
  return {
    entity: "file",
    key: [id],
    data: { id, objectHash: `h-${id}`, name: `${id}.jpg`, kind: "photo", takenAt: null, place: null, inbox: true },
  };
}

/** A feed over an in-memory queue, acknowledging the way the SQLite feed does. */
function queueFeed(records: SyncRecord[], replace = false): CatalogChangeFeed & { queue: Array<{ seq: number; record: SyncRecord }> } {
  let replacing = replace;
  const queue = records.map((record, index) => ({ seq: index + 1, record }));
  return {
    queue,
    async read(limit): Promise<ChangeBatch> {
      const slice = queue.slice(0, limit);
      return { cursor: slice.at(-1)?.seq ?? 0, replace: replacing, records: slice.map((row) => row.record) };
    },
    async acknowledge(cursor) {
      replacing = false;
      while (queue[0] && queue[0].seq <= cursor) queue.shift();
    },
    async pendingCount() {
      return queue.length;
    },
    async start() {},
    async stop() {},
    async isTracking() {
      return true;
    },
  };
}

describe("syncCatalog", () => {
  it("sends queued changes in batches and forgets them once stored", async () => {
    const feed = queueFeed(["a", "b", "c", "d", "e"].map(fileRecord), true);
    const pushed: SyncBatch[] = [];
    const result = await syncCatalog(feed, { push: async (batch) => void pushed.push(batch) }, { deviceId: "dev", batchSize: 2 });

    expect(result).toEqual({ records: 5, batches: 3 });
    expect(pushed.map((batch) => [batch.replace, batch.records.length])).toEqual([
      [true, 2],
      [false, 2],
      [false, 1],
    ]);
    expect(pushed.every((batch) => batch.deviceId === "dev")).toBe(true);
    expect(feed.queue).toHaveLength(0);
  });

  it("keeps changes when the cloud fails, so the next sync resends them", async () => {
    const feed = queueFeed(["a", "b"].map(fileRecord));
    await expect(
      syncCatalog(feed, { push: async () => Promise.reject(new Error("offline")) }, { deviceId: "dev" }),
    ).rejects.toThrow("offline");
    expect(feed.queue).toHaveLength(2);
  });

  it("sends a replace even when the catalog is empty", async () => {
    const pushed: SyncBatch[] = [];
    await syncCatalog(queueFeed([], true), { push: async (batch) => void pushed.push(batch) }, { deviceId: "dev" });
    expect(pushed).toEqual([{ deviceId: "dev", replace: true, records: [] }]);
  });

  it("does nothing when nothing changed", async () => {
    const pushed: SyncBatch[] = [];
    expect(await syncCatalog(queueFeed([]), { push: async (batch) => void pushed.push(batch) }, { deviceId: "dev" })).toEqual({
      records: 0,
      batches: 0,
    });
    expect(pushed).toEqual([]);
  });
});
