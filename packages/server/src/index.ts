import {
  createVirtualFolder,
  getFileDetail,
  ingestFolder,
  listDriveFolders,
  listDriveEntries,
  listDrives,
  listEvents,
  listLibrary,
  moveToFolder,
  placeFile,
  readOnlineBytes,
  readDriveBytes,
  registerDrive,
  runBackupJob,
  saveBackupJob,
  syncDrivePresence,
  type DriveKind,
  type FileKind,
  type Ports,
} from "@memories/core";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { HTTPException } from "hono/http-exception";

function fail(error: unknown): never {
  const message = error instanceof Error ? error.message : "Request failed";
  const status = message.startsWith("Unknown") ? 404 : 400;
  throw new HTTPException(status, { message });
}

export function createApp(ports: Ports) {
  const app = new Hono();
  app.use(
    "*",
    cors({
      origin: ["http://127.0.0.1:5173", "http://localhost:5173"],
    }),
  );

  app.onError((error, c) => {
    if (error instanceof HTTPException) {
      return c.json({ error: error.message }, error.status);
    }
    return c.json({ error: error.message }, 500);
  });

  app.get("/health", (c) => c.json({ ok: true }));

  app.get("/volumes", async (c) => c.json({ volumes: await ports.volumes.list() }));

  app.get("/drives", async (c) => c.json({ drives: await listDrives(ports) }));

  app.post("/drives", async (c) => {
    const body = await c.req.json<{
      name: string;
      kind: DriveKind;
      rootPath: string;
      volumeId?: string;
    }>();
    try {
      const drive = await registerDrive(ports, body);
      return c.json({ drive }, 201);
    } catch (error) {
      fail(error);
    }
  });

  app.get("/drives/:id/folders", async (c) => {
    try {
      return c.json({ folders: await listDriveFolders(ports, c.req.param("id")) });
    } catch (error) {
      fail(error);
    }
  });

  app.get("/drives/:id/entries", async (c) => {
    try {
      return c.json({ entries: await listDriveEntries(ports, c.req.param("id"), c.req.query("path") ?? "") });
    } catch (error) {
      fail(error);
    }
  });

  app.get("/drives/:id/media", async (c) => {
    try {
      const media = await readDriveBytes(ports, c.req.param("id"), c.req.query("path") ?? "");
      return new Response(media.bytes, {
        headers: {
          "content-type": media.mime,
          "content-disposition": `inline; filename="${media.name.replace(/"/g, "")}"`,
          "cache-control": "private, no-cache",
        },
      });
    } catch (error) {
      fail(error);
    }
  });

  app.post("/sync", async (c) => {
    await syncDrivePresence(ports);
    return c.json({ ok: true });
  });

  app.get("/files", async (c) => {
    const kind = c.req.query("kind") as FileKind | undefined;
    const inbox = c.req.query("inbox");
    const files = await listLibrary(ports, {
      ...(kind ? { kind } : {}),
      ...(inbox === "true" ? { inbox: true } : inbox === "false" ? { inbox: false } : {}),
    });
    return c.json({ files });
  });

  app.get("/files/:id", async (c) => {
    const detail = await getFileDetail(ports, c.req.param("id"));
    if (!detail) return c.json({ error: "Unknown file" }, 404);
    return c.json(detail);
  });

  app.get("/files/:id/media", async (c) => {
    const media = await readOnlineBytes(ports, c.req.param("id"));
    if (!media) return c.json({ error: "No connected copy" }, 409);
    return new Response(media.bytes, {
      headers: {
        "content-type": media.mime,
        "content-disposition": `inline; filename="${media.name}"`,
      },
    });
  });

  app.post("/files/:id/place", async (c) => {
    try {
      return c.json({ file: await placeFile(ports, c.req.param("id")) });
    } catch (error) {
      fail(error);
    }
  });

  app.post("/files/:id/move", async (c) => {
    const body = await c.req.json<{ folderId: string | null }>();
    try {
      await moveToFolder(ports, c.req.param("id"), body.folderId);
      return c.json({ ok: true });
    } catch (error) {
      fail(error);
    }
  });

  app.get("/events", async (c) => c.json({ events: await listEvents(ports) }));

  app.post("/ingest", async (c) => {
    const body = await c.req.json<{ driveId: string; relativePath?: string }>();
    try {
      return c.json(await ingestFolder(ports, body));
    } catch (error) {
      fail(error);
    }
  });

  app.get("/folders", async (c) => c.json({ folders: await ports.catalog.listVirtualFolders() }));

  app.post("/folders", async (c) => {
    const body = await c.req.json<{ name: string; parentId?: string | null }>();
    return c.json({ folder: await createVirtualFolder(ports, body) }, 201);
  });

  app.get("/backups", async (c) => c.json({ jobs: await ports.catalog.listBackupJobs() }));

  app.post("/backups", async (c) => {
    const body = await c.req.json<{
      sourceDriveId: string;
      destDriveId: string;
      sourceRelativePaths: string[];
    }>();
    try {
      return c.json({ job: await saveBackupJob(ports, body) }, 201);
    } catch (error) {
      fail(error);
    }
  });

  app.post("/backups/:id/run", async (c) => {
    try {
      return c.json(await runBackupJob(ports, c.req.param("id")));
    } catch (error) {
      fail(error);
    }
  });

  return app;
}
