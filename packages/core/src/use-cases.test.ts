import { describe, expect, it } from "vitest";
import { MemoryCatalog, MemoryFileIO, MemoryVolumes } from "./memory.js";
import { relativeInsideRoot } from "./paths.js";
import type { Ports } from "./ports.js";
import {
  ingestFolder,
  listDriveEntries,
  listDrives,
  readDriveBytes,
  listEvents,
  listLibrary,
  registerDrive,
  runBackupJob,
  saveBackupJob,
  syncDrivePresence,
} from "./use-cases.js";

function app(): Ports & { fileIO: MemoryFileIO; volumes: MemoryVolumes } {
  const fileIO = new MemoryFileIO();
  const volumes = new MemoryVolumes();
  return { catalog: new MemoryCatalog(), fileIO, volumes };
}

describe("relativeInsideRoot", () => {
  it("rejects parent segments", () => {
    expect(() => relativeInsideRoot("../secret")).toThrow(/escapes drive root/);
  });

  it("normalizes slashes", () => {
    expect(relativeInsideRoot("Wedding/\\hero.jpg")).toBe("Wedding/hero.jpg");
  });
});

describe("registerDrive + presence", () => {
  it("registers a folder root, not a whole disk", async () => {
    const ports = app();
    ports.volumes.connect({ volumeId: "vol-mac", mountPath: "/Users/aisha", label: "Macintosh HD" });
    const drive = await registerDrive(ports, {
      name: "This Mac",
      kind: "computer",
      rootPath: "/Users/aisha/Pictures/Family",
      volumeId: "vol-mac",
    });
    expect(drive.rootPath).toBe("/Users/aisha/Pictures/Family");
    expect(drive.online).toBe(true);
  });

  it("keeps two folders on the same volume as two drives", async () => {
    const ports = app();
    ports.volumes.connect({ volumeId: "vol-mac", mountPath: "/Users/aisha", label: "Macintosh HD" });
    const pictures = await registerDrive(ports, {
      name: "Pictures",
      kind: "computer",
      rootPath: "/Users/aisha/Pictures",
      volumeId: "vol-mac",
    });
    const documents = await registerDrive(ports, {
      name: "Documents",
      kind: "computer",
      rootPath: "/Users/aisha/Documents",
      volumeId: "vol-mac",
    });
    expect(documents.id).not.toBe(pictures.id);
    expect(await ports.catalog.listDrives()).toHaveLength(2);
  });

  it("reuses a phone already registered on that volume", async () => {
    const ports = app();
    ports.volumes.connect({ volumeId: "mtp:4e8:6860", mountPath: "mtp://04e8-6860", label: "SAMSUNG Android" });
    const first = await registerDrive(ports, {
      name: "SAMSUNG Android",
      kind: "phone",
      rootPath: "mtp://04e8-6860/DCIM",
      volumeId: "mtp:4e8:6860",
    });
    const second = await registerDrive(ports, {
      name: "SAMSUNG Android",
      kind: "phone",
      rootPath: "mtp://04e8-6860/DCIM",
      volumeId: "mtp:4e8:6860",
    });
    expect(second.id).toBe(first.id);
    expect(first.rootPath).toBe("mtp://04e8-6860");
    expect(second.rootPath).toBe("mtp://04e8-6860");
    expect(await ports.catalog.listDrives()).toHaveLength(1);
  });

  it("opens a Camera-only phone drive at storage root", async () => {
    const ports = app();
    ports.volumes.connect({ volumeId: "mtp:4e8:6860", mountPath: "mtp://04e8-6860", label: "SAMSUNG Android" });
    ports.fileIO.seed("mtp://04e8-6860", "DCIM/Camera/a.jpg", "photo");
    ports.fileIO.seed("mtp://04e8-6860", "Download/file.pdf", "doc");
    await ports.catalog.upsertDrive({
      id: "drv_phone",
      name: "SAMSUNG Android",
      kind: "phone",
      rootPath: "mtp://04e8-6860/DCIM",
      volumeId: "mtp:4e8:6860",
      online: true,
    });
    const [drive] = await listDrives(ports);
    expect(drive?.rootPath).toBe("mtp://04e8-6860");
    const entries = await listDriveEntries(ports, drive!.id, "");
    expect(entries.filter((entry) => entry.directory).map((entry) => entry.name)).toEqual(["DCIM", "Download"]);
  });

  it("keeps a phone online when the volume id omits the serial", async () => {
    const ports = app();
    ports.volumes.connect({ volumeId: "mtp:4e8:6860", mountPath: "mtp://04e8-6860", label: "SAMSUNG Android" });
    const drive = await registerDrive(ports, {
      name: "SAMSUNG Android",
      kind: "phone",
      rootPath: "mtp://04e8-6860.R5CY2232HMY",
      volumeId: "mtp:4e8:6860:R5CY2232HMY",
    });
    await syncDrivePresence(ports);
    expect((await ports.catalog.getDrive(drive.id))?.online).toBe(true);
  });

  it("keeps catalog rows when the volume unplugs", async () => {
    const ports = app();
    ports.volumes.connect({ volumeId: "vol-ssd", mountPath: "/Volumes/Summer", label: "Summer SSD" });
    const drive = await registerDrive(ports, {
      name: "Summer SSD",
      kind: "disk",
      rootPath: "/Volumes/Summer/Memories",
      volumeId: "vol-ssd",
    });
    ports.fileIO.seed(drive.rootPath, "dance.jpg", "bytes-a", { takenAt: "2025-08-12T18:00:00" });
    await ingestFolder(ports, { driveId: drive.id });

    ports.volumes.disconnect("vol-ssd");
    await syncDrivePresence(ports);

    const after = await ports.catalog.getDrive(drive.id);
    expect(after?.online).toBe(false);
    expect(await listLibrary(ports, { kind: "photo" })).toHaveLength(1);
  });
});

