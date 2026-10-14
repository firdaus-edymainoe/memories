import { MemoryCatalog, ingestFolder, listLibrary, registerDrive, runBackupJob, saveBackupJob, DestinationExistsError } from "@memories/core";
import { mkdtemp, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { NodeFileIO } from "./file-io.js";
import { DarwinVolumes } from "./volumes.js";

describe("fs-darwin", () => {
  it("refuses paths outside the registered folder", async () => {
    const io = new NodeFileIO();
    const root = await mkdtemp(join(tmpdir(), "mem-root-"));
    await expect(io.read(root, "../secret.txt")).rejects.toThrow(/escapes drive root/);
  });

  it("lists one folder level", async () => {
    const io = new NodeFileIO();
    const root = await mkdtemp(join(tmpdir(), "mem-list-"));
    await mkdir(join(root, "Wedding"), { recursive: true });
    await writeFile(join(root, "Wedding", "dance.jpg"), "wedding-bytes");
    await writeFile(join(root, "notes.txt"), "hello");
    const entries = await io.list(root);
    expect(entries.map((entry) => entry.name)).toEqual(["Wedding", "notes.txt"]);
    expect(entries[0]?.directory).toBe(true);
  });

  it("ingests and copies between two real folders", async () => {
    const source = await mkdtemp(join(tmpdir(), "mem-src-"));
    const dest = await mkdtemp(join(tmpdir(), "mem-dst-"));
    await mkdir(join(source, "Wedding"), { recursive: true });
    await writeFile(join(source, "Wedding", "dance.jpg"), "wedding-bytes");

    const ports = {
      catalog: new MemoryCatalog(),
      fileIO: new NodeFileIO(),
      volumes: new DarwinVolumes(),
    };
    const mac = await registerDrive(ports, { name: "This Mac", kind: "computer", rootPath: source });
    const usb = await registerDrive(ports, { name: "Travel USB", kind: "usb", rootPath: dest });
    await ingestFolder(ports, { driveId: mac.id });
    expect(await listLibrary(ports, { kind: "photo" })).toHaveLength(1);

    const job = await saveBackupJob(ports, {
      sourceDriveId: mac.id,
      destDriveId: usb.id,
      sourceRelativePaths: ["Wedding"],
    });
    const result = await runBackupJob(ports, job.id);
    expect(result.copied).toBe(1);
    expect(await readFile(join(dest, "Wedding", "dance.jpg"), "utf8")).toBe("wedding-bytes");

    const again = await runBackupJob(ports, job.id);
    expect(again.copied).toBe(0);
    expect(again.skipped).toBe(1);
  });
});

describe("NodeFileIO.copy", () => {
  it("refuses to overwrite and leaves no temp files behind", async () => {
    const io = new NodeFileIO();
    const source = await mkdtemp(join(tmpdir(), "mem-copy-src-"));
    const dest = await mkdtemp(join(tmpdir(), "mem-copy-dst-"));
    await writeFile(join(source, "a.jpg"), "new bytes");
    await mkdir(join(dest, "DCIM"), { recursive: true });
    await writeFile(join(dest, "DCIM", "a.jpg"), "precious bytes");

    await expect(
      io.copy({ fromRoot: source, fromRelative: "a.jpg", toRoot: dest, toRelative: "DCIM/a.jpg" }),
    ).rejects.toBeInstanceOf(DestinationExistsError);
    expect(await readFile(join(dest, "DCIM", "a.jpg"), "utf8")).toBe("precious bytes");

    await io.copy({ fromRoot: source, fromRelative: "a.jpg", toRoot: dest, toRelative: "DCIM/b.jpg" });
    expect(await readFile(join(dest, "DCIM", "b.jpg"), "utf8")).toBe("new bytes");
    expect((await readdir(join(dest, "DCIM"))).sort()).toEqual(["a.jpg", "b.jpg"]);
  });

  it("does not leave a file behind when the copy fails", async () => {
    const io = new NodeFileIO();
    const source = await mkdtemp(join(tmpdir(), "mem-copy-src-"));
    const dest = await mkdtemp(join(tmpdir(), "mem-copy-dst-"));
    await expect(
      io.copy({ fromRoot: source, fromRelative: "missing.jpg", toRoot: dest, toRelative: "x.jpg" }),
    ).rejects.toThrow();
    expect(await readdir(dest)).toEqual([]);
  });
});

describe("NodeFileIO.describe", () => {
  it("reads the capture date from a photo's EXIF and ignores files without one", async () => {
    const io = new NodeFileIO();
    const fixtures = join(import.meta.dirname, "..", "..", "..", "fixtures");
    const details = await io.describe(fixtures, "taken-2019-07-04.jpg");
    expect(new Date(details.takenAt!).getFullYear()).toBe(2019);
    expect(new Date(details.takenAt!).getMonth()).toBe(6);
    expect(await io.describe(fixtures, "notes.txt")).toEqual({});
  });
});

describe("ingest with real files", () => {
  it("dates photos by when they were taken, not when they were copied", async () => {
    const source = await mkdtemp(join(tmpdir(), "mem-exif-"));
    const fixture = await readFile(join(import.meta.dirname, "..", "..", "..", "fixtures", "taken-2019-07-04.jpg"));
    await writeFile(join(source, "IMG_0001.jpg"), fixture);
    const ports = { catalog: new MemoryCatalog(), fileIO: new NodeFileIO(), volumes: new DarwinVolumes() };
    const drive = await registerDrive(ports, { name: "Card", kind: "usb", rootPath: source });
    await ingestFolder(ports, { driveId: drive.id });
    const [photo] = await listLibrary(ports);
    expect(new Date(photo!.takenAt!).getFullYear()).toBe(2019);
  });
});
