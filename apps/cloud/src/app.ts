import { type CloudCatalogStore, type CloudProvider, cloudUserFrom } from "@memories/core";
import { InvalidKeyError, ObjectExistsError, ObjectNotFoundError } from "@memories/storage";
import { type Context, Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import * as z from "zod";
import type { Auth } from "./auth.js";
import { CloudInputError, type CloudFiles } from "./cloud-files.js";
import { desktopAuthorizeQuery } from "./desktop-sign-in.js";
import { messagePage, resetPasswordPage } from "./pages.js";
import { parseSyncBatch } from "./sync-schema.js";

export type CloudAppOptions = {
  auth: Auth;
  catalog: CloudCatalogStore;
  files: CloudFiles;
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
export function createCloudApp({ auth, catalog, files, providers }: CloudAppOptions) {
  const app = new Hono<Env>();

  app.onError((error, c) => {
    if (error instanceof HTTPException) return c.json({ error: error.message }, error.status);
    if (error instanceof ObjectExistsError) return c.json({ error: "A file already exists there", code: "EEXIST" }, 409);
    if (error instanceof ObjectNotFoundError) return c.json({ error: "No such file", code: "ENOENT" }, 404);
    if (error instanceof CloudInputError || error instanceof InvalidKeyError || error instanceof z.ZodError) return c.json({ error: error.message }, 400);
    console.error(error);
    return c.json({ error: "Something went wrong" }, 500);
  });

  app.get("/health", (c) => c.json({ ok: true }));

  /** What the app shows before anyone signs in. */
  app.get("/v1/config", (c) => c.json({ providers, storage: files.provider }));

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

  app.get("/v1/storage/list", async (c) => {
    const entries = await files.list(c.get("user").id, c.req.query("path") ?? "", { recursive: c.req.query("recursive") === "1" });
    return c.json({ entries });
  });

  app.get("/v1/storage/stat", async (c) => {
    const stat = await files.stat(c.get("user").id, c.req.query("path") ?? "");
    if (!stat) return c.json({ error: "No such file", code: "ENOENT" }, 404);
    return c.json({ file: stat });
  });

  app.post("/v1/storage/uploads", async (c) => {
    const input = await body(c, uploadBody);
    return c.json({ upload: await files.prepareUpload(c.get("user").id, input) });
  });

  app.post("/v1/storage/downloads", async (c) => {
    const input = await body(c, z.object({ path: z.string().min(1).max(1024), fileName: z.string().max(255).optional() }));
    return c.json({ download: await files.prepareDownload(c.get("user").id, input.path, input.fileName) });
  });

  app.post("/v1/storage/copy", async (c) => {
    const input = await body(c, copyBody);
    await files.copy(c.get("user").id, input.from, input.to);
    return c.json({ ok: true });
  });

  app.delete("/v1/storage/object", async (c) => {
    await files.remove(c.get("user").id, c.req.query("path") ?? "");
    return c.json({ ok: true });
  });

  return app;
}
