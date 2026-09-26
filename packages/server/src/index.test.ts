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

  it("copies a new file to another drive and relocates another", async () => {
    const { app, fileIO, volumes } = harness();
    volumes.connect({ volumeId: "mac", mountPath: "/Mac", label: "Mac" });
    volumes.connect({ volumeId: "usb", mountPath: "/USB", label: "USB" });
    fileIO.seed("/Mac/Family", "fresh.jpg", "fresh-photo");
    fileIO.seed("/Mac/Family", "shift.txt", "shift-doc");
    const mac = await (
      await app.request("/drives", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Mac", kind: "computer", rootPath: "/Mac/Family", volumeId: "mac" }),
      })
    ).json();
    const usb = await (
      await app.request("/drives", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "USB", kind: "usb", rootPath: "/USB/Backup", volumeId: "usb" }),
      })
    ).json();
    await app.request("/ingest", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ driveId: mac.drive.id }),
    });
    const { files } = await (await app.request("/files")).json();
    const photo = files.find((file: { name: string }) => file.name === "fresh.jpg");
    const doc = files.find((file: { name: string }) => file.name === "shift.txt");

    const copied = await app.request(`/files/${photo.id}/copy`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ destDriveId: usb.drive.id }),
    });
    expect(copied.status).toBe(200);
    expect(await fileIO.exists("/Mac/Family", "fresh.jpg")).toBe(true);
    expect(await fileIO.exists("/USB/Backup", "fresh.jpg")).toBe(true);

    const moved = await app.request(`/files/${doc.id}/relocate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ destDriveId: usb.drive.id, destRelativePath: "Inbox/shift.txt" }),
    });
    expect(moved.status).toBe(200);
    expect(await fileIO.exists("/Mac/Family", "shift.txt")).toBe(false);
    expect(await fileIO.exists("/USB/Backup", "Inbox/shift.txt")).toBe(true);

    const folder = await (
      await app.request("/folders", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Trip copies" }),
      })
    ).json();
    const assigned = await app.request(`/files/${photo.id}/move`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ folderId: folder.folder.id }),
    });
    expect(assigned.status).toBe(200);
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
          sourceRelativePaths: [""],
        }),
      })
    ).json();
    volumes.disconnect("b");
    await app.request("/sync", { method: "POST" });
    const run = await app.request(`/backups/${job.job.id}/run`, { method: "POST" });
    expect(run.status).toBe(400);
  });
});
