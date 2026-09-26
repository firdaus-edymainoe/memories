import {
  copyFileToDrive,
  ingestFolder,
  listLibrary,
  registerDrive,
  relocateFile,
  runBackupJob,
  saveBackupJob,
} from "@memories/core";
import { SwitchFileIO } from "@memories/fs-android";
import { createApp } from "@memories/server";
import { access, mkdtemp, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createLocalPorts } from "./host.js";

async function exists(path: string) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

describe("desktop host", () => {
  it("wires sqlite + this OS file adapter + Android", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mem-host-"));
    const ports = await createLocalPorts(join(dir, "catalog.sqlite"));
    expect(ports.fileIO).toBeInstanceOf(SwitchFileIO);

    const source = await mkdtemp(join(tmpdir(), "mem-host-src-"));
    const dest = await mkdtemp(join(tmpdir(), "mem-host-dst-"));
    await mkdir(join(source, "Pics"), { recursive: true });
    await writeFile(join(source, "Pics", "a.jpg"), "aaaa");

    const from = await registerDrive(ports, { name: "Mac", kind: "computer", rootPath: source });
    const to = await registerDrive(ports, { name: "USB", kind: "usb", rootPath: dest });
    await ingestFolder(ports, { driveId: from.id });
    expect(await listLibrary(ports, { kind: "photo" })).toHaveLength(1);
    const job = await saveBackupJob(ports, {
      sourceDriveId: from.id,
      destDriveId: to.id,
      sourceRelativePaths: ["Pics"],
    });
    const run = await runBackupJob(ports, job.id);
    expect(run.copied).toBe(1);
  });

  it("creates new files, copies one to USB, and moves another", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mem-e2e-"));
    const source = await mkdtemp(join(tmpdir(), "mem-e2e-src-"));
    const dest = await mkdtemp(join(tmpdir(), "mem-e2e-dst-"));
    await mkdir(join(source, "e2e"), { recursive: true });
    await writeFile(join(source, "e2e", "copy-me.jpg"), "copy-bytes-e2e");
    await writeFile(join(source, "e2e", "move-me.txt"), "move-bytes-e2e");
    const ports = await createLocalPorts(join(dir, "catalog.sqlite"));
    const from = await registerDrive(ports, { name: "E2E Mac", kind: "computer", rootPath: source });
    const to = await registerDrive(ports, { name: "E2E USB", kind: "usb", rootPath: dest });
    await ingestFolder(ports, { driveId: from.id, relativePath: "e2e" });
    const files = await listLibrary(ports);
    const photo = files.find((file) => file.name === "copy-me.jpg");
    const doc = files.find((file) => file.name === "move-me.txt");
    expect(photo && doc).toBeTruthy();

    await copyFileToDrive(ports, { fileId: photo!.id, destDriveId: to.id });
    expect(await readFile(join(dest, "e2e", "copy-me.jpg"), "utf8")).toBe("copy-bytes-e2e");
    expect(await exists(join(source, "e2e", "copy-me.jpg"))).toBe(true);

    await relocateFile(ports, {
      fileId: doc!.id,
      destDriveId: to.id,
      destRelativePath: "Inbox/move-me.txt",
    });
    expect(await exists(join(source, "e2e", "move-me.txt"))).toBe(false);
    expect(await readFile(join(dest, "Inbox", "move-me.txt"), "utf8")).toBe("move-bytes-e2e");
  });

  it("serves ingest over HTTP", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mem-http-"));
    const root = await mkdtemp(join(tmpdir(), "mem-http-root-"));
    await writeFile(join(root, "n.jpg"), "nnnn");
    const ports = await createLocalPorts(join(dir, "catalog.sqlite"));
    const app = createApp(ports);
    const created = await app.request("/drives", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Mac", kind: "computer", rootPath: root }),
    });
    const { drive } = await created.json();
    await app.request("/ingest", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ driveId: drive.id }),
    });
    const listed = await app.request("/files?kind=photo");
    const { files } = await listed.json();
    expect(files).toHaveLength(1);
    const media = await app.request(`/files/${files[0].id}/media`);
    expect(media.status).toBe(200);
  });

  it("registers a local folder, remounts it, and backups a new file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mem-remount-"));
    const camera = join(dir, "Camera");
    const stick = join(dir, "Stick");
    await mkdir(join(camera, "Photos"), { recursive: true });
    await mkdir(stick, { recursive: true });

    const ports = await createLocalPorts(join(dir, "catalog.sqlite"));
    const app = createApp(ports);
    const source = await (
      await app.request("/drives", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Camera", kind: "computer", rootPath: camera }),
      })
    ).json();
    const dest = await (
      await app.request("/drives", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Stick", kind: "usb", rootPath: stick }),
      })
    ).json();
    const saved = await (
      await app.request("/backups", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sourceDriveId: source.drive.id,
          destDriveId: dest.drive.id,
          sourceRelativePaths: ["Photos"],
        }),
      })
    ).json();
    expect(saved.job.sourceRelativePaths).toEqual(["Photos"]);

    await writeFile(join(camera, "Photos", "new-shot.jpg"), "shot-bytes");

    const parked = join(dir, "Camera.off");
    await rename(camera, parked);
    await app.request("/sync", { method: "POST" });
    const missing = await app.request(`/backups/${saved.job.id}/run`, { method: "POST" });
    expect(missing.status).toBe(200);
    expect(await missing.json()).toEqual({ copied: 0, skipped: 0 });
    expect(await exists(join(stick, "Photos", "new-shot.jpg"))).toBe(false);

    await rename(parked, camera);
    await app.request("/sync", { method: "POST" });
    const run = await app.request(`/backups/${saved.job.id}/run`, { method: "POST" });
    expect(run.status).toBe(200);
    expect(await run.json()).toMatchObject({ copied: 1 });
    expect(await readFile(join(stick, "Photos", "new-shot.jpg"), "utf8")).toBe("shot-bytes");
  });
});
