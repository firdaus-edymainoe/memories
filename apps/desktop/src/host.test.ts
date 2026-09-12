import { ingestFolder, listLibrary, registerDrive, runBackupJob, saveBackupJob } from "@memories/core";
import { SwitchFileIO } from "@memories/fs-android";
import { createApp } from "@memories/server";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createLocalPorts } from "./host.js";

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
      sourceRelativePaths: [],
    });
    const run = await runBackupJob(ports, job.id);
    expect(run.copied).toBe(1);
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
});
