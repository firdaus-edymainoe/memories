import { describe, expect, it } from "vitest";
import { exportFiles } from "./export.js";
import { MemoryCatalog, MemoryFileIO, MemoryVolumes } from "./memory.js";
import type { Ports } from "./ports.js";
import { BackupScheduler } from "./scheduler.js";
import { deleteForever, emptyTrash, listTrash, restoreFiles, trashFiles } from "./trash.js";
import {
  getFileDetail,
  ingestFolder,
  listEvents,
  listLibrary,
  openVersionFile,
  registerDrive,
  runBackupJob,
  saveBackupJob,
  setBackupAuto,
  syncDrivePresence,
} from "./use-cases.js";

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

async function setup() {
  const catalog = new MemoryCatalog();
  const fileIO = new MemoryFileIO();
  const volumes = new MemoryVolumes();
  volumes.connect({ volumeId: "mac", mountPath: "/mac", label: "Mac" });
  volumes.connect({ volumeId: "ssd", mountPath: "/ssd", label: "SSD" });
  const ports: Ports = { catalog, fileIO, volumes };
  const mac = await registerDrive(ports, { name: "Mac", kind: "computer", rootPath: "/mac", volumeId: "mac" });
  const ssd = await registerDrive(ports, { name: "SSD", kind: "disk", rootPath: "/ssd", volumeId: "ssd" });
  return { catalog, fileIO, volumes, ports, mac, ssd };
}

async function readStream(stream: ReadableStream<Uint8Array>) {
  return new Response(stream).text();
}

describe("versions", () => {
  it("keeps an edited file as one file with its earlier versions", async () => {
    const { catalog, fileIO, ports, mac, ssd } = await setup();
    fileIO.seed("/mac", "Docs/plan.txt", "first draft");
    const job = await saveBackupJob(ports, { sourceDriveId: mac.id, destDriveId: ssd.id, sourceRelativePaths: ["Docs"] });
    await runBackupJob(ports, job.id);

    fileIO.seed("/mac", "Docs/plan.txt", "second draft");
    const second = await runBackupJob(ports, job.id);
    expect(second.copied).toBe(1);

    const [file] = await listLibrary(ports);
    const detail = (await getFileDetail(ports, file!.id))!;
    expect(detail.versions.map((version) => [version.version, version.current])).toEqual([
      [2, true],
      [1, false],
    ]);
    // "Kept on" lists copies of the current version only; the older one is still on the SSD.
    expect(detail.replicas.map((row) => `${row.drive.name}:${row.replica.relativePath}`).sort()).toEqual([
      "Mac:Docs/plan.txt",
      "SSD:Docs/plan (2).txt",
    ]);
    expect(detail.versions[1]!.copies.map((row) => `${row.drive.name}:${row.replica.relativePath}`)).toEqual([
      "SSD:Docs/plan.txt",
    ]);
    expect(text(await fileIO.read("/ssd", "Docs/plan.txt"))).toBe("first draft");

    const old = await openVersionFile(ports, file!.id, detail.versions[1]!.objectHash);
    expect(await readStream(await old!.open())).toBe("first draft");
    expect(await catalog.listFiles()).toHaveLength(1);
  });
});

describe("trash", () => {
  it("hides trashed files everywhere until they are restored", async () => {
    const { fileIO, ports, mac } = await setup();
    fileIO.seed("/mac", "a.jpg", "a", { takenAt: "2024-05-01T10:00:00" });
    fileIO.seed("/mac", "b.jpg", "b", { takenAt: "2024-05-01T11:00:00" });
    await ingestFolder(ports, { driveId: mac.id });
    const [a] = (await listLibrary(ports)).filter((file) => file.name === "a.jpg");

    expect(await trashFiles(ports, [a!.id])).toBe(1);
    expect((await listLibrary(ports)).map((file) => file.name)).toEqual(["b.jpg"]);
    expect((await listEvents(ports))[0]!.fileIds).toHaveLength(1);
    expect((await listTrash(ports)).map((file) => file.name)).toEqual(["a.jpg"]);

    // Scanning again does not bring a trashed file back.
    await ingestFolder(ports, { driveId: mac.id });
    expect((await listTrash(ports)).map((file) => file.name)).toEqual(["a.jpg"]);

    expect(await restoreFiles(ports, [a!.id])).toBe(1);
    expect(await listTrash(ports)).toEqual([]);
    expect(await listLibrary(ports)).toHaveLength(2);
  });

  it("deletes every copy, and waits for unplugged drives before deleting theirs", async () => {
    const { catalog, fileIO, volumes, ports, mac, ssd } = await setup();
    fileIO.seed("/mac", "old.jpg", "old");
    const job = await saveBackupJob(ports, { sourceDriveId: mac.id, destDriveId: ssd.id, sourceRelativePaths: [""] });
    await runBackupJob(ports, job.id);
    const [file] = await listLibrary(ports);

    volumes.disconnect("ssd");
    await syncDrivePresence(ports);
    await expect(deleteForever(ports, [file!.id])).resolves.toEqual({ deleted: 0, removed: 0, waiting: [] });
    await trashFiles(ports, [file!.id]);
    const result = await emptyTrash(ports);

    expect(result).toEqual({ deleted: 1, removed: 1, waiting: ["SSD"] });
    expect(await fileIO.exists("/mac", "old.jpg")).toBe(false);
    expect(await fileIO.exists("/ssd", "old.jpg")).toBe(true);
    expect(await catalog.getFile(file!.id)).toBeNull();

    volumes.connect({ volumeId: "ssd", mountPath: "/ssd", label: "SSD" });
    await syncDrivePresence(ports);
    expect(await fileIO.exists("/ssd", "old.jpg")).toBe(false);
    expect(await catalog.listPendingDeletions(ssd.id)).toEqual([]);
  });

  it("does not delete a waiting file that was replaced while the drive was away", async () => {
    const { catalog, fileIO, volumes, ports, mac, ssd } = await setup();
    fileIO.seed("/mac", "note.txt", "old");
    const job = await saveBackupJob(ports, { sourceDriveId: mac.id, destDriveId: ssd.id, sourceRelativePaths: [""] });
    await runBackupJob(ports, job.id);
    const [file] = await listLibrary(ports);
    volumes.disconnect("ssd");
    await syncDrivePresence(ports);
    await trashFiles(ports, [file!.id]);
    await emptyTrash(ports);

    fileIO.seed("/ssd", "note.txt", "something new, saved elsewhere");
    volumes.connect({ volumeId: "ssd", mountPath: "/ssd", label: "SSD" });
    await syncDrivePresence(ports);
    expect(text(await fileIO.read("/ssd", "note.txt"))).toBe("something new, saved elsewhere");
    expect(await catalog.listPendingDeletions(ssd.id)).toEqual([]);
  });
});

