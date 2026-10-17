import { PGlite } from "@electric-sql/pglite";
import { CloudFileIO, CloudService, CloudVolumes, MemoryStateStore, WithCloudFileIO, WithCloudVolumes } from "@memories/cloud-link";
import {
  MemoryVolumes,
  type Ports,
  copyFileToDrive,
  ingestFolder,
  registerDrive,
  runBackupJob,
  saveBackupJob,
} from "@memories/core";
import { PostgresCatalogStore, catalogSchema, migrateCatalog } from "@memories/db-postgres";
import { SqliteCatalog } from "@memories/db-sqlite";
import { NodeFileIO } from "@memories/fs-darwin";
import { MemoryObjectStorage } from "@memories/storage";
import { memoryAdapter } from "better-auth/adapters/memory";
import { drizzle } from "drizzle-orm/pglite";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createCloudApp } from "./app.js";
import { createAuth } from "./auth.js";
import { CloudFiles } from "./cloud-files.js";
import { ConsoleMailer } from "./mailer.js";

/**
 * The desktop side (`@memories/cloud-link`, SQLite catalog, real files on disk) against the
 * real cloud server (Better Auth, Postgres through PGlite, in-memory object storage).
 */
const SERVER = "http://cloud.test";

async function world() {
  const authDb: Record<string, Array<Record<string, unknown>>> = { user: [], session: [], account: [], verification: [] };
  const pg = drizzle(new PGlite(), { schema: catalogSchema });
  await migrateCatalog(pg);
  const cloudCatalog = new PostgresCatalogStore(pg);
  const storage = new MemoryObjectStorage();
  const files = new CloudFiles(storage);
  const auth = createAuth({
    database: memoryAdapter(authDb),
    baseURL: SERVER,
    secret: "test-secret-that-is-long-enough-to-use-123",
    mailer: new ConsoleMailer(() => undefined),
    providers: { google: { clientId: "id", clientSecret: "secret" } },
  });
  const app = createCloudApp({ auth, catalog: cloudCatalog, files, providers: ["google"] });

  /** The network: the cloud server, and signed requests to the storage provider. */
  const network: typeof fetch = async (input, init = {}) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith("memory:")) {
      const key = decodeURIComponent(url.slice("memory:".length));
      if (init.method === "PUT") {
        await storage.receive(key, new Uint8Array(await new Response(init.body as BodyInit).arrayBuffer()));
        return new Response(null, { status: 200 });
      }
      const bytes = storage.bytes(key);
      if (!bytes) return new Response(null, { status: 404 });
      const range = /bytes=(\d+)-(\d+)/.exec(new Headers(init.headers).get("range") ?? "");
      if (range) return new Response(bytes.slice(Number(range[1]), Number(range[2]) + 1), { status: 206 });
      return new Response(bytes);
    }
    return app.request(url, init);
  };

  const root = await mkdtemp(join(tmpdir(), "mem-e2e-"));
  const local = join(root, "Pictures");
  const other = join(root, "Restore");
  await mkdir(join(local, "Trip"), { recursive: true });
  await mkdir(other);
  await writeFile(join(local, "Trip", "beach.jpg"), "sunny beach bytes");

  const catalog = new SqliteCatalog(":memory:");
  const localVolumes = new MemoryVolumes();
  localVolumes.connect({ volumeId: "mac", mountPath: root, label: "Mac" });
  const opened: string[] = [];
  let ports: Ports;
  const cloud = new CloudService({
    serverUrl: SERVER,
    store: new MemoryStateStore(),
    changes: catalog.changes(),
    places: {
      list: () => catalog.listDrives(),
      register: (input) => registerDrive(ports, input),
    },
    openExternal: async (url) => void opened.push(url),
    device: { name: "Test Mac", platform: "darwin" },
    fetch: network,
  });
  await cloud.load();
  ports = {
    catalog,
    fileIO: new WithCloudFileIO(new NodeFileIO(), new CloudFileIO(cloud)),
    volumes: new WithCloudVolumes(localVolumes, new CloudVolumes(cloud)),
  };
  return { app, authDb, cloud, cloudCatalog, storage, catalog, ports, local, other, opened, network };
}

