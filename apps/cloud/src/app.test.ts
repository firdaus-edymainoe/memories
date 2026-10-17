import type { CloudCatalogStore, CloudDevice, SyncBatch, SyncRecord } from "@memories/core";
import { syncKey } from "@memories/core";
import { MemoryObjectStorage } from "@memories/storage";
import { memoryAdapter } from "better-auth/adapters/memory";
import { describe, expect, it } from "vitest";
import { createCloudApp } from "./app.js";
import { createAuth } from "./auth.js";
import { CloudFiles } from "./cloud-files.js";
import { pkceChallenge } from "./desktop-sign-in.js";
import { ConsoleMailer } from "./mailer.js";

const BASE = "http://cloud.test";
const SHA = "a".repeat(64);

/** Enough of a catalog store to see what the server stored. */
class FakeCatalog implements CloudCatalogStore {
  rows = new Map<string, Map<string, SyncRecord>>();
  devices = new Map<string, CloudDevice>();
  async registerDevice(userId: string, device: { id: string; name: string; platform: string }) {
    const row = { ...device, createdAt: new Date().toISOString(), lastSyncedAt: null };
    this.devices.set(`${userId}/${device.id}`, row);
    return row;
  }
  async listDevices(userId: string) {
    return [...this.devices.entries()].filter(([key]) => key.startsWith(`${userId}/`)).map(([, device]) => device);
  }
  async apply(userId: string, batch: SyncBatch) {
    const key = `${userId}/${batch.deviceId}`;
    if (batch.replace || !this.rows.has(key)) this.rows.set(key, new Map());
    for (const record of batch.records) {
      if (record.data) this.rows.get(key)!.set(syncKey(record), record);
      else this.rows.get(key)!.delete(syncKey(record));
    }
  }
  async snapshot(userId: string, deviceId: string) {
    return [...(this.rows.get(`${userId}/${deviceId}`)?.values() ?? [])];
  }
  async removeDevice(userId: string, deviceId: string) {
    this.rows.delete(`${userId}/${deviceId}`);
  }
  removed: string[] = [];
  async removeUser(userId: string) {
    this.removed.push(userId);
  }
}

