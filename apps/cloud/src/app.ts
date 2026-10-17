import { type CloudCatalogStore, type CloudProvider, cloudUserFrom } from "@memories/core";
import { DriveApiError, InvalidKeyError, ObjectExistsError, ObjectNotFoundError } from "@memories/storage";
import { type Context, Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import * as z from "zod";
import type { Auth } from "./auth.js";
import { CloudInputError, type CloudFiles, type CloudSpace } from "./cloud-files.js";
import { desktopAuthorizeQuery } from "./desktop-sign-in.js";
import {
  completeBody,
  connectBody,
  DRIVE_CALLBACK_PATH,
  DriveConnectInputError,
  type DriveConnections,
  DriveNotFoundError,
  DriveReconnectError,
} from "./drive-connections.js";
import { messagePage, resetPasswordPage } from "./pages.js";
import { parseSyncBatch } from "./sync-schema.js";

export type CloudAppOptions = {
  auth: Auth;
  catalog: CloudCatalogStore;
  files: CloudFiles;
  /** People's own drives. Leave out when no drive provider is set up. */
  drives?: DriveConnections;
  /** Sign-in methods with credentials configured, shown in the app. */
  providers: CloudProvider[];
};

type SessionUser = {
  id: string;
  email: string;
  name: string;
  role?: string | null;
  emailVerified: boolean;
  image?: string | null;
};

type Env = { Variables: { user: SessionUser } };

const deviceBody = z.object({ name: z.string().min(1).max(200), platform: z.string().min(1).max(50) });
const uploadBody = z.object({
  path: z.string().min(1).max(1024),
  size: z.number().int().nonnegative(),
  sha256: z.string(),
  contentType: z.string().max(255).default("application/octet-stream"),
});
const copyBody = z.object({ from: z.string().min(1).max(1024), to: z.string().min(1).max(1024) });

async function body<T>(c: Context, schema: z.ZodType<T>): Promise<T> {
  const parsed = schema.safeParse(await c.req.json().catch(() => undefined));
  if (!parsed.success) throw new HTTPException(400, { message: parsed.error.issues[0]?.message ?? "Invalid request" });
  return parsed.data;
}

/**
 * The hosted Memories server: accounts (Better Auth at `/api/auth`), catalog sync and cloud
 * storage (`/v1`). The desktop app is its only client and authenticates with a bearer token.
 */
export function createCloudApp({ auth, catalog, files, drives, providers }: CloudAppOptions) {
  const app = new Hono<Env>();

  app.onError((error, c) => {
    if (error instanceof HTTPException) return c.json({ error: error.message }, error.status);
    if (error instanceof ObjectExistsError) return c.json({ error: "A file already exists there", code: "EEXIST" }, 409);
    if (error instanceof ObjectNotFoundError) return c.json({ error: "No such file", code: "ENOENT" }, 404);
    if (
      error instanceof CloudInputError ||
      error instanceof InvalidKeyError ||
      error instanceof DriveConnectInputError ||
      error instanceof z.ZodError
    ) {
      return c.json({ error: error.message }, 400);
    }
    if (error instanceof DriveNotFoundError) return c.json({ error: error.message, code: "NO_DRIVE" }, 404);
    if (error instanceof DriveReconnectError) return c.json({ error: error.message, code: error.code }, 403);
    if (error instanceof DriveApiError) {
      // Never pass a provider's 401 on: the app would take it as being signed out of Memories.
      return c.json({ error: error.message, code: "DRIVE" }, error.status === 0 ? 503 : 502);
    }
    console.error(error);
    return c.json({ error: "Something went wrong" }, 500);
  });

  app.get("/health", (c) => c.json({ ok: true }));

  /** What the app shows before anyone signs in. */
  app.get("/v1/config", (c) => c.json({ providers, storage: files.provider, drives: drives?.available() ?? [] }));

  app.on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(c.req.raw));

  /**
   * Starts a social sign-in in the system browser. The app opens this URL; after the provider,
   * Better Auth lands on `/api/auth/desktop/authorize`, which hands a code back to the app.
   */
  app.get("/desktop/sign-in", async (c) => {
    const provider = c.req.query("provider") as CloudProvider | undefined;
    const query = desktopAuthorizeQuery.safeParse(c.req.query());
    if (!provider || !providers.includes(provider) || !query.success) {
      return c.html(messagePage("This sign-in link isn't valid", "Go back to Memories and try again."), 400);
    }
    const authorize = new URL("/api/auth/desktop/authorize", new URL(c.req.url).origin);
    for (const [name, value] of Object.entries(query.data)) authorize.searchParams.set(name, value);

    const started = await auth.api.signInSocial({
      body: { provider, callbackURL: authorize.pathname + authorize.search, errorCallbackURL: "/desktop/error" },
      headers: c.req.raw.headers,
      asResponse: true,
    });
    const { url } = (await started.json()) as { url?: string };
    if (!url) return c.html(messagePage("Couldn't start signing in", "Go back to Memories and try again."), 502);
    const headers = new Headers({ location: url });
    for (const cookie of started.headers.getSetCookie()) headers.append("set-cookie", cookie);
    return new Response(null, { status: 302, headers });
  });

  app.get("/desktop/error", (c) =>
    c.html(messagePage("Signing in didn't work", "Close this tab, go back to Memories and try again.")),
  );

  app.get("/reset-password", (c) => {
    const token = c.req.query("token");
    if (!token || c.req.query("error")) {
      return c.html(messagePage("This link has expired", "Ask Memories for a new password reset email."), 400);
    }
    return c.html(resetPasswordPage(token));
  });

  /** The provider sends the browser here; it goes on to the app with a one-time code. */
  app.get(DRIVE_CALLBACK_PATH, async (c) => {
    if (!drives) return c.html(messagePage("Connecting drives isn't set up", "Go back to Memories."), 404);
    try {
      const query = c.req.query();
      const back = await drives.callback({
        ...(query.code ? { code: query.code } : {}),
        ...(query.state ? { state: query.state } : {}),
        ...(query.error ? { error: query.error } : {}),
      });
      return c.redirect(back, 302);
    } catch (error) {
      if (!(error instanceof DriveConnectInputError)) console.error(error);
      const message = error instanceof DriveConnectInputError ? error.message : "Go back to Memories and try again.";
      return c.html(messagePage("Connecting your drive didn't work", message), 400);
    }
  });

  app.get("/", (c) => c.html(messagePage("You're all set", "You can close this tab and go back to Memories.")));

  // Everything below needs a signed-in person.
  app.use("/v1/*", async (c, next) => {
    if (c.req.path === "/v1/config") return next();
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    if (!session) return c.json({ error: "Sign in to Memories first" }, 401);
    c.set("user", session.user as SessionUser);
    await next();
  });

  app.get("/v1/me", (c) => c.json({ user: cloudUserFrom(c.get("user")) }));

  app.get("/v1/devices", async (c) => c.json({ devices: await catalog.listDevices(c.get("user").id) }));

  app.put("/v1/devices/:id", async (c) => {
    const input = await body(c, deviceBody);
    const id = c.req.param("id");
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(id)) return c.json({ error: "Invalid device id" }, 400);
    return c.json({ device: await catalog.registerDevice(c.get("user").id, { id, ...input }) });
  });

  app.delete("/v1/devices/:id", async (c) => {
    await catalog.removeDevice(c.get("user").id, c.req.param("id"));
    return c.json({ ok: true });
  });

  app.post("/v1/sync", async (c) => {
    let batch;
    try {
      batch = parseSyncBatch(await c.req.json());
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : "Invalid batch" }, 400);
    }
    await catalog.apply(c.get("user").id, batch);
    return c.json({ ok: true, records: batch.records.length });
  });

  const connected = () => {
    if (!drives) throw new HTTPException(404, { message: "Connecting drives isn't set up on this server" });
    return drives;
  };

  // Files. `/v1/storage` is the person's Memories Cloud; `/v1/drives/:driveId/storage` is one of
  // their own drives. Both are the same API on the same storage contract.
  storageRoutes(app, "/v1/storage", async (c) => files.space(c.get("user").id));
  storageRoutes(app, "/v1/drives/:driveId/storage", async (c) => connected().space(c.get("user").id, c.req.param("driveId")!));

  app.get("/v1/drives", async (c) =>
    c.json({ providers: drives?.available() ?? [], drives: drives ? await drives.list(c.get("user").id) : [] }),
  );

  app.post("/v1/drives/connect", async (c) => c.json(connected().start(c.get("user").id, await body(c, connectBody))));

  app.post("/v1/drives/complete", async (c) => c.json({ drive: await connected().complete(c.get("user").id, await body(c, completeBody)) }));

  app.patch("/v1/drives/:driveId", async (c) => {
    const input = await body(c, z.object({ label: z.string().trim().min(1).max(100) }));
    return c.json({ drive: await connected().rename(c.get("user").id, c.req.param("driveId"), input.label) });
  });

  app.delete("/v1/drives/:driveId", async (c) => {
    await connected().disconnect(c.get("user").id, c.req.param("driveId"));
    return c.json({ ok: true });
  });

  return app;
}

