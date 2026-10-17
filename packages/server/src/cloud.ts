import type {
  CloudAdminUser,
  CloudDriveProvider,
  CloudProvider,
  CloudRole,
  CloudStatus,
  CloudUser,
  ConnectedDrive,
  Drive,
} from "@memories/core";
import { type Context, Hono } from "hono";

/**
 * What the local API needs from optional cloud mode (implemented by `@memories/cloud-link`'s
 * `CloudService` in the desktop host). Without it the app is local only.
 */
export type CloudControl = {
  status(): Promise<CloudStatus>;
  signUp(input: { name: string; email: string; password: string }): Promise<CloudUser>;
  signIn(input: { email: string; password: string }): Promise<CloudUser>;
  startSignIn(provider: CloudProvider, redirectUri: string): Promise<{ url: string }>;
  completeSignIn(input: { code: string; state: string }): Promise<CloudUser>;
  signOut(): Promise<void>;
  forgotPassword(email: string): Promise<void>;
  resendVerification(): Promise<void>;
  refresh(): Promise<CloudUser | null>;
  setSyncEnabled(enabled: boolean): Promise<void>;
  syncNow(): Promise<void>;
  addStoragePlace(): Promise<Drive>;
  connectDrive(provider: CloudDriveProvider, redirectUri: string): Promise<{ url: string }>;
  completeDriveConnection(input: { code?: string; state: string; error?: string }): Promise<ConnectedDrive>;
  renameDrive(driveId: string, label: string): Promise<ConnectedDrive>;
  disconnectDrive(driveId: string): Promise<void>;
  addDrivePlace(driveId: string): Promise<Drive>;
  listUsers(input: { search?: string; limit?: number; offset?: number }): Promise<{ users: CloudAdminUser[]; total: number }>;
  setRole(userId: string, role: CloudRole): Promise<void>;
  banUser(userId: string, reason?: string): Promise<void>;
  unbanUser(userId: string): Promise<void>;
  removeUser(userId: string): Promise<void>;
};

/** The browser lands here after signing in with a provider. Needs no launch token. */
export const CLOUD_CALLBACK_PATH = "/cloud/callback";
/** The browser lands here after allowing access to a drive. Needs no launch token either. */
export const CLOUD_DRIVE_CALLBACK_PATH = "/cloud/drives/callback";

export const LOCAL_ONLY_STATUS: CloudStatus = {
  available: false,
  serverUrl: null,
  providers: [],
  user: null,
  sync: { enabled: false, pending: 0, lastSyncedAt: null, error: null, running: false },
  storageDriveId: null,
  driveProviders: [],
  drives: [],
};

const PROVIDERS = new Set<CloudProvider>(["google", "apple", "microsoft", "github", "facebook"]);
const DRIVE_PROVIDERS = new Set<CloudDriveProvider>(["google-drive", "onedrive"]);

/** Errors from the cloud keep their status (401, 403, 409…); anything else is a bad request. */
function failure(c: Context, error: unknown) {
  const status = (error as { status?: number } | null)?.status;
  const message = error instanceof Error ? error.message : "Request failed";
  const code = status && status >= 400 && status < 600 ? status : status === 0 ? 503 : 400;
  return c.json({ error: message }, code as 400);
}

function callbackPage(title: string, message: string) {
  const escape = (text: string) => text.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escape(title)}</title>