describe("listDriveEntries", () => {
  it("lists one folder level without walking the tree", async () => {
    const ports = app();
    ports.volumes.connect({ volumeId: "vol-mac", mountPath: "/Mac", label: "Mac" });
    ports.fileIO.seed("/Mac/Family", "DCIM/Camera/a.jpg", "photo");
    ports.fileIO.seed("/Mac/Family", "Download/notes.pdf", "doc");
    const drive = await registerDrive(ports, {
      name: "This Mac",
      kind: "computer",
      rootPath: "/Mac/Family",
      volumeId: "vol-mac",
    });
    const root = await listDriveEntries(ports, drive.id, "");
    expect(root.filter((entry) => entry.directory).map((entry) => entry.name)).toEqual(["DCIM", "Download"]);
    const dcim = await listDriveEntries(ports, drive.id, "DCIM");
    expect(dcim).toEqual([
      { name: "Camera", relativePath: "DCIM/Camera", directory: true, size: 0, kind: null },
    ]);
  });
});

describe("readDriveBytes", () => {
  it("reads a file on an online drive without ingest", async () => {
    const ports = app();
    ports.volumes.connect({ volumeId: "vol-mac", mountPath: "/Mac", label: "Mac" });
    ports.fileIO.seed("/Mac/Family", "DCIM/hero.png", "png-bytes");
    const drive = await registerDrive(ports, {
      name: "This Mac",
      kind: "computer",
      rootPath: "/Mac/Family",
      volumeId: "vol-mac",
    });
    const media = await readDriveBytes(ports, drive.id, "DCIM/hero.png");
    expect(media.name).toBe("hero.png");
    expect(media.mime).toBe("image/png");
    expect(new TextDecoder().decode(media.bytes)).toBe("png-bytes");
  });

  it("refuses a path that leaves the drive folder", async () => {
    const ports = app();
    ports.volumes.connect({ volumeId: "vol-mac", mountPath: "/Mac", label: "Mac" });
    const drive = await registerDrive(ports, {
      name: "This Mac",
      kind: "computer",
      rootPath: "/Mac/Family",
      volumeId: "vol-mac",
    });
    await expect(readDriveBytes(ports, drive.id, "../secret.jpg")).rejects.toThrow(/escapes drive root/);
  });
});

describe("ingestFolder", () => {
  it("collapses the same bytes on two drives into one file and two replicas", async () => {
    const ports = app();
    ports.volumes.connect({ volumeId: "vol-mac", mountPath: "/Mac", label: "Mac" });
    ports.volumes.connect({ volumeId: "vol-ssd", mountPath: "/SSD", label: "SSD" });
    const mac = await registerDrive(ports, {
      name: "This Mac",
      kind: "computer",
      rootPath: "/Mac/Family",
      volumeId: "vol-mac",
    });
    const ssd = await registerDrive(ports, {
      name: "Summer SSD",
      kind: "disk",
      rootPath: "/SSD/Memories",
      volumeId: "vol-ssd",
    });

    ports.fileIO.seed(mac.rootPath, "Wedding/dance.jpg", "same-photo", {
      takenAt: "2025-08-12T18:00:00",
      place: "Kuala Lumpur",
    });
    ports.fileIO.seed(ssd.rootPath, "backup/dance.jpg", "same-photo", {
      takenAt: "2025-08-12T18:00:00",
      place: "Kuala Lumpur",
    });

    await ingestFolder(ports, { driveId: mac.id });
    await ingestFolder(ports, { driveId: ssd.id });

    const photos = await listLibrary(ports, { kind: "photo" });
    expect(photos).toHaveLength(1);
    const replicas = await ports.catalog.listReplicas(photos[0]!.id);
    expect(replicas).toHaveLength(2);
    expect(replicas.map((r) => r.driveId).sort()).toEqual([mac.id, ssd.id].sort());
  });
});

