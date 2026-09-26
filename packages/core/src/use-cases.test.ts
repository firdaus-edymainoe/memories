import {
  copyFileToDrive,
  createVirtualFolder,
  ingestFolder,
  listLibrary,
  moveToFolder,
  pruneBackupPaths,
  registerDrive,
  relocateFile,
  runBackupJob,
  saveBackupJob,
  syncDrivePresence,
} from "./use-cases.js";
import { MemoryCatalog, MemoryFileIO, MemoryVolumes } from "./memory.js";
import type { FileIO, Ports } from "./ports.js";
import { describe, expect, it } from "vitest";

describe("ingestFolder", () => {
  it("skips a file that cannot be hashed and keeps indexing the rest", async () => {
    const catalog = new MemoryCatalog();
    const inner = new MemoryFileIO();
    const volumes = new MemoryVolumes();
    const root = "/phone";
    inner.seed(root, "DCIM/Camera/ok.jpg", "good");
    inner.seed(root, "DCIM/Camera/bad.jpg", "fail");
    volumes.connect({ volumeId: "mtp:18d1:4ee2", mountPath: root, label: "Pixel" });
    const fileIO: FileIO = {
      walk: (driveRoot, subPath) => inner.walk(driveRoot, subPath),
      list: (driveRoot, subPath) => inner.list(driveRoot, subPath),
      hash: async (driveRoot, relativePath) => {
        if (relativePath.endsWith("bad.jpg")) throw new Error("MTP error 0x2009");
        return inner.hash(driveRoot, relativePath);
      },
      read: (driveRoot, relativePath) => inner.read(driveRoot, relativePath),
      exists: (driveRoot, relativePath) => inner.exists(driveRoot, relativePath),
      mkdir: (driveRoot, relativePath) => inner.mkdir(driveRoot, relativePath),
      copy: (args) => inner.copy(args),
      remove: (driveRoot, relativePath) => inner.remove(driveRoot, relativePath),
    };
    const ports: Ports = { catalog, fileIO, volumes };
    const drive = await registerDrive(ports, { name: "Phone", kind: "phone", rootPath: root });
    const result = await ingestFolder(ports, { driveId: drive.id, relativePath: "DCIM/Camera" });
    expect(result.files).toBe(1);
    expect(result.replicas).toBe(1);
    expect((await catalog.listFiles()).map((file) => file.name)).toEqual(["ok.jpg"]);
  });

  it("registers two folders on the same phone as two drives", async () => {
    const catalog = new MemoryCatalog();
    const fileIO = new MemoryFileIO();
    const volumes = new MemoryVolumes();
    volumes.connect({ volumeId: "mtp:18d1:4ee2", mountPath: "/phone", label: "Pixel" });
    const ports: Ports = { catalog, fileIO, volumes };
    const camera = await registerDrive(ports, {
      name: "Camera",
      kind: "phone",
      rootPath: "/phone/DCIM/Camera",
      volumeId: "mtp:18d1:4ee2",
    });
    const shots = await registerDrive(ports, {
      name: "Screenshots",
      kind: "phone",
      rootPath: "/phone/DCIM/Screenshots",
      volumeId: "mtp:18d1:4ee2",
    });
    expect(camera.id).not.toBe(shots.id);
    expect((await catalog.listDrives()).map((drive) => drive.rootPath).sort()).toEqual([
      "/phone/DCIM/Camera",
      "/phone/DCIM/Screenshots",
    ]);
  });
});

describe("copy and move", () => {
  it("copies a new file onto another drive and relocates another", async () => {
    const catalog = new MemoryCatalog();
    const fileIO = new MemoryFileIO();
    const volumes = new MemoryVolumes();
    volumes.connect({ volumeId: "mac", mountPath: "/Mac", label: "Mac" });
    volumes.connect({ volumeId: "usb", mountPath: "/USB", label: "USB" });
    fileIO.seed("/Mac/Family", "e2e/copy-me.jpg", "copy-bytes");
    fileIO.seed("/Mac/Family", "e2e/move-me.txt", "move-bytes");
    const ports: Ports = { catalog, fileIO, volumes };
    const mac = await registerDrive(ports, { name: "Mac", kind: "computer", rootPath: "/Mac/Family", volumeId: "mac" });
    const usb = await registerDrive(ports, { name: "USB", kind: "usb", rootPath: "/USB/Backup", volumeId: "usb" });
    await ingestFolder(ports, { driveId: mac.id, relativePath: "e2e" });
    const files = await listLibrary(ports);
    const photo = files.find((file) => file.name === "copy-me.jpg")!;
    const doc = files.find((file) => file.name === "move-me.txt")!;

    const copied = await copyFileToDrive(ports, { fileId: photo.id, destDriveId: usb.id });
    expect(copied.relativePath).toBe("e2e/copy-me.jpg");
    expect(await fileIO.read("/USB/Backup", "e2e/copy-me.jpg").then((bytes) => new TextDecoder().decode(bytes))).toBe(
      "copy-bytes",
    );
    expect(await fileIO.exists("/Mac/Family", "e2e/copy-me.jpg")).toBe(true);

    const moved = await relocateFile(ports, {
      fileId: doc.id,
      destDriveId: usb.id,
      destRelativePath: "Inbox/move-me.txt",
    });
    expect(moved.relativePath).toBe("Inbox/move-me.txt");
    expect(await fileIO.exists("/Mac/Family", "e2e/move-me.txt")).toBe(false);
    expect(await fileIO.read("/USB/Backup", "Inbox/move-me.txt").then((bytes) => new TextDecoder().decode(bytes))).toBe(
      "move-bytes",
    );
    expect(await catalog.listReplicas(doc.id)).toEqual([
      expect.objectContaining({ driveId: usb.id, relativePath: "Inbox/move-me.txt" }),
    ]);

    const folder = await createVirtualFolder(ports, { name: "Trip copies" });
    await moveToFolder(ports, photo.id, folder.id);
    expect(await catalog.listFileIdsInFolder(folder.id)).toEqual([photo.id]);
  });
});