/** List, stat, signed upload and download, copy and delete, on whichever space `space` picks. */
function storageRoutes(app: Hono<Env>, base: string, space: (c: Context<Env>) => Promise<CloudSpace>) {
  app.get(`${base}/list`, async (c) => {
    const entries = await (await space(c)).list(c.req.query("path") ?? "", { recursive: c.req.query("recursive") === "1" });
    return c.json({ entries });
  });

  app.get(`${base}/stat`, async (c) => {
    const stat = await (await space(c)).stat(c.req.query("path") ?? "");
    if (!stat) return c.json({ error: "No such file", code: "ENOENT" }, 404);
    return c.json({ file: stat });
  });

  app.post(`${base}/uploads`, async (c) => {
    const input = await body(c, uploadBody);
    return c.json({ upload: await (await space(c)).prepareUpload(input) });
  });

  app.post(`${base}/downloads`, async (c) => {
    const input = await body(c, z.object({ path: z.string().min(1).max(1024), fileName: z.string().max(255).optional() }));
    return c.json({ download: await (await space(c)).prepareDownload(input.path, input.fileName) });
  });

  app.post(`${base}/copy`, async (c) => {
    const input = await body(c, copyBody);
    await (await space(c)).copy(input.from, input.to);
    return c.json({ ok: true });
  });

  app.delete(`${base}/object`, async (c) => {
    await (await space(c)).remove(c.req.query("path") ?? "");
    return c.json({ ok: true });
  });
}
