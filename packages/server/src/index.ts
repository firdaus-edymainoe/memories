import {
  copyFileToDrive,
  createVirtualFolder,
  getFileDetail,
  ingestFolder,
  isNotFound,
  listDriveFolders,
  listDriveEntries,
  listVolumeEntries,
  listDrives,
  listEvents,
  listLibrary,
  locateDrive,
  MemoriesError,
  moveToFolder,
  placeFile,
  readOnlineBytes,
  readDriveBytes,
  registerDrive,
  relocateFile,
  runBackupJob,
  saveBackupJob,
  syncDrivePresence,
  systemCode,
  type DriveKind,
  type FileKind,
  type Ports,
} from "@memories/core";
import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import { HTTPException } from "hono/http-exception";

export type AppOptions = {
  /** Browser origins allowed to call the API (the Memories UI). */
  allowedOrigins?: string[];
  /** Extra Host names to accept besides 127.0.0.1, localhost and ::1. */
  allowedHosts?: string[];
  /** Native folder picker (desktop). Without one, POST /pick-folder answers 501. */
  pickFolder?: () => Promise<string | null>;
  /** Where unexpected errors are reported. Defaults to console.error. */
  logError?: (error: unknown) => void;
};

export const DEFAULT_ORIGINS = ["http://127.0.0.1:5173", "http://localhost:5173"];
const LOCAL_HOSTS = ["127.0.0.1", "localhost", "[::1]", "::1"];
const KINDS: FileKind[] = ["photo", "video", "document"];

function bad(message: string): never {
  throw new MemoriesError(message, 400);
}

function str(value: unknown, message: string): string {
  if (typeof value !== "string" || !value) bad(message);
  return value;
}

function optStr(value: unknown, message: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") bad(message);
  return value;
}