function setup() {
  const db: Record<string, Array<Record<string, unknown>>> = { user: [], session: [], account: [], verification: [] };
  const mailer = new ConsoleMailer(() => undefined);
  const catalog = new FakeCatalog();
  const storage = new MemoryObjectStorage();
  const files = new CloudFiles(storage);
  const auth = createAuth({
    database: memoryAdapter(db),
    baseURL: BASE,
    secret: "test-secret-that-is-long-enough-to-use-123",
    mailer,
    providers: { google: { clientId: "google-id", clientSecret: "google-secret" } },
    onUserDeleted: async (userId) => {
      await catalog.removeUser(userId);
      await files.removeAll(userId);
    },
  });
  const app = createCloudApp({ auth, catalog, files, providers: ["google"] });

  const request = (path: string, init: RequestInit & { token?: string; cookie?: string } = {}) => {
    const headers = new Headers(init.headers);
    if (init.token) headers.set("authorization", `Bearer ${init.token}`);
    if (init.cookie) headers.set("cookie", init.cookie);
    if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
    return app.request(`${BASE}${path}`, { ...init, headers });
  };
  const json = (path: string, payload: unknown, init: RequestInit & { token?: string; cookie?: string } = {}) =>
    request(path, { method: "POST", body: JSON.stringify(payload), ...init });

  async function signUp(email: string, name = "Someone") {
    const response = await json("/api/auth/sign-up/email", { email, password: "correct horse battery", name });
    expect(response.status).toBe(200);
    const token = response.headers.get("set-auth-token");
    expect(token).toBeTruthy();
    return { token: token!, cookie: response.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ") };
  }

  function makeAdmin(email: string) {
    const user = db.user!.find((row) => row.email === email)!;
    user.role = "admin";
  }

  return { app, db, mailer, catalog, storage, request, json, signUp, makeAdmin };
}

describe("accounts", () => {
  it("signs up with email and password and is a user by default", async () => {
    const t = setup();
    const { token } = await t.signUp("firdaus@example.com", "Firdaus");
    const me = await (await t.request("/v1/me", { token })).json();
    expect(me.user).toMatchObject({ email: "firdaus@example.com", name: "Firdaus", role: "user", emailVerified: false });
    expect(t.mailer.sent.map((mail) => mail.subject)).toContain("Confirm your email for Memories");
  });

  it("refuses requests without a session", async () => {
    const t = setup();
    expect((await t.request("/v1/me")).status).toBe(401);
    expect((await t.request("/v1/me", { token: "nonsense" })).status).toBe(401);
    expect(await (await t.request("/v1/config")).json()).toEqual({ providers: ["google"], storage: "memory", drives: [] });
  });

  it("lets admins manage people while staying users themselves", async () => {
    const t = setup();
    const owner = await t.signUp("owner@example.com", "Owner");
    const other = await t.signUp("other@example.com", "Other");
    t.makeAdmin("owner@example.com");

    // A normal user cannot list people.
    expect((await t.request("/api/auth/admin/list-users", { token: other.token })).status).toBe(403);

    const listed = await (await t.request("/api/auth/admin/list-users", { token: owner.token })).json();
    expect(listed.users.map((user: { email: string }) => user.email).sort()).toEqual(["other@example.com", "owner@example.com"]);

    // The admin still uses the app like anyone else.
    expect((await t.json("/v1/sync", { deviceId: "mac", replace: true, records: [] }, { token: owner.token })).status).toBe(200);

    const otherId = listed.users.find((user: { email: string }) => user.email === "other@example.com").id;
    const banned = await t.json("/api/auth/admin/ban-user", { userId: otherId, banReason: "spam" }, { token: owner.token });
    expect(banned.status).toBe(200);
    expect((await t.request("/v1/me", { token: other.token })).status).toBe(401);

    const promoted = await t.json("/api/auth/admin/set-role", { userId: otherId, role: "admin" }, { token: owner.token });
    expect(promoted.status).toBe(200);
  });

  it("cleans up when an admin removes someone", async () => {
    const t = setup();
    const owner = await t.signUp("owner@example.com");
    const other = await t.signUp("other@example.com");
    t.makeAdmin("owner@example.com");
    const otherId = (await (await t.request("/v1/me", { token: other.token })).json()).user.id;
    await t.storage.put(`users/${otherId}/files/a.jpg`, new Uint8Array([1]));

    const removed = await t.json("/api/auth/admin/remove-user", { userId: otherId }, { token: owner.token });
    expect(removed.status).toBe(200);
    expect(t.catalog.removed).toEqual([otherId]);
    expect(await t.storage.head(`users/${otherId}/files/a.jpg`)).toBeNull();
  });
});

describe("desktop sign-in", () => {
  const redirect = "http://127.0.0.1:51234/cloud/callback";
  const verifier = "v".repeat(43);
  const state = "s".repeat(16);
  const authorizeQuery = () =>
    new URLSearchParams({ redirect_uri: redirect, state, code_challenge: pkceChallenge(verifier), code_challenge_method: "S256" });

  it("hands a browser session to the app with PKCE", async () => {
    const t = setup();
    const browser = await t.signUp("firdaus@example.com");

    const authorized = await t.request(`/api/auth/desktop/authorize?${authorizeQuery()}`, { cookie: browser.cookie });
    expect(authorized.status).toBe(302);
    const back = new URL(authorized.headers.get("location")!);
    expect(back.origin + back.pathname).toBe(redirect);
    expect(back.searchParams.get("state")).toBe(state);
    const code = back.searchParams.get("code")!;

    const wrong = await t.json("/api/auth/desktop/token", { code, code_verifier: "w".repeat(43), redirect_uri: redirect });
    expect(wrong.status).toBe(400);

    // A failed attempt used up the code too: start again.
    const again = await t.signUp("second@example.com");
    const second = await t.request(`/api/auth/desktop/authorize?${authorizeQuery()}`, { cookie: again.cookie });
    const code2 = new URL(second.headers.get("location")!).searchParams.get("code")!;
    const exchanged = await t.json("/api/auth/desktop/token", { code: code2, code_verifier: verifier, redirect_uri: redirect });
    expect(exchanged.status).toBe(200);
    const { token, user } = await exchanged.json();
    expect(user.email).toBe("second@example.com");

    expect((await (await t.request("/v1/me", { token })).json()).user.email).toBe("second@example.com");
    // The code works once, and the browser's session was ended.
    expect((await t.json("/api/auth/desktop/token", { code: code2, code_verifier: verifier, redirect_uri: redirect })).status).toBe(400);
    expect((await t.request("/v1/me", { cookie: again.cookie })).status).toBe(401);
  });

  it("only hands back to the app's own loopback address", async () => {
    const t = setup();
    const browser = await t.signUp("firdaus@example.com");
    for (const bad of ["https://evil.test/cloud/callback", "http://127.0.0.1/cloud/callback", "http://127.0.0.1:5000/other"]) {
      const query = authorizeQuery();
      query.set("redirect_uri", bad);
      expect((await t.request(`/api/auth/desktop/authorize?${query}`, { cookie: browser.cookie })).status).toBe(400);
    }
    expect((await t.request(`/api/auth/desktop/authorize?${authorizeQuery()}`)).status).toBe(401);
  });

  it("starts a social sign-in in the browser for configured providers only", async () => {
    const t = setup();
    const started = await t.request(`/desktop/sign-in?provider=google&${authorizeQuery()}`);
    expect(started.status).toBe(302);
    expect(new URL(started.headers.get("location")!).hostname).toBe("accounts.google.com");
    expect(started.headers.getSetCookie().length).toBeGreaterThan(0);
    expect((await t.request(`/desktop/sign-in?provider=github&${authorizeQuery()}`)).status).toBe(400);
  });
});

describe("sync", () => {
  const drive: SyncRecord = {
    entity: "drive",
    key: ["d1"],
    data: { id: "d1", name: "SSD", kind: "disk", rootPath: "/V", volumeId: "vol", online: true },
  };

  it("stores each person's device catalog separately", async () => {
    const t = setup();
    const a = await t.signUp("a@example.com");
    const b = await t.signUp("b@example.com");
    expect((await t.json("/v1/sync", { deviceId: "mac", replace: true, records: [drive] }, { token: a.token })).status).toBe(200);
    const aId = (await (await t.request("/v1/me", { token: a.token })).json()).user.id;
    const bId = (await (await t.request("/v1/me", { token: b.token })).json()).user.id;
    expect(await t.catalog.snapshot(aId, "mac")).toEqual([drive]);
    expect(await t.catalog.snapshot(bId, "mac")).toEqual([]);

    const registered = await t.request("/v1/devices/mac", {
      method: "PUT",
      token: a.token,
      body: JSON.stringify({ name: "Firdaus’s Mac", platform: "darwin" }),
    });
    expect(registered.status).toBe(200);
    expect((await (await t.request("/v1/devices", { token: a.token })).json()).devices).toMatchObject([{ id: "mac" }]);
  });

  it("refuses malformed batches and keys that don't match their data", async () => {
    const t = setup();
    const { token } = await t.signUp("a@example.com");
    const bad = [
      { deviceId: "mac", replace: false, records: [{ entity: "nope", key: ["x"], data: null }] },
      { deviceId: "mac", replace: false, records: [{ ...drive, key: ["other"] }] },
      { deviceId: "mac", replace: false, records: [{ ...drive, data: { ...(drive.data as object), online: "yes" } }] },
    ];
    for (const payload of bad) expect((await t.json("/v1/sync", payload, { token })).status).toBe(400);
  });
});

describe("cloud storage", () => {
  it("uploads through signed requests and never overwrites", async () => {
    const t = setup();
    const { token } = await t.signUp("a@example.com");
    const userId = (await (await t.request("/v1/me", { token })).json()).user.id;

    const prepared = await t.json("/v1/storage/uploads", { path: "Trips/a.jpg", size: 3, sha256: SHA, contentType: "image/jpeg" }, { token });
    expect(prepared.status).toBe(200);
    expect((await prepared.json()).upload).toMatchObject({ method: "PUT" });
    await t.storage.receive(`users/${userId}/files/Trips/a.jpg`, new Uint8Array([1, 2, 3]));

    const stat = await (await t.request("/v1/storage/stat?path=Trips/a.jpg", { token })).json();
    expect(stat.file).toMatchObject({ path: "Trips/a.jpg", size: 3, sha256: SHA, contentType: "image/jpeg" });
    expect((await t.json("/v1/storage/uploads", { path: "Trips/a.jpg", size: 3, sha256: SHA }, { token })).status).toBe(409);

    const listing = await (await t.request("/v1/storage/list?path=", { token })).json();
    expect(listing.entries).toEqual([{ path: "Trips", directory: true, size: 0, modifiedAt: null }]);
    const inner = await (await t.request("/v1/storage/list?path=Trips", { token })).json();
    expect(inner.entries).toMatchObject([{ path: "Trips/a.jpg", directory: false, size: 3 }]);

    expect((await t.json("/v1/storage/copy", { from: "Trips/a.jpg", to: "b.jpg" }, { token })).status).toBe(200);
    expect((await t.json("/v1/storage/copy", { from: "Trips/a.jpg", to: "b.jpg" }, { token })).status).toBe(409);
    expect((await t.json("/v1/storage/downloads", { path: "b.jpg" }, { token })).status).toBe(200);
    expect((await t.request("/v1/storage/object?path=b.jpg", { method: "DELETE", token })).status).toBe(200);
    expect((await t.request("/v1/storage/stat?path=b.jpg", { token })).status).toBe(404);
  });

  it("keeps people out of each other's files and paths inside their space", async () => {
    const t = setup();
    const a = await t.signUp("a@example.com");
    const b = await t.signUp("b@example.com");
    const aId = (await (await t.request("/v1/me", { token: a.token })).json()).user.id;
    await t.storage.put(`users/${aId}/files/secret.jpg`, new Uint8Array([1]));

    expect((await t.request("/v1/storage/stat?path=secret.jpg", { token: b.token })).status).toBe(404);
    expect((await t.request(`/v1/storage/stat?path=../../${aId}/files/secret.jpg`, { token: b.token })).status).toBe(400);
    expect((await t.json("/v1/storage/uploads", { path: "/abs.jpg", size: 1, sha256: SHA }, { token: b.token })).status).toBe(400);
    expect((await t.json("/v1/storage/uploads", { path: "x.jpg", size: 1, sha256: "nothex" }, { token: b.token })).status).toBe(400);
  });
});