describe("listEvents", () => {
  it("clusters photos and videos by day and place", async () => {
    const ports = app();
    ports.volumes.connect({ volumeId: "vol-mac", mountPath: "/Mac", label: "Mac" });
    const mac = await registerDrive(ports, {
      name: "This Mac",
      kind: "computer",
      rootPath: "/Mac/Family",
      volumeId: "vol-mac",
    });
    ports.fileIO.seed(mac.rootPath, "dance.jpg", "a", {
      takenAt: "2025-08-12T18:00:00",
      place: "Kuala Lumpur",
    });
    ports.fileIO.seed(mac.rootPath, "vows.jpg", "b", {
      takenAt: "2025-08-12T19:00:00",
      place: "Kuala Lumpur",
    });
    ports.fileIO.seed(mac.rootPath, "notes.txt", "c", { takenAt: "2025-08-12T20:00:00" });
    await ingestFolder(ports, { driveId: mac.id });

    const events = await listEvents(ports);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ day: "2025-08-12", place: "Kuala Lumpur" });
    expect(events[0]!.fileIds).toHaveLength(2);
  });
});

describe("placeFile", () => {
  it("clears inbox without creating a new file", async () => {
    const ports = app();
    ports.volumes.connect({ volumeId: "vol-mac", mountPath: "/Mac", label: "Mac" });
    const mac = await registerDrive(ports, {
      name: "This Mac",
      kind: "computer",
      rootPath: "/Mac/Family",
      volumeId: "vol-mac",
    });
    ports.fileIO.seed(mac.rootPath, "park.jpg", "park", { takenAt: "2026-03-24T12:00:00" });
    await ingestFolder(ports, { driveId: mac.id });
    const [file] = await listLibrary(ports, { inbox: true });
    expect(file).toBeTruthy();
    const { placeFile } = await import("./use-cases.js");
    await placeFile(ports, file!.id);
    expect(await listLibrary(ports, { inbox: true })).toHaveLength(0);
  });
});

describe("backup", () => {
  it("copies missing hashes only", async () => {
    const ports = app();
    ports.volumes.connect({ volumeId: "vol-mac", mountPath: "/Mac", label: "Mac" });
    ports.volumes.connect({ volumeId: "vol-usb", mountPath: "/USB", label: "USB" });
    const mac = await registerDrive(ports, {
      name: "This Mac",
      kind: "computer",
      rootPath: "/Mac/Family",
      volumeId: "vol-mac",
    });
    const usb = await registerDrive(ports, {
      name: "Travel USB",
      kind: "usb",
      rootPath: "/USB/Memories",
      volumeId: "vol-usb",
    });

    ports.fileIO.seed(mac.rootPath, "a.jpg", "photo-a", { takenAt: "2026-01-01T00:00:00" });
    ports.fileIO.seed(mac.rootPath, "b.jpg", "photo-b", { takenAt: "2026-01-02T00:00:00" });
    await ingestFolder(ports, { driveId: mac.id });

    const job = await saveBackupJob(ports, {
      sourceDriveId: mac.id,
      destDriveId: usb.id,
      sourceRelativePaths: [],
    });

    const first = await runBackupJob(ports, job.id);
    expect(first.copied).toBe(2);
    expect(await ports.fileIO.exists(usb.rootPath, "a.jpg")).toBe(true);

    const second = await runBackupJob(ports, job.id);
    expect(second.copied).toBe(0);
    expect(second.skipped).toBe(2);
  });

  it("does not run when the destination is unplugged", async () => {
    const ports = app();
    ports.volumes.connect({ volumeId: "vol-mac", mountPath: "/Mac", label: "Mac" });
    ports.volumes.connect({ volumeId: "vol-usb", mountPath: "/USB", label: "USB" });
    const mac = await registerDrive(ports, {
      name: "This Mac",
      kind: "computer",
      rootPath: "/Mac/Family",
      volumeId: "vol-mac",
    });
    const usb = await registerDrive(ports, {
      name: "Travel USB",
      kind: "usb",
      rootPath: "/USB/Memories",
      volumeId: "vol-usb",
    });
    const job = await saveBackupJob(ports, {
      sourceDriveId: mac.id,
      destDriveId: usb.id,
      sourceRelativePaths: [],
    });
    ports.volumes.disconnect("vol-usb");
    await syncDrivePresence(ports);
    await expect(runBackupJob(ports, job.id)).rejects.toThrow(/offline/);
  });
});