describe("backup folders", () => {
  it("keeps a parent folder and drops folders inside it", () => {
    expect(pruneBackupPaths(["DCIM", "DCIM/Camera", "Download"])).toEqual(["DCIM", "Download"]);
    expect(pruneBackupPaths(["", "DCIM/Camera"])).toEqual([""]);
  });

  it("copies only the folders you selected", async () => {
    const catalog = new MemoryCatalog();
    const fileIO = new MemoryFileIO();
    const volumes = new MemoryVolumes();
    volumes.connect({ volumeId: "phone", mountPath: "/phone", label: "Pixel" });
    volumes.connect({ volumeId: "ssd", mountPath: "/ssd", label: "SSD" });
    fileIO.seed("/phone", "DCIM/Camera/shot.jpg", "camera-bytes");
    fileIO.seed("/phone", "Download/notes.pdf", "notes-bytes");
    const ports: Ports = { catalog, fileIO, volumes };
    const phone = await registerDrive(ports, { name: "Pixel", kind: "phone", rootPath: "/phone", volumeId: "phone" });
    const ssd = await registerDrive(ports, { name: "SSD", kind: "disk", rootPath: "/ssd", volumeId: "ssd" });
    await ingestFolder(ports, { driveId: phone.id });
    const job = await saveBackupJob(ports, {
      sourceDriveId: phone.id,
      destDriveId: ssd.id,
      sourceRelativePaths: ["DCIM/Camera", "DCIM"],
    });
    expect(job.sourceRelativePaths).toEqual(["DCIM"]);
    const result = await runBackupJob(ports, job.id);
    expect(result.copied).toBe(1);
    expect(await fileIO.exists("/ssd", "DCIM/Camera/shot.jpg")).toBe(true);
    expect(await fileIO.exists("/ssd", "Download/notes.pdf")).toBe(false);
  });

  it("copies a file added after the backup was saved", async () => {
    const catalog = new MemoryCatalog();
    const fileIO = new MemoryFileIO();
    const volumes = new MemoryVolumes();
    volumes.connect({ volumeId: "phone", mountPath: "/phone", label: "Pixel" });
    volumes.connect({ volumeId: "ssd", mountPath: "/ssd", label: "SSD" });
    fileIO.seed("/phone", "Photos/old.jpg", "old-bytes");
    const ports: Ports = { catalog, fileIO, volumes };
    const phone = await registerDrive(ports, { name: "Pixel", kind: "phone", rootPath: "/phone", volumeId: "phone" });
    const ssd = await registerDrive(ports, { name: "SSD", kind: "disk", rootPath: "/ssd", volumeId: "ssd" });
    await ingestFolder(ports, { driveId: phone.id, relativePath: "Photos" });
    const job = await saveBackupJob(ports, {
      sourceDriveId: phone.id,
      destDriveId: ssd.id,
      sourceRelativePaths: ["Photos"],
    });
    volumes.disconnect("phone");
    await syncDrivePresence(ports);
    await expect(runBackupJob(ports, job.id)).rejects.toThrow("Source drive is offline");
    volumes.connect({ volumeId: "phone", mountPath: "/phone", label: "Pixel" });
    await syncDrivePresence(ports);
    fileIO.seed("/phone", "Photos/new.jpg", "new-bytes");
    const result = await runBackupJob(ports, job.id);
    expect(result.copied).toBe(2);
    expect(await fileIO.exists("/ssd", "Photos/new.jpg")).toBe(true);
  });

  it("refuses a backup with no folder selected", async () => {
    const catalog = new MemoryCatalog();
    const fileIO = new MemoryFileIO();
    const volumes = new MemoryVolumes();
    volumes.connect({ volumeId: "a", mountPath: "/A", label: "A" });
    volumes.connect({ volumeId: "b", mountPath: "/B", label: "B" });
    const ports: Ports = { catalog, fileIO, volumes };
    const a = await registerDrive(ports, { name: "A", kind: "computer", rootPath: "/A/x", volumeId: "a" });
    const b = await registerDrive(ports, { name: "B", kind: "disk", rootPath: "/B/x", volumeId: "b" });
    await expect(saveBackupJob(ports, { sourceDriveId: a.id, destDriveId: b.id, sourceRelativePaths: [] })).rejects.toThrow(
      "Choose a folder to copy",
    );
  });
});
