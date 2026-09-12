import { MemoryFileIO, MemoryVolumes, ingestFolder, listLibrary, registerDrive } from "@memories/core";
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
