import { PGlite } from "@electric-sql/pglite";
import type { SyncRecord } from "@memories/core";
import { drizzle } from "drizzle-orm/pglite";
import { beforeEach, describe, expect, it } from "vitest";
import { PostgresCatalogStore, migrateCatalog } from "./index.js";
import * as schema from "./schema.js";

const drive: SyncRecord = {
  entity: "drive",
  key: ["d1"],
  data: { id: "d1", name: "SSD", kind: "disk", rootPath: "/V", volumeId: "vol", online: true },
};
const file: SyncRecord = {
  entity: "file",
  key: ["f1"],
  data: { id: "f1", objectHash: "h1", name: "a.jpg", kind: "photo", takenAt: "2025-08-12T19:40:00", place: "KL", inbox: false, trashedAt: null },
};
const every: SyncRecord[] = [
  drive,
  { entity: "object", key: ["h1"], data: { hash: "h1", size: 5_000_000_000, mime: "image/jpeg" } },
  file,
  {
    entity: "replica",
    key: ["d1", "x/a.jpg"],
    data: { fileId: "f1", driveId: "d1", relativePath: "x/a.jpg", status: "ready", progress: null, size: 10, modifiedAt: null, objectHash: "h1" },
  },
  { entity: "folder", key: ["v1"], data: { id: "v1", name: "Trips", parentId: null } },
  { entity: "fileFolder", key: ["f1"], data: { fileId: "f1", folderId: "v1" } },
  { entity: "version", key: ["f1", 1], data: { fileId: "f1", version: 1, objectHash: "h1", size: 10, createdAt: "2026-01-01T00:00:00Z" } },
  {
    entity: "backupJob",
    key: ["j1"],
    data: { id: "j1", sourceDriveId: "d1", destDriveId: "d2", sourceRelativePaths: ["DCIM", ""], lastRunAt: null, auto: true },
  },
];

describe("PostgresCatalogStore", () => {
  let store: PostgresCatalogStore;

  beforeEach(async () => {
    const db = drizzle(new PGlite(), { schema });
    await migrateCatalog(db);
    await migrateCatalog(db); // a second run is a no-op
    store = new PostgresCatalogStore(db);
  });

  it("round-trips every entity", async () => {
    await store.registerDevice("u1", { id: "dev", name: "Firdaus’s Mac", platform: "darwin" });
    await store.apply("u1", { deviceId: "dev", replace: true, records: every });
    const sorted = (records: SyncRecord[]) => [...records].sort((a, b) => a.entity.localeCompare(b.entity));
    expect(sorted(await store.snapshot("u1", "dev"))).toEqual(sorted(every));
    expect(await store.listDevices("u1")).toMatchObject([{ id: "dev", name: "Firdaus’s Mac", platform: "darwin" }]);
    expect((await store.listDevices("u1"))[0]!.lastSyncedAt).not.toBeNull();
  });

  it("updates, deletes, and lets the latest record for a key win", async () => {
    await store.apply("u1", { deviceId: "dev", replace: false, records: [drive, file] });
    await store.apply("u1", {
      deviceId: "dev",
      replace: false,
      records: [
        { ...file, data: { ...(file.data as object), name: "first.jpg" } } as SyncRecord,
        { ...file, data: { ...(file.data as object), name: "second.jpg" } } as SyncRecord,
        { entity: "drive", key: ["d1"], data: null },
      ],
    });
    expect(await store.snapshot("u1", "dev")).toEqual([{ ...file, data: { ...(file.data as object), name: "second.jpg" } }]);
  });

  it("replace drops what the device had before", async () => {
    await store.apply("u1", { deviceId: "dev", replace: false, records: [drive, file] });
    await store.apply("u1", { deviceId: "dev", replace: true, records: [file] });
    expect(await store.snapshot("u1", "dev")).toEqual([file]);
  });

  it("keeps people and devices apart", async () => {
    await store.apply("u1", { deviceId: "dev", replace: false, records: [drive] });
    await store.apply("u2", { deviceId: "dev", replace: true, records: [file] });
    await store.apply("u1", { deviceId: "other", replace: true, records: [] });
    expect(await store.snapshot("u1", "dev")).toEqual([drive]);
    expect(await store.snapshot("u2", "dev")).toEqual([file]);

    // A record cannot claim another owner.
    const sneaky = { ...drive, data: { ...(drive.data as object), userId: "u2", deviceId: "dev" } } as unknown as SyncRecord;
    await store.apply("u1", { deviceId: "dev", replace: false, records: [sneaky] });
    expect(await store.snapshot("u2", "dev")).toEqual([file]);
  });

  it("removes a device or a person with all their rows", async () => {
    await store.apply("u1", { deviceId: "a", replace: false, records: every });
    await store.apply("u1", { deviceId: "b", replace: false, records: [drive] });
    await store.removeDevice("u1", "a");
    expect(await store.snapshot("u1", "a")).toEqual([]);
    expect(await store.snapshot("u1", "b")).toEqual([drive]);
    await store.removeUser("u1");
    expect(await store.listDevices("u1")).toEqual([]);
    expect(await store.snapshot("u1", "b")).toEqual([]);
  });
});
