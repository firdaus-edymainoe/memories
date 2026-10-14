import {
  MemoryFileIO,
  MemoryVolumes,
  emptyTrash,
  getFileDetail,
  ingestFolder,
  listLibrary,
  listTrash,
  registerDrive,
  runBackupJob,
  saveBackupJob,
  setBackupAuto,
  syncDrivePresence,
  trashFiles,
} from "@memories/core";
import { mkdtemp } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SqliteCatalog } from "./index.js";

describe("SqliteCatalog", () => {
  it("persists ingest and survives a new catalog instance on the same file", async () => {
    const fileIO = new MemoryFileIO();
    const volumes = new MemoryVolumes();
    volumes.connect({ volumeId: "vol", mountPath: "/V", label: "V" });
    fileIO.seed("/V/root", "shot.jpg", "same", { takenAt: "2025-08-12T00:00:00" });
    const catalog = new SqliteCatalog(":memory:");
    const ports = { catalog, fileIO, volumes };
    const drive = await registerDrive(ports, {
      name: "SSD",
      kind: "disk",
      rootPath: "/V/root",
      volumeId: "vol",
    });
    await ingestFolder(ports, { driveId: drive.id });
    expect(await listLibrary(ports, { kind: "photo" })).toHaveLength(1);
    expect(await catalog.getDrive(drive.id)).toMatchObject({ rootPath: "/V/root" });
  });
});

describe("SqliteCatalog on disk", () => {
  it("round-trips every table through a reopened file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mem-catalog-"));
    const file = join(dir, "catalog.sqlite");
    const first = new SqliteCatalog(file);
    await first.upsertDrive({ id: "d1", name: "SSD", kind: "disk", rootPath: "/V", volumeId: "vol", online: true });
    await first.setDriveOnline("d1", false);
    await first.upsertObject({ hash: "h1", size: 10, mime: "image/jpeg" });
    await first.upsertFile({ id: "f1", objectHash: "h1", name: "a.jpg", kind: "photo", takenAt: null, place: null, inbox: true });
    await first.upsertFile({ id: "f1", objectHash: "h1", name: "b.jpg", kind: "photo", takenAt: "2024-01-02", place: "Oslo", inbox: false });
    await first.upsertReplica({ fileId: "f1", driveId: "d1", relativePath: "x/b.jpg", status: "ready", progress: null });
    await first.upsertVirtualFolder({ id: "v1", name: "Trips", parentId: null });
    await first.setFileFolder("f1", "v1");
    await first.upsertBackupJob({ id: "j1", sourceDriveId: "d1", destDriveId: "d2", sourceRelativePaths: ["DCIM", ""], lastRunAt: null });
    first.close();

    const second = new SqliteCatalog(file);
    expect(await second.getDrive("d1")).toMatchObject({ online: false, name: "SSD" });
    expect(await second.getFile("f1")).toEqual({
      id: "f1",
      objectHash: "h1",
      name: "b.jpg",
      kind: "photo",
      takenAt: "2024-01-02",
      place: "Oslo",
      inbox: false,
      trashedAt: null,
    });
    expect(await second.listFiles({ inbox: false })).toHaveLength(1);
    expect(await second.findReplica("d1", "x/b.jpg")).toMatchObject({ fileId: "f1", progress: null });
    expect(await second.listFileIdsInFolder("v1")).toEqual(["f1"]);
    expect(await second.getBackupJob("j1")).toMatchObject({ sourceRelativePaths: ["DCIM", ""] });
    await second.deleteReplica("d1", "x/b.jpg");
    expect(await second.listReplicas("f1")).toEqual([]);
    expect(await second.getObject("missing")).toBeNull();
    second.close();
  });
});

