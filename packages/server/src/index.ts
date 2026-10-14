import {
  copyFileToDrive,
  createVirtualFolder,
  getFileDetail,
  ingestFolder,
  listDriveFolders,
  listDriveEntries,
  deleteForever,
  emptyTrash,
  exportFiles,
  listBackupRuns,
  listTrash,
  openVersionFile,
  restoreFiles,
  setBackupAuto,
  trashFiles,
  listVolumeEntries,
  listDrives,
  listEvents,
  listLibrary,
  moveToFolder,
  openDriveFile,
  openOnlineFile,
  type OpenedFile,
  placeFile,
  registerDrive,
  relocateFile,
  runBackupJob,
  saveBackupJob,
  syncDrivePresence,
  type DriveKind,
  type FileKind,
  type Ports,
} from "@memories/core";
import { type Context, Hono } from "hono";
import { cors } from "hono/cors";
import { HTTPException } from "hono/http-exception";

/** Header carrying the per-launch secret (see `@memories/client`). */
export const TOKEN_HEADER = "x-memories-token";

export type AppOptions = {
  /**
   * Per-launch secret. When set, every request except `/health` must send it (header, or `token`
   * query parameter for media the browser loads directly). The desktop host always sets one.
   */
  token?: string;
  /** Browser origins allowed to call the API besides its own (default: the Vite dev server). */
  allowedOrigins?: string[];
  /** Native folder picker, provided by the desktop shell. */
  pickFolder?: () => Promise<string | null>;
  /**
   * Small preview images from the operating system, provided by the desktop shell. `cacheKey` is
   * the content hash when known. Returning null serves the original file instead.
   */
  thumbnail?: (input: Thumbnailable) => Promise<{ bytes: Uint8Array; mime: string } | null>;
};

export type Thumbnailable = { rootPath: string; relativePath: string; cacheKey: string | null };

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);
const DEV_ORIGINS = ["http://127.0.0.1:5173", "http://localhost:5173"];

function sameSecret(provided: string | undefined, expected: string) {
  if (!provided || provided.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= provided.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

/** Parses one `bytes=` range. `null` = no usable range, `"invalid"` = unsatisfiable. */
export function parseRange(header: string | undefined, size: number): { start: number; end: number } | null | "invalid" {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (match[1] === "" && match[2] === "")) return null;
  let start: number;
  let end: number;
  if (match[1] === "") {
    start = Math.max(0, size - Number(match[2]));
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] === "" ? size - 1 : Math.min(Number(match[2]), size - 1);
  }
  if (start >= size || start > end) return "invalid";
  return { start, end };
}

/** Types the browser renders without running scripts; anything else is sandboxed. */
function inertType(mime: string) {
  return (
    (mime.startsWith("image/") && mime !== "image/svg+xml") ||
    mime.startsWith("video/") ||
    mime.startsWith("audio/") ||
    mime === "application/pdf" ||
    mime === "text/plain" ||
    mime === "text/csv"
  );
}

async function serveFile(c: Context, file: OpenedFile) {
  const headers: Record<string, string> = {
    "content-type": file.mime,
    "content-disposition": `inline; filename="${file.name.replace(/["\\\r\n]/g, "")}"`,
    "cache-control": "private, no-cache",
    "accept-ranges": "bytes",
    "x-content-type-options": "nosniff",
  };
  // Files from the user's drives are untrusted: never let them run inside the app's origin.
  if (!inertType(file.mime)) headers["content-security-policy"] = "sandbox; default-src 'none'";

  const range = parseRange(c.req.header("range"), file.size);
  if (range === "invalid") {
    return new Response(null, { status: 416, headers: { ...headers, "content-range": `bytes */${file.size}` } });
  }
  if (range) {
    return new Response(await file.open(range), {
      status: 206,
      headers: {
        ...headers,
        "content-range": `bytes ${range.start}-${range.end}/${file.size}`,
        "content-length": String(range.end - range.start + 1),
      },
    });
  }
  return new Response(await file.open(), {
    headers: { ...headers, "content-length": String(file.size) },
  });
}