describe("export", () => {
  it("copies files into a folder without overwriting, and explains what it could not copy", async () => {
    const { fileIO, volumes, ports, mac, ssd } = await setup();
    fileIO.seed("/mac", "a.jpg", "photo a");
    fileIO.seed("/ssd", "b.jpg", "photo b");
    fileIO.seed("/export", "a.jpg", "already in the folder");
    await ingestFolder(ports, { driveId: mac.id });
    await ingestFolder(ports, { driveId: ssd.id });
    const files = await listLibrary(ports);
    volumes.disconnect("ssd");
    await syncDrivePresence(ports);

    const result = await exportFiles(ports, { fileIds: files.map((file) => file.id), rootPath: "/export" });

    expect(result.exported).toBe(1);
    expect(result.failed).toEqual([{ name: "b.jpg", reason: "Plug in SSD first" }]);
    expect(text(await fileIO.read("/export", "a.jpg"))).toBe("already in the folder");
    expect(text(await fileIO.read("/export", "a (2).jpg"))).toBe("photo a");
  });
});

describe("backup history", () => {
  it("records each run, including runs that could not start", async () => {
    const { catalog, fileIO, volumes, ports, mac, ssd } = await setup();
    fileIO.seed("/mac", "a.jpg", "a");
    const job = await saveBackupJob(ports, { sourceDriveId: mac.id, destDriveId: ssd.id, sourceRelativePaths: [""] });
    await runBackupJob(ports, job.id);
    volumes.disconnect("ssd");
    await syncDrivePresence(ports);
    await expect(runBackupJob(ports, job.id, { trigger: "auto" })).rejects.toThrow("Destination drive is offline");

    const runs = await catalog.listBackupRuns(10);
    expect(runs.map((run) => [run.trigger, run.status, run.copied])).toEqual([
      ["auto", "failed", 0],
      ["manual", "done", 1],
    ]);
    expect(runs[0]!.error).toBe("Destination drive is offline");
    expect(runs.every((run) => run.finishedAt)).toBe(true);
  });
});

describe("automatic backup", () => {
  it("runs when both places are connected and again when one is plugged back in", async () => {
    const { catalog, fileIO, volumes, ports, mac, ssd } = await setup();
    fileIO.seed("/mac", "a.jpg", "a");
    const job = await saveBackupJob(ports, { sourceDriveId: mac.id, destDriveId: ssd.id, sourceRelativePaths: [""] });
    const scheduler = new BackupScheduler(ports);
    const now = new Date();

    expect(await scheduler.tick(now)).toEqual([]);
    await setBackupAuto(ports, job.id, true);
    expect(await scheduler.tick(now)).toEqual([job.id]);
    expect(await fileIO.exists("/ssd", "a.jpg")).toBe(true);
    expect(await scheduler.tick(now)).toEqual([]);

    volumes.disconnect("ssd");
    expect(await scheduler.tick(now)).toEqual([]);
    fileIO.seed("/mac", "b.jpg", "b");
    volumes.connect({ volumeId: "ssd", mountPath: "/ssd", label: "SSD" });
    expect(await scheduler.tick(now)).toEqual([job.id]);
    expect(await fileIO.exists("/ssd", "b.jpg")).toBe(true);

    const later = new Date(now.getTime() + 2 * 60 * 60 * 1000);
    expect(await scheduler.tick(later)).toEqual([job.id]);
    expect((await catalog.listBackupRuns(10)).every((run) => run.trigger === "auto")).toBe(true);
  });
});