describe("SqliteCatalog migrations", () => {
  it("upgrades a catalog created before replicas tracked size and modification time", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mem-migrate-"));
    const file = join(dir, "catalog.sqlite");
    const old = new DatabaseSync(file);
    old.exec(`CREATE TABLE replicas (file_id TEXT NOT NULL, drive_id TEXT NOT NULL, relative_path TEXT NOT NULL,
      status TEXT NOT NULL, progress INTEGER);
      INSERT INTO replicas VALUES ('f1', 'd1', 'a.jpg', 'ready', NULL);`);
    old.close();

    const catalog = new SqliteCatalog(file);
    expect(await catalog.findReplica("d1", "a.jpg")).toMatchObject({ fileId: "f1", size: null, modifiedAt: null });
    await catalog.upsertReplica({
      fileId: "f1",
      driveId: "d1",
      relativePath: "a.jpg",
      status: "ready",
      progress: null,
      size: 42,
      modifiedAt: "2024-01-01T00:00:00.000Z",
    });
    expect(await catalog.findReplica("d1", "a.jpg")).toMatchObject({ size: 42, modifiedAt: "2024-01-01T00:00:00.000Z" });
    catalog.close();
    // Reopening does not re-run the migration.
    new SqliteCatalog(file).close();
  });
});

describe("SqliteCatalog with the library features", () => {
  it("stores versions, trash, deferred deletes, backup history and automatic backups", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mem-features-"));
    const catalog = new SqliteCatalog(join(dir, "catalog.sqlite"));
    const fileIO = new MemoryFileIO();
    const volumes = new MemoryVolumes();
    volumes.connect({ volumeId: "mac", mountPath: "/mac", label: "Mac" });
    volumes.connect({ volumeId: "ssd", mountPath: "/ssd", label: "SSD" });
    const ports = { catalog, fileIO, volumes };
    const mac = await registerDrive(ports, { name: "Mac", kind: "computer", rootPath: "/mac", volumeId: "mac" });
    const ssd = await registerDrive(ports, { name: "SSD", kind: "disk", rootPath: "/ssd", volumeId: "ssd" });

    fileIO.seed("/mac", "plan.txt", "v1");
    const job = await saveBackupJob(ports, { sourceDriveId: mac.id, destDriveId: ssd.id, sourceRelativePaths: [""] });
    await runBackupJob(ports, job.id);
    fileIO.seed("/mac", "plan.txt", "v2");
    await runBackupJob(ports, job.id);
    const [file] = await listLibrary(ports);
    const detail = (await getFileDetail(ports, file!.id))!;
    expect(detail.versions.map((version) => version.version)).toEqual([2, 1]);
    expect(detail.versions[1]!.copies.map((row) => row.replica.relativePath)).toEqual(["plan.txt"]);
    expect(detail.replicas.map((row) => row.replica.relativePath).sort()).toEqual(["plan (2).txt", "plan.txt"]);

    expect((await setBackupAuto(ports, job.id, true)).auto).toBe(true);
    expect((await catalog.getBackupJob(job.id))!.auto).toBe(true);
    expect((await catalog.listBackupRuns(5)).map((run) => run.status)).toEqual(["done", "done"]);

    volumes.disconnect("ssd");
    await syncDrivePresence(ports);
    await trashFiles(ports, [file!.id]);
    expect((await listTrash(ports)).map((row) => row.id)).toEqual([file!.id]);
    expect(await listLibrary(ports)).toEqual([]);
    expect(await emptyTrash(ports)).toMatchObject({ deleted: 1, waiting: ["SSD"] });
    expect((await catalog.listPendingDeletions(ssd.id)).map((row) => row.relativePath).sort()).toEqual([
      "plan (2).txt",
      "plan.txt",
    ]);

    volumes.connect({ volumeId: "ssd", mountPath: "/ssd", label: "SSD" });
    await syncDrivePresence(ports);
    expect(await catalog.listPendingDeletions(ssd.id)).toEqual([]);
    expect(await fileIO.exists("/ssd", "plan.txt")).toBe(false);
    expect(await catalog.listVersions(file!.id)).toEqual([]);
    catalog.close();
  });
});