function fail(error: unknown): never {
  const message = error instanceof Error ? error.message : "Request failed";
  const status = message.startsWith("Unknown") ? 404 : 400;
  throw new HTTPException(status, { message });
}

function thumbnailResponse(thumb: { bytes: Uint8Array; mime: string }, cacheControl: string) {
  return new Response(thumb.bytes as Uint8Array<ArrayBuffer>, {
    headers: { "content-type": thumb.mime, "cache-control": cacheControl, "x-content-type-options": "nosniff" },
  });
}

export function createApp(ports: Ports, options: AppOptions = {}) {
  const app = new Hono();
  const allowedOrigins = new Set(options.allowedOrigins ?? DEV_ORIGINS);

  // A local server is reachable by any web page the user visits. Reject other host names
  // (DNS rebinding) and foreign origins, then require the launch token.
  app.use("*", async (c, next) => {
    const url = new URL(c.req.url);
    if (!LOOPBACK_HOSTS.has(url.hostname)) return c.json({ error: "Forbidden host" }, 403);
    const origin = c.req.header("origin");
    if (origin && origin !== url.origin && !allowedOrigins.has(origin)) {
      return c.json({ error: "Forbidden origin" }, 403);
    }
    await next();
  });
  app.use(
    "*",
    cors({
      origin: [...allowedOrigins],
      allowHeaders: ["content-type", TOKEN_HEADER, "range"],
      exposeHeaders: ["content-range", "accept-ranges", "content-length"],
    }),
  );
  if (options.token) {
    const token = options.token;
    app.use("*", async (c, next) => {
      if (c.req.method === "OPTIONS" || c.req.path === "/health") return next();
      const provided = c.req.header(TOKEN_HEADER) ?? c.req.query("token");
      if (!sameSecret(provided, token)) return c.json({ error: "Unauthorized" }, 401);
      await next();
    });
  }

  app.onError((error, c) => {
    if (error instanceof HTTPException) {
      return c.json({ error: error.message }, error.status);
    }
    return c.json({ error: error.message }, 500);
  });

  app.get("/health", (c) => c.json({ ok: true }));

  app.get("/volumes", async (c) => c.json({ volumes: await ports.volumes.list() }));

  app.get("/volumes/entries", async (c) => {
    try {
      return c.json({
        entries: await listVolumeEntries(ports, c.req.query("mount") ?? "", c.req.query("path") ?? ""),
      });
    } catch (error) {
      fail(error);
    }
  });

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
    let file: OpenedFile;
    try {
      file = await openDriveFile(ports, c.req.param("id"), c.req.query("path") ?? "");
    } catch (error) {
      fail(error);
    }
    return serveFile(c, file);
  });

  app.get("/drives/:id/thumb", async (c) => {
    const relativePath = c.req.query("path") ?? "";
    let file: OpenedFile;
    try {
      const drive = await ports.catalog.getDrive(c.req.param("id"));
      if (drive?.online && options.thumbnail) {
        const thumb = await options.thumbnail({ rootPath: drive.rootPath, relativePath, cacheKey: null }).catch(() => null);
        if (thumb) return thumbnailResponse(thumb, "private, max-age=300");
      }
      file = await openDriveFile(ports, c.req.param("id"), relativePath);
    } catch (error) {
      fail(error);
    }
    return serveFile(c, file);
  });

  app.post("/pick-folder", async (c) => {
    if (!options.pickFolder) return c.json({ error: "Choosing a folder needs the desktop app" }, 501);
    return c.json({ rootPath: await options.pickFolder() });
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

  app.get("/files/:id/thumb", async (c) => {
    const detail = await getFileDetail(ports, c.req.param("id"));
    const ready = detail?.replicas.find((row) => row.drive.online && row.replica.status === "ready");
    if (detail && ready && options.thumbnail) {
      const thumb = await options
        .thumbnail({
          rootPath: ready.drive.rootPath,
          relativePath: ready.replica.relativePath,
          cacheKey: detail.file.objectHash,
        })
        .catch(() => null);
      // A file's content never changes (new content is a new file), so this can be cached for good.
      if (thumb) return thumbnailResponse(thumb, "private, max-age=31536000, immutable");
    }
    const file = await openOnlineFile(ports, c.req.param("id"));
    if (!file) return c.json({ error: "No connected copy" }, 409);
    return serveFile(c, file);
  });

  app.get("/files/:id/media", async (c) => {
    const file = await openOnlineFile(ports, c.req.param("id"));
    if (!file) return c.json({ error: "No connected copy" }, 409);
    return serveFile(c, file);
  });

  app.post("/files/:id/place", async (c) => {
    try {
      return c.json({ file: await placeFile(ports, c.req.param("id")) });
    } catch (error) {
      fail(error);
    }
  });

  app.post("/files/:id/copy", async (c) => {
    const body = await c.req.json<{ destDriveId: string; destRelativePath?: string }>();
    try {
      return c.json({ replica: await copyFileToDrive(ports, { fileId: c.req.param("id"), ...body }) });
    } catch (error) {
      fail(error);
    }
  });

  app.post("/files/:id/relocate", async (c) => {
    const body = await c.req.json<{ destDriveId: string; destRelativePath: string }>();
    try {
      return c.json({ replica: await relocateFile(ports, { fileId: c.req.param("id"), ...body }) });
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
      auto?: boolean;
    }>();
    try {
      return c.json({ job: await saveBackupJob(ports, body) }, 201);
    } catch (error) {
      fail(error);
    }
  });

  app.post("/backups/:id/run", async (c) => {
    try {
      return c.json(await runBackupJob(ports, c.req.param("id"), { trigger: "manual" }));
    } catch (error) {
      fail(error);
    }
  });

  app.post("/backups/:id/auto", async (c) => {
    const body = await c.req.json<{ auto: boolean }>();
    try {
      return c.json({ job: await setBackupAuto(ports, c.req.param("id"), Boolean(body.auto)) });
    } catch (error) {
      fail(error);
    }
  });

  app.get("/backup-runs", async (c) => {
    const limit = Math.min(100, Math.max(1, Number(c.req.query("limit") ?? 20) || 20));
    return c.json({ runs: await listBackupRuns(ports, limit) });
  });

  app.get("/trash", async (c) => c.json({ files: await listTrash(ports) }));

  app.post("/trash", async (c) => {
    const body = await c.req.json<{ fileIds: string[] }>();
    return c.json({ moved: await trashFiles(ports, body.fileIds ?? []) });
  });

  app.post("/trash/restore", async (c) => {
    const body = await c.req.json<{ fileIds: string[] }>();
    return c.json({ restored: await restoreFiles(ports, body.fileIds ?? []) });
  });

  app.post("/trash/delete", async (c) => {
    const body = await c.req.json<{ fileIds: string[] }>();
    return c.json(await deleteForever(ports, body.fileIds ?? []));
  });

  app.post("/trash/empty", async (c) => c.json(await emptyTrash(ports)));

  app.post("/export", async (c) => {
    const body = await c.req.json<{ fileIds: string[]; rootPath: string; objectHash?: string }>();
    if (!body.rootPath) return c.json({ error: "Choose a folder to save into" }, 400);
    try {
      return c.json(
        await exportFiles(ports, {
          fileIds: body.fileIds ?? [],
          rootPath: body.rootPath,
          ...(body.objectHash ? { objectHash: body.objectHash } : {}),
        }),
      );
    } catch (error) {
      fail(error);
    }
  });

  app.get("/files/:id/versions/:hash/media", async (c) => {
    const file = await openVersionFile(ports, c.req.param("id"), c.req.param("hash"));
    if (!file) return c.json({ error: "No connected copy of this version" }, 409);
    return serveFile(c, file);
  });

  return app;
}
