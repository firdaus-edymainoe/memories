import { MemoryCatalog, MemoryFileIO, MemoryVolumes } from "@memories/core";
import { describe, expect, it } from "vitest";
import { type AppOptions, createApp } from "./index.js";

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

describe("local security", () => {
  function secured(pickFolder?: () => Promise<string | null>) {
    const fileIO = new MemoryFileIO();
    const volumes = new MemoryVolumes();
    const app = createApp({ catalog: new MemoryCatalog(), fileIO, volumes }, { token: "secret", ...(pickFolder ? { pickFolder } : {}) });
    return { app, fileIO, volumes };
  }

  it("requires the launch token, except for the health check", async () => {
    const { app } = secured();
    expect((await app.request("/health")).status).toBe(200);
    expect((await app.request("/drives")).status).toBe(401);
    expect((await app.request("/drives", { headers: { "x-memories-token": "wrong" } })).status).toBe(401);
    expect((await app.request("/drives", { headers: { "x-memories-token": "secret" } })).status).toBe(200);
    expect((await app.request("/drives?token=secret")).status).toBe(200);
  });

  it("rejects other host names and foreign origins", async () => {
    const { app } = secured();
    const headers = { "x-memories-token": "secret" };
    expect((await app.request("http://attacker.example/drives", { headers })).status).toBe(403);
    expect((await app.request("/drives", { headers: { ...headers, origin: "https://evil.example" } })).status).toBe(403);
    expect((await app.request("/drives", { headers: { ...headers, origin: "http://127.0.0.1:5173" } })).status).toBe(200);
  });

  it("opens the native folder picker only when the desktop shell provides one", async () => {
    const headers = { "x-memories-token": "secret" };
    expect((await secured().app.request("/pick-folder", { method: "POST", headers })).status).toBe(501);
    const picked = await secured(async () => "/Users/me/Pictures").app.request("/pick-folder", { method: "POST", headers });
    expect(await picked.json()).toEqual({ rootPath: "/Users/me/Pictures" });
  });
});

describe("media", () => {
  it("serves byte ranges so videos can seek, and sandboxes scriptable files", async () => {
    const { app, fileIO, volumes } = harness();
    volumes.connect({ volumeId: "v", mountPath: "/V", label: "V" });
    fileIO.seed("/V/root", "clip.mp4", "0123456789");
    fileIO.seed("/V/root", "page.html", "<script>alert(1)</script>");
    const created = await app.request("/drives", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "V", kind: "disk", rootPath: "/V/root", volumeId: "v" }),
    });
    const { drive } = await created.json();

    const full = await app.request(`/drives/${drive.id}/media?path=clip.mp4`);
    expect(full.headers.get("accept-ranges")).toBe("bytes");
    expect(full.headers.get("content-security-policy")).toBeNull();

    const partial = await app.request(`/drives/${drive.id}/media?path=clip.mp4`, { headers: { range: "bytes=4-" } });
    expect(partial.status).toBe(206);
    expect(partial.headers.get("content-range")).toBe("bytes 4-9/10");
    expect(await partial.text()).toBe("456789");

    const beyond = await app.request(`/drives/${drive.id}/media?path=clip.mp4`, { headers: { range: "bytes=50-" } });
    expect(beyond.status).toBe(416);

    const page = await app.request(`/drives/${drive.id}/media?path=page.html`);
    expect(page.headers.get("content-security-policy")).toContain("sandbox");
  });
});

describe("thumbnails", () => {
  async function withPhoto(thumbnail?: AppOptions["thumbnail"]) {
    const fileIO = new MemoryFileIO();
    const volumes = new MemoryVolumes();
    volumes.connect({ volumeId: "v", mountPath: "/V", label: "V" });
    fileIO.seed("/V/root", "big.jpg", "full-size-original");
    const app = createApp({ catalog: new MemoryCatalog(), fileIO, volumes }, thumbnail ? { thumbnail } : {});
    const created = await app.request("/drives", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "V", kind: "disk", rootPath: "/V/root", volumeId: "v" }),
    });
    const { drive } = await created.json();
    await app.request("/ingest", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ driveId: drive.id }),
    });
    const { files } = await (await app.request("/files")).json();
    return { app, driveId: drive.id as string, fileId: files[0].id as string };
  }

  it("serves the shell's preview, cached for good, keyed by content", async () => {
    const seen: Array<string | null> = [];
    const { app, fileId, driveId } = await withPhoto(async ({ cacheKey }) => {
      seen.push(cacheKey);
      return { bytes: new TextEncoder().encode("tiny"), mime: "image/jpeg" };
    });
    const thumb = await app.request(`/files/${fileId}/thumb`);
    expect(await thumb.text()).toBe("tiny");
    expect(thumb.headers.get("cache-control")).toContain("immutable");
    expect(seen[0]).toMatch(/\w+/);

    const browsed = await app.request(`/drives/${driveId}/thumb?path=big.jpg`);
    expect(await browsed.text()).toBe("tiny");
    expect(seen[1]).toBeNull();
  });

  it("falls back to the original when no preview is available", async () => {
    const { app, fileId, driveId } = await withPhoto();
    expect(await (await app.request(`/files/${fileId}/thumb`)).text()).toBe("full-size-original");
    expect(await (await app.request(`/drives/${driveId}/thumb?path=big.jpg`)).text()).toBe("full-size-original");
  });
});

describe("library features over HTTP", () => {
  it("trashes, restores, exports and reports backup history", async () => {
    const { app, fileIO, volumes } = harness();
    volumes.connect({ volumeId: "a", mountPath: "/A", label: "A" });
    volumes.connect({ volumeId: "b", mountPath: "/B", label: "B" });
    fileIO.seed("/A", "photo.jpg", "bytes");
    const post = (path: string, body: unknown = {}) =>
      app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const a = (await (await post("/drives", { name: "A", kind: "disk", rootPath: "/A", volumeId: "a" })).json()).drive;
    const b = (await (await post("/drives", { name: "B", kind: "disk", rootPath: "/B", volumeId: "b" })).json()).drive;
    await post("/ingest", { driveId: a.id });
    const { files } = await (await app.request("/files")).json();

    expect(await (await post("/trash", { fileIds: [files[0].id] })).json()).toEqual({ moved: 1 });
    expect((await (await app.request("/files")).json()).files).toEqual([]);
    expect((await (await app.request("/trash")).json()).files).toHaveLength(1);
    expect(await (await post("/trash/restore", { fileIds: [files[0].id] })).json()).toEqual({ restored: 1 });

    const exported = await (await post("/export", { fileIds: [files[0].id], rootPath: "/Out" })).json();
    expect(exported).toEqual({ exported: 1, failed: [] });
    expect(await fileIO.exists("/Out", "photo.jpg")).toBe(true);

    const { job } = await (await post("/backups", { sourceDriveId: a.id, destDriveId: b.id, sourceRelativePaths: [""] })).json();
    expect((await (await post(`/backups/${job.id}/auto`, { auto: true })).json()).job.auto).toBe(true);
    expect(await (await post(`/backups/${job.id}/run`)).json()).toEqual({ copied: 1, skipped: 0, failed: 0 });
    const { runs } = await (await app.request("/backup-runs")).json();
    expect(runs).toEqual([expect.objectContaining({ jobId: job.id, trigger: "manual", status: "done", copied: 1 })]);
  });
});