describe("desktop app with the cloud", () => {
  it("stays local until someone signs in", async () => {
    const w = await world();
    expect(await w.cloud.status()).toMatchObject({ available: true, providers: ["google"], user: null, sync: { enabled: false } });
    await expect(w.cloud.setSyncEnabled(true)).rejects.toThrow(/Sign in/);
    await expect(w.cloud.addStoragePlace()).rejects.toThrow(/Sign in/);
    expect(await w.ports.volumes.list()).toHaveLength(1);
  });

  it("syncs the local catalog into Postgres and keeps it up to date", async () => {
    const w = await world();
    const drive = await registerDrive(w.ports, { name: "Pictures", kind: "computer", rootPath: w.local });
    await ingestFolder(w.ports, { driveId: drive.id });

    const user = await w.cloud.signUp({ name: "Firdaus", email: "firdaus@example.com", password: "correct horse battery" });
    expect(user.role).toBe("user");
    await w.cloud.setSyncEnabled(true);
    await w.cloud.syncNow();

    const deviceId = (await w.cloudCatalog.listDevices(user.id))[0]!.id;
    expect((await w.cloudCatalog.listDevices(user.id))[0]).toMatchObject({ name: "Test Mac", platform: "darwin" });
    const synced = await w.cloudCatalog.snapshot(user.id, deviceId);
    expect(synced.find((r) => r.entity === "file")).toMatchObject({ data: { name: "beach.jpg", kind: "photo" } });
    expect(synced.find((r) => r.entity === "replica")).toMatchObject({ data: { relativePath: "Trip/beach.jpg" } });

    // A rename and a new folder reach the cloud on the next sync.
    const [file] = await w.catalog.listFiles();
    await w.catalog.upsertFile({ ...file!, name: "Beach day.jpg" });
    expect((await w.cloud.status()).sync.pending).toBe(1);
    await w.cloud.syncNow();
    const after = await w.cloudCatalog.snapshot(user.id, deviceId);
    expect(after.find((r) => r.entity === "file")).toMatchObject({ data: { name: "Beach day.jpg" } });
    expect((await w.cloud.status()).sync).toMatchObject({ pending: 0, error: null });
    expect((await w.cloud.status()).sync.lastSyncedAt).not.toBeNull();
  });

  it("uses cloud storage as a place: copy up, back up, and copy back down", async () => {
    const w = await world();
    const drive = await registerDrive(w.ports, { name: "Pictures", kind: "computer", rootPath: w.local });
    await ingestFolder(w.ports, { driveId: drive.id });
    const user = await w.cloud.signUp({ name: "Firdaus", email: "firdaus@example.com", password: "correct horse battery" });

    const place = await w.cloud.addStoragePlace();
    expect(place).toMatchObject({ kind: "cloud", online: true, name: "Memories Cloud" });
    expect((await w.cloud.addStoragePlace()).id).toBe(place.id);
    expect((await w.cloud.status()).storageDriveId).toBe(place.id);

    const [file] = await w.catalog.listFiles();
    const replica = await copyFileToDrive(w.ports, { fileId: file!.id, destDriveId: place.id });
    expect(replica).toMatchObject({ driveId: place.id, relativePath: "Trip/beach.jpg", status: "ready" });
    const stored = await w.storage.head(`users/${user.id}/files/Trip/beach.jpg`);
    expect(stored?.metadata.sha256).toBe(file!.objectHash);

    // A backup to the cloud skips what is already there.
    const job = await saveBackupJob(w.ports, { sourceDriveId: drive.id, destDriveId: place.id, sourceRelativePaths: [""] });
    expect(await runBackupJob(w.ports, job.id)).toMatchObject({ failed: 0 });

    // Browse it like any drive, and copy it back down to another folder.
    expect(await w.ports.fileIO.list(place.rootPath, "Trip")).toMatchObject([{ name: "beach.jpg", directory: false }]);
    const restore = await registerDrive(w.ports, { name: "Restore", kind: "computer", rootPath: w.other });
    await w.ports.fileIO.copy({ fromRoot: place.rootPath, fromRelative: "Trip/beach.jpg", toRoot: restore.rootPath, toRelative: "beach.jpg" });
    expect(await readFile(join(w.other, "beach.jpg"), "utf8")).toBe("sunny beach bytes");
    await expect(
      w.ports.fileIO.copy({ fromRoot: place.rootPath, fromRelative: "Trip/beach.jpg", toRoot: restore.rootPath, toRelative: "beach.jpg" }),
    ).rejects.toMatchObject({ code: "EEXIST" });

    // Signed out, the cloud place is offline and unreachable.
    await w.cloud.signOut();
    expect(await w.ports.volumes.list()).toHaveLength(1);
    await expect(w.ports.fileIO.list(place.rootPath)).rejects.toThrow(/Sign in/);
  });

  it("signs in with a provider through the system browser", async () => {
    const w = await world();
    // Someone with an account, signed in on the website in their browser.
    const browser = await w.app.request(`${SERVER}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "firdaus@example.com", password: "correct horse battery", name: "Firdaus" }),
    });
    const cookie = browser.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");

    const redirect = "http://127.0.0.1:47000/cloud/callback";
    await w.cloud.startSignIn("google", redirect);
    const opened = new URL(w.opened[0]!);
    expect(opened.pathname).toBe("/desktop/sign-in");
    expect(opened.searchParams.get("code_challenge_method")).toBe("S256");
    expect(opened.searchParams.get("code_challenge")).not.toContain("=");

    // After the provider, the browser lands on the hand-off with the same parameters.
    const authorize = new URL("/api/auth/desktop/authorize", SERVER);
    for (const name of ["redirect_uri", "state", "code_challenge", "code_challenge_method"]) {
      authorize.searchParams.set(name, opened.searchParams.get(name)!);
    }
    const handed = await w.app.request(authorize.toString(), { headers: { cookie } });
    const back = new URL(handed.headers.get("location")!);
    expect(back.origin + back.pathname).toBe(redirect);

    await expect(w.cloud.completeSignIn({ code: back.searchParams.get("code")!, state: "forged-state-value" })).rejects.toThrow(/not started here/);
    // A forged state also ends the attempt.
    await w.cloud.startSignIn("google", redirect);
    const retry = new URL(w.opened[1]!);
    const again = new URL("/api/auth/desktop/authorize", SERVER);
    for (const name of ["redirect_uri", "state", "code_challenge", "code_challenge_method"]) again.searchParams.set(name, retry.searchParams.get(name)!);
    const browser2 = await w.app.request(`${SERVER}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "firdaus@example.com", password: "correct horse battery" }),
    });
    const cookie2 = browser2.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
    const back2 = new URL((await w.app.request(again.toString(), { headers: { cookie: cookie2 } })).headers.get("location")!);
    const user = await w.cloud.completeSignIn({ code: back2.searchParams.get("code")!, state: back2.searchParams.get("state")! });
    expect(user.email).toBe("firdaus@example.com");
    expect((await w.cloud.status()).user?.email).toBe("firdaus@example.com");
  });

  it("lets an admin manage people from the app", async () => {
    const w = await world();
    const other = new CloudService({
      serverUrl: SERVER,
      store: new MemoryStateStore(),
      changes: new SqliteCatalog(":memory:").changes(),
      places: { list: async () => [], register: async () => Promise.reject(new Error("unused")) },
      openExternal: async () => undefined,
      device: { name: "Other PC", platform: "win32" },
      fetch: w.network,
    });
    await other.load();
    const someone = await other.signUp({ name: "Aisha", email: "aisha@example.com", password: "correct horse battery" });

    const me = await w.cloud.signUp({ name: "Firdaus", email: "firdaus@example.com", password: "correct horse battery" });
    await expect(w.cloud.listUsers()).rejects.toMatchObject({ status: 403 });
    w.authDb.user!.find((row) => row.id === me.id)!.role = "admin"; // what `npm run grant-admin` does
    expect((await w.cloud.refresh())?.role).toBe("admin");

    const { users } = await w.cloud.listUsers({ search: "aisha@" });
    expect(users).toMatchObject([{ email: "aisha@example.com", role: "user", banned: false }]);
    await w.cloud.banUser(someone.id, "testing");
    expect((await w.cloud.listUsers()).users.find((u) => u.id === someone.id)).toMatchObject({ banned: true, banReason: "testing" });
    await expect(other.refresh()).rejects.toMatchObject({ status: 401 });
    await w.cloud.unbanUser(someone.id);
    await w.cloud.setRole(someone.id, "admin");
    expect((await w.cloud.listUsers()).users.find((u) => u.id === someone.id)?.role).toBe("admin");
    await expect(w.cloud.removeUser(me.id)).rejects.toThrow(/own account/);
    await w.cloud.removeUser(someone.id);
    expect((await w.cloud.listUsers()).users.map((u) => u.email)).toEqual(["firdaus@example.com"]);
  });
});
