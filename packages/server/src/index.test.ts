import { MemoryCatalog, MemoryFileIO, MemoryVolumes } from "@memories/core";
import { describe, expect, it } from "vitest";
import { createApp } from "./index.js";

function harness() {
  const fileIO = new MemoryFileIO();
  const volumes = new MemoryVolumes();
  const catalog = new MemoryCatalog();
  const app = createApp({ catalog, fileIO, volumes });
  return { app, fileIO, volumes };
}

describe("createApp", () => {
  it("registers a folder, ingests, and lists photos", async () => {
    const { app, fileIO, volumes } = harness();
    volumes.connect({ volumeId: "vol-mac", mountPath: "/Mac", label: "Mac" });
    fileIO.seed("/Mac/Family", "hero.jpg", "hero-bytes", { takenAt: "2025-08-12T10:00:00", place: "Kuala Lumpur" });

    const created = await app.request("/drives", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "This Mac",
        kind: "computer",
        rootPath: "/Mac/Family",
        volumeId: "vol-mac",
      }),
    });
    expect(created.status).toBe(201);
    const { drive } = await created.json();

    const ingested = await app.request("/ingest", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ driveId: drive.id }),
    });
    expect(ingested.status).toBe(200);

    const listed = await app.request("/files?kind=photo");
    const { files } = await listed.json();
    expect(files).toHaveLength(1);

    const events = await app.request("/events");
    const body = await events.json();
    expect(body.events[0].place).toBe("Kuala Lumpur");

    const media = await app.request(`/files/${files[0].id}/media`);
    expect(media.status).toBe(200);
    expect(await media.text()).toBe("hero-bytes");

    const entries = await app.request(`/drives/${drive.id}/entries`);
    const listedEntries = await entries.json();
    expect(listedEntries.entries).toEqual([
      { name: "hero.jpg", relativePath: "hero.jpg", directory: false, size: 10, kind: "photo" },
    ]);

    const driveMedia = await app.request(`/drives/${drive.id}/media?path=hero.jpg`);
    expect(driveMedia.status).toBe(200);
    expect(driveMedia.headers.get("content-type")).toBe("image/jpeg");
    expect(await driveMedia.text()).toBe("hero-bytes");
  });

  it("rejects backup when destination is offline", async () => {
    const { app, volumes } = harness();
    volumes.connect({ volumeId: "a", mountPath: "/A", label: "A" });
    volumes.connect({ volumeId: "b", mountPath: "/B", label: "B" });
    const a = await (
      await app.request("/drives", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "A", kind: "computer", rootPath: "/A/x", volumeId: "a" }),
      })
    ).json();
    const b = await (
      await app.request("/drives", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "B", kind: "disk", rootPath: "/B/x", volumeId: "b" }),
      })
    ).json();
    const job = await (
      await app.request("/backups", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sourceDriveId: a.drive.id,
          destDriveId: b.drive.id,
          sourceRelativePaths: [],
        }),
      })
    ).json();
    volumes.disconnect("b");
    await app.request("/sync", { method: "POST" });
    const run = await app.request(`/backups/${job.job.id}/run`, { method: "POST" });
    expect(run.status).toBe(400);
  });
});