<style>:root{color-scheme:light dark}body{font:16px/1.5 system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;padding:16px;box-sizing:border-box}main{max-width:360px}h1{font-size:22px}</style>
</head><body><main><h1>${escape(title)}</h1><p>${escape(message)}</p></main></body></html>`;
}

async function json<T>(c: Context): Promise<T> {
  return (await c.req.json().catch(() => ({}))) as T;
}

export function cloudRoutes(cloud: CloudControl | undefined, options: { onSignedIn?: () => void } = {}) {
  const app = new Hono();

  app.get("/cloud/status", async (c) => c.json({ status: cloud ? await cloud.status() : LOCAL_ONLY_STATUS }));

  // The rest only exists when a cloud server is configured.
  app.use("/cloud/*", async (c, next) => {
    if (!cloud) return c.json({ error: "Memories Cloud isn't set up for this app" }, 404);
    await next();
  });
  const service = () => cloud!;

  const run = (handler: (c: Context) => Promise<Response>) => async (c: Context) => {
    try {
      return await handler(c);
    } catch (error) {
      return failure(c, error);
    }
  };

  app.post(
    "/cloud/sign-up",
    run(async (c) => {
      const body = await json<{ name?: string; email?: string; password?: string }>(c);
      const user = await service().signUp({ name: body.name ?? "", email: body.email ?? "", password: body.password ?? "" });
      return c.json({ user });
    }),
  );

  app.post(
    "/cloud/sign-in",
    run(async (c) => {
      const body = await json<{ email?: string; password?: string }>(c);
      return c.json({ user: await service().signIn({ email: body.email ?? "", password: body.password ?? "" }) });
    }),
  );

  app.post(
    "/cloud/sign-in/provider",
    run(async (c) => {
      const { provider } = await json<{ provider?: CloudProvider }>(c);
      if (!provider || !PROVIDERS.has(provider)) return c.json({ error: "Unknown sign-in provider" }, 400);
      const redirectUri = `${new URL(c.req.url).origin}${CLOUD_CALLBACK_PATH}`;
      return c.json(await service().startSignIn(provider, redirectUri));
    }),
  );

  app.get(CLOUD_CALLBACK_PATH, async (c) => {
    const code = c.req.query("code");
    const state = c.req.query("state");
    if (!code || !state) return c.html(callbackPage("Signing in didn't finish", "Go back to Memories and try again."), 400);
    try {
      const user = await service().completeSignIn({ code, state });
      options.onSignedIn?.();
      return c.html(callbackPage("You're signed in", `Welcome, ${user.name || user.email}. You can close this tab and go back to Memories.`));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Go back to Memories and try again.";
      return c.html(callbackPage("Signing in didn't work", message), 400);
    }
  });

  app.post(
    "/cloud/sign-out",
    run(async (c) => {
      await service().signOut();
      return c.json({ ok: true });
    }),
  );

  app.post(
    "/cloud/forgot-password",
    run(async (c) => {
      const { email } = await json<{ email?: string }>(c);
      if (!email) return c.json({ error: "Enter your email address" }, 400);
      await service().forgotPassword(email);
      return c.json({ ok: true });
    }),
  );

  app.post(
    "/cloud/verify-email",
    run(async (c) => {
      await service().resendVerification();
      return c.json({ ok: true });
    }),
  );

  app.post(
    "/cloud/refresh",
    run(async (c) => c.json({ user: await service().refresh() })),
  );

  app.post(
    "/cloud/sync/enabled",
    run(async (c) => {
      const { enabled } = await json<{ enabled?: boolean }>(c);
      await service().setSyncEnabled(Boolean(enabled));
      return c.json({ status: await service().status() });
    }),
  );

  app.post(
    "/cloud/sync/now",
    run(async (c) => {
      await service().syncNow();
      return c.json({ status: await service().status() });
    }),
  );

  app.post(
    "/cloud/storage",
    run(async (c) => c.json({ drive: await service().addStoragePlace() }, 201)),
  );

  app.post(
    "/cloud/drives/connect",
    run(async (c) => {
      const { provider } = await json<{ provider?: CloudDriveProvider }>(c);
      if (!provider || !DRIVE_PROVIDERS.has(provider)) return c.json({ error: "Unknown drive" }, 400);
      const redirectUri = `${new URL(c.req.url).origin}${CLOUD_DRIVE_CALLBACK_PATH}`;
      return c.json(await service().connectDrive(provider, redirectUri));
    }),
  );

  app.get(CLOUD_DRIVE_CALLBACK_PATH, async (c) => {
    const state = c.req.query("state");
    const code = c.req.query("code");
    const error = c.req.query("error");
    if (!state) return c.html(callbackPage("Connecting didn't finish", "Go back to Memories and try again."), 400);
    try {
      const drive = await service().completeDriveConnection({ state, ...(code ? { code } : {}), ...(error ? { error } : {}) });
      options.onSignedIn?.();
      return c.html(callbackPage("Your drive is connected", `${drive.label} is ready. You can close this tab and go back to Memories.`));
    } catch (err) {
      const message = err instanceof Error ? err.message : "Go back to Memories and try again.";
      return c.html(callbackPage("Connecting your drive didn't work", message), 400);
    }
  });

  app.post(
    "/cloud/drives/:id/place",
    run(async (c) => c.json({ drive: await service().addDrivePlace(c.req.param("id")!) }, 201)),
  );

  app.post(
    "/cloud/drives/:id/rename",
    run(async (c) => {
      const { label } = await json<{ label?: string }>(c);
      if (!label?.trim()) return c.json({ error: "Give it a name" }, 400);
      return c.json({ drive: await service().renameDrive(c.req.param("id")!, label.trim()) });
    }),
  );

  app.post(
    "/cloud/drives/:id/disconnect",
    run(async (c) => {
      await service().disconnectDrive(c.req.param("id")!);
      return c.json({ ok: true });
    }),
  );

  app.get(
    "/cloud/admin/users",
    run(async (c) => {
      const search = c.req.query("search")?.trim();
      const offset = Number(c.req.query("offset") ?? 0) || 0;
      return c.json(await service().listUsers({ ...(search ? { search } : {}), offset, limit: 50 }));
    }),
  );

  app.post(
    "/cloud/admin/users/:id/role",
    run(async (c) => {
      const { role } = await json<{ role?: CloudRole }>(c);
      if (role !== "admin" && role !== "user") return c.json({ error: "Role must be admin or user" }, 400);
      await service().setRole(c.req.param("id")!, role);
      return c.json({ ok: true });
    }),
  );

  app.post(
    "/cloud/admin/users/:id/ban",
    run(async (c) => {
      const { reason } = await json<{ reason?: string }>(c);
      await service().banUser(c.req.param("id")!, reason);
      return c.json({ ok: true });
    }),
  );

  app.post(
    "/cloud/admin/users/:id/unban",
    run(async (c) => {
      await service().unbanUser(c.req.param("id")!);
      return c.json({ ok: true });
    }),
  );

  app.post(
    "/cloud/admin/users/:id/remove",
    run(async (c) => {
      await service().removeUser(c.req.param("id")!);
      return c.json({ ok: true });
    }),
  );

  return app;
}
