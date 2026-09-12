import { MemoryCatalog, ingestFolder, listLibrary, registerDrive, runBackupJob, saveBackupJob } from "@memories/core";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
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
