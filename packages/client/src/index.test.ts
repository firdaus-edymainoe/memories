import { MemoryCatalog, MemoryFileIO, MemoryVolumes } from "@memories/core";
import { createApp } from "@memories/server";
import { describe, expect, it } from "vitest";
import { MemoriesClient } from "./index.js";

describe("MemoriesClient", () => {
  it("talks to createApp over fetch", async () => {
    const fileIO = new MemoryFileIO();
    const volumes = new MemoryVolumes();
    volumes.connect({ volumeId: "v", mountPath: "/M", label: "M" });
    fileIO.seed("/M/root", "a.jpg", "aaa", { takenAt: "2026-01-01T00:00:00" });
    const hono = createApp({ catalog: new MemoryCatalog(), fileIO, volumes });
    const original = globalThis.fetch;
    globalThis.fetch = (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      return hono.request(url.replace("http://local", ""), init);
    };
    try {
      const client = new MemoriesClient("http://local");
      const drive = await client.registerDrive({ name: "Mac", kind: "computer", rootPath: "/M/root", volumeId: "v" });
      await client.ingest(drive.id);
      expect(await client.files({ kind: "photo" })).toHaveLength(1);
      expect(await client.driveEntries(drive.id)).toEqual([
        { name: "a.jpg", relativePath: "a.jpg", directory: false, size: 3, kind: "photo" },
      ]);
      expect(client.driveMediaUrl(drive.id, "a.jpg")).toBe(`http://local/drives/${drive.id}/media?path=a.jpg`);
    } finally {
      globalThis.fetch = original;
    }
  });
});
