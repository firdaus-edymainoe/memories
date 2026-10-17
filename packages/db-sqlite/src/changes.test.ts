import { type SyncBatch, syncCatalog } from "@memories/core";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SqliteCatalog } from "./index.js";

const drive = { id: "d1", name: "SSD", kind: "disk" as const, rootPath: "/V", volumeId: "vol", online: true };
const file = { id: "f1", objectHash: "h1", name: "a.jpg", kind: "photo" as const, takenAt: null, place: null, inbox: true };

describe("change feed", () => {
  it("records nothing until sync is turned on", async () => {
    const catalog = new SqliteCatalog(":memory:");
    const feed = catalog.changes();
    await catalog.upsertDrive(drive);
    expect(await feed.isTracking()).toBe(false);
    expect(await feed.pendingCount()).toBe(0);
  });

  it("queues the whole catalog on start, then sends it as a replace", async () => {
    const catalog = new SqliteCatalog(":memory:");
    await catalog.upsertDrive(drive);
    await catalog.upsertObject({ hash: "h1", size: 3, mime: "image/jpeg" });
    await catalog.upsertFile(file);
    await catalog.upsertReplica({ fileId: "f1", driveId: "d1", relativePath: "x/a.jpg", status: "ready", progress: null });
    await catalog.upsertVirtualFolder({ id: "v1", name: "Trips", parentId: null });
    await catalog.setFileFolder("f1", "v1");
    await catalog.addVersion({ fileId: "f1", version: 1, objectHash: "h1", size: 3, createdAt: "2026-01-01T00:00:00Z" });
    await catalog.upsertBackupJob({ id: "j1", sourceDriveId: "d1", destDriveId: "d2", sourceRelativePaths: [""], lastRunAt: null });

    const feed = catalog.changes();
    await feed.start();
    const batch = await feed.read(100);
    expect(batch.replace).toBe(true);
    expect(batch.records.map((r) => r.entity).sort()).toEqual(
      ["backupJob", "drive", "file", "fileFolder", "folder", "object", "replica", "version"].sort(),
    );
    expect(batch.records.find((r) => r.entity === "replica")).toMatchObject({
      key: ["d1", "x/a.jpg"],
      data: { fileId: "f1", relativePath: "x/a.jpg", status: "ready" },
    });
    expect(batch.records.find((r) => r.entity === "version")).toMatchObject({ key: ["f1", 1], data: { version: 1 } });
    expect(batch.records.find((r) => r.entity === "backupJob")).toMatchObject({ data: { sourceRelativePaths: [""] } });

    await feed.acknowledge(batch.cursor);
    expect(await feed.read(100)).toEqual({ cursor: 0, replace: false, records: [] });
  });

  it("keeps one entry per row with its latest content, and records deletes", async () => {
    const catalog = new SqliteCatalog(":memory:");
    const feed = catalog.changes();
    await feed.start();
    await feed.acknowledge((await feed.read(10)).cursor);

    await catalog.upsertFile(file);
    await catalog.upsertFile({ ...file, name: "renamed.jpg" });
    await catalog.upsertDrive(drive);
    await catalog.setDriveOnline("d1", true); // no change: not recorded again
    await catalog.upsertReplica({ fileId: "f1", driveId: "d1", relativePath: "a.jpg", status: "copying", progress: 10 });
    await catalog.deleteFile("f1");

    const batch = await feed.read(10);
    expect(batch.records).toEqual([
      { entity: "drive", key: ["d1"], data: drive },
      { entity: "replica", key: ["d1", "a.jpg"], data: null },
      { entity: "file", key: ["f1"], data: null },
    ]);
  });

  it("ignores copy progress but not the finished copy", async () => {
    const catalog = new SqliteCatalog(":memory:");
    const replica = { fileId: "f1", driveId: "d1", relativePath: "a.jpg", status: "copying" as const, progress: 0 };
    await catalog.upsertReplica(replica);
    const feed = catalog.changes();
    await feed.start();
    await feed.acknowledge((await feed.read(10)).cursor);

    await catalog.upsertReplica({ ...replica, progress: 50 });
    expect(await feed.pendingCount()).toBe(0);
    await catalog.upsertReplica({ ...replica, status: "ready", progress: null });
    expect(await feed.pendingCount()).toBe(1);
  });

  it("keeps a change made while a batch was being sent", async () => {
    const catalog = new SqliteCatalog(":memory:");
    const feed = catalog.changes();
    await feed.start();
    await catalog.upsertFile(file);
    const batch = await feed.read(10);
    await catalog.upsertFile({ ...file, name: "later.jpg" });
    await feed.acknowledge(batch.cursor);
    expect((await feed.read(10)).records).toEqual([{ entity: "file", key: ["f1"], data: { ...file, name: "later.jpg", trashedAt: null } }]);
  });

  it("survives a restart and stops cleanly", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mem-sync-"));
    const path = join(dir, "catalog.sqlite");
    const first = new SqliteCatalog(path);
    await first.changes().start();
    await first.upsertDrive(drive);
    first.close();

    const second = new SqliteCatalog(path);
    const pushed: SyncBatch[] = [];
    await syncCatalog(second.changes(), { push: async (batch) => void pushed.push(batch) }, { deviceId: "dev", batchSize: 1 });
    expect(pushed).toEqual([{ deviceId: "dev", replace: true, records: [{ entity: "drive", key: ["d1"], data: drive }] }]);

    await second.changes().stop();
    await second.upsertDrive({ ...drive, name: "Other" });
    expect(await second.changes().pendingCount()).toBe(0);
    second.close();
  });
});