/** Parse a JSON object body. An empty body counts as {}. */
async function body(c: Context): Promise<Record<string, unknown>> {
  const text = await c.req.text();
  if (!text.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    bad("That request wasn’t valid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) bad("Expected a JSON object");
  return parsed as Record<string, unknown>;
}

/** RFC 6266/5987: an ASCII fallback plus the real UTF-8 name. */
export function contentDisposition(name: string) {
  const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `inline; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name).replace(/['()*]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`)}`;
}

function media(bytes: Uint8Array, mime: string, name: string) {
  return new Response(bytes as unknown as ConstructorParameters<typeof Response>[0], {
    headers: {
      "content-type": mime,
      "content-disposition": contentDisposition(name),
      "cache-control": "private, no-cache",
      "x-content-type-options": "nosniff",
    },
  });
}

/** Map any error to a status and a message that is safe to show (never a server path). */
export function errorResponse(error: unknown): { status: number; body: Record<string, unknown>; internal: boolean } {
  if (error instanceof HTTPException) return { status: error.status, body: { error: error.message }, internal: false };
  if (error instanceof MemoriesError) return { status: error.status, body: { error: error.message, ...error.details }, internal: false };
  const code = systemCode(error);
  if (isNotFound(error)) return { status: 404, body: { error: "File not found" }, internal: false };
  if (code === "EACCES" || code === "EPERM") return { status: 403, body: { error: "Memories isn’t allowed to open this file" }, internal: false };
  if (code === "EISDIR") return { status: 400, body: { error: "That’s a folder, not a file" }, internal: false };
  if (code === "ENOSPC") return { status: 507, body: { error: "The drive is full" }, internal: false };
  if (error instanceof Error && !code && !/[/\\]/.test(error.message)) {
    // Adapter messages meant for people ("Android phone not connected…"). No paths in them.
    return { status: 400, body: { error: error.message }, internal: false };
  }
  return { status: 500, body: { error: "Something went wrong" }, internal: true };
}

export function createApp(ports: Ports, options: AppOptions = {}) {
  const origins = options.allowedOrigins ?? DEFAULT_ORIGINS;
  const hosts = new Set([...LOCAL_HOSTS, ...(options.allowedHosts ?? [])]);
  const logError = options.logError ?? ((error: unknown) => console.error(error));
  const app = new Hono();

  // DNS rebinding: only answer requests addressed to this computer.
  app.use("*", async (c, next) => {
    const host = new URL(c.req.url).hostname;
    if (!hosts.has(host)) return c.json({ error: "Forbidden host" }, 403);
    await next();
  });

  app.use("*", cors({ origin: origins }));

  // CSRF: a web page can send "simple" cross-origin requests without a preflight. Refuse foreign
  // origins outright, and require JSON on every change so a browser must preflight (which CORS denies).
  app.use("*", async (c, next) => {
    const origin = c.req.header("origin");
    if (origin && !origins.includes(origin)) return c.json({ error: "Forbidden origin" }, 403);
    if (!["GET", "HEAD", "OPTIONS"].includes(c.req.method)) {
      const type = c.req.header("content-type") ?? "";
      if (!/^application\/json\b/i.test(type)) return c.json({ error: "Send requests as application/json" }, 415);
    }
    await next();
  });

  app.onError((error, c) => {
    const mapped = errorResponse(error);
    if (mapped.internal) logError(error);
    return c.json(mapped.body, mapped.status as 400);
  });

  app.get("/health", (c) => c.json({ ok: true }));

  app.get("/volumes", async (c) => c.json({ volumes: await ports.volumes.list() }));

  app.get("/volumes/entries", async (c) =>
    c.json({ entries: await listVolumeEntries(ports, c.req.query("mount") ?? "", c.req.query("path") ?? "") }),
  );

  app.post("/pick-folder", async (c) => {
    if (!options.pickFolder) throw new MemoriesError("The folder picker is only available in the Memories app", 501);
    return c.json({ rootPath: await options.pickFolder() });
  });

  app.get("/drives", async (c) => c.json({ drives: await listDrives(ports) }));

  app.post("/drives", async (c) => {
    const input = await body(c);
    const volumeId = optStr(input.volumeId, "volumeId must be text");
    const drive = await registerDrive(ports, {
      name: typeof input.name === "string" ? input.name : "",
      kind: input.kind as DriveKind,
      rootPath: typeof input.rootPath === "string" ? input.rootPath : "",
      ...(volumeId ? { volumeId } : {}),
    });
    return c.json({ drive }, 201);
  });

  app.post("/drives/:id/locate", async (c) => {
    const input = await body(c);
    const drive = await locateDrive(ports, c.req.param("id"), typeof input.rootPath === "string" ? input.rootPath : "");
    return c.json({ drive });
  });

  app.get("/drives/:id/folders", async (c) => c.json({ folders: await listDriveFolders(ports, c.req.param("id")) }));

  app.get("/drives/:id/entries", async (c) =>
    c.json({ entries: await listDriveEntries(ports, c.req.param("id"), c.req.query("path") ?? "") }),
  );

  app.get("/drives/:id/media", async (c) => {
    const found = await readDriveBytes(ports, c.req.param("id"), c.req.query("path") ?? "");
    return media(found.bytes, found.mime, found.name);
  });

  app.post("/sync", async (c) => {
    await syncDrivePresence(ports);
    return c.json({ ok: true });
  });

  app.get("/files", async (c) => {
    const kind = c.req.query("kind");
    if (kind && !KINDS.includes(kind as FileKind)) bad("Unknown kind");
    const inbox = c.req.query("inbox");
    const files = await listLibrary(ports, {
      ...(kind ? { kind: kind as FileKind } : {}),
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
    const found = await readOnlineBytes(ports, c.req.param("id"));
    if (!found) return c.json({ error: "No connected copy" }, 409);
    return media(found.bytes, found.mime, found.name);
  });

  app.post("/files/:id/place", async (c) => c.json({ file: await placeFile(ports, c.req.param("id")) }));

  app.post("/files/:id/copy", async (c) => {
    const input = await body(c);
    const destRelativePath = optStr(input.destRelativePath, "destRelativePath must be text");
    const replica = await copyFileToDrive(ports, {
      fileId: c.req.param("id"),
      destDriveId: str(input.destDriveId, "Choose where to copy it"),
      ...(destRelativePath ? { destRelativePath } : {}),
    });
    return c.json({ replica });
  });

  app.post("/files/:id/relocate", async (c) => {
    const input = await body(c);
    const replica = await relocateFile(ports, {
      fileId: c.req.param("id"),
      destDriveId: str(input.destDriveId, "Choose where to move it"),
      destRelativePath: typeof input.destRelativePath === "string" ? input.destRelativePath : "",
    });
    return c.json({ replica });
  });

  app.post("/files/:id/move", async (c) => {
    const input = await body(c);
    const folderId = input.folderId === null || input.folderId === undefined ? null : str(input.folderId, "folderId must be text");
    await moveToFolder(ports, c.req.param("id"), folderId);
    return c.json({ ok: true });
  });

  app.get("/events", async (c) => c.json({ events: await listEvents(ports) }));

  app.post("/ingest", async (c) => {
    const input = await body(c);
    const relativePath = optStr(input.relativePath, "relativePath must be text");
    return c.json(await ingestFolder(ports, { driveId: str(input.driveId, "Choose a place"), ...(relativePath ? { relativePath } : {}) }));
  });

  app.get("/folders", async (c) => c.json({ folders: await ports.catalog.listVirtualFolders() }));

  app.post("/folders", async (c) => {
    const input = await body(c);
    const parentId = optStr(input.parentId, "parentId must be text");
    const folder = await createVirtualFolder(ports, {
      name: typeof input.name === "string" ? input.name : "",
      parentId: parentId ?? null,
    });
    return c.json({ folder }, 201);
  });

  app.get("/backups", async (c) => c.json({ jobs: await ports.catalog.listBackupJobs() }));

  app.post("/backups", async (c) => {
    const input = await body(c);
    const job = await saveBackupJob(ports, {
      sourceDriveId: str(input.sourceDriveId, "Choose what to back up"),
      destDriveId: str(input.destDriveId, "Choose where to keep it"),
      sourceRelativePaths: input.sourceRelativePaths as string[],
    });
    return c.json({ job }, 201);
  });

  app.post("/backups/:id/run", async (c) => c.json(await runBackupJob(ports, c.req.param("id"))));

  app.notFound((c) => c.json({ error: "Not found" }, 404));

  return app;
}
