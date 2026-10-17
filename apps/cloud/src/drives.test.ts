import type { DriveConnectionRecord, DriveConnectionStore } from "@memories/core";
import { GoogleDriveProvider, MemoryObjectStorage } from "@memories/storage";
import { FakeGoogleDrive, sendSignedUpload } from "@memories/storage/testing";
import { memoryAdapter } from "better-auth/adapters/memory";
import { describe, expect, it } from "vitest";
import { createCloudApp } from "./app.js";
import { createAuth } from "./auth.js";
import { CloudFiles } from "./cloud-files.js";
import { pkceChallenge } from "./desktop-sign-in.js";
import { DriveConnections } from "./drive-connections.js";
import { ConsoleMailer } from "./mailer.js";
import { TokenVault } from "./token-vault.js";

const BASE = "http://cloud.test";
const APP_CALLBACK = "http://127.0.0.1:4567/cloud/drives/callback";
const VERIFIER = "v".repeat(43);
const SHA = "b".repeat(64);

class MemoryConnectionStore implements DriveConnectionStore {
  rows = new Map<string, DriveConnectionRecord>();
  async list(userId: string) {
    return [...this.rows.values()].filter((row) => row.userId === userId);
  }
  async get(userId: string, id: string) {
    return this.rows.get(`${userId}/${id}`) ?? null;
  }
  async findByAccount(userId: string, provider: string, accountId: string) {
    return [...this.rows.values()].find((row) => row.userId === userId && row.provider === provider && row.accountId === accountId) ?? null;
  }
  async save(record: DriveConnectionRecord) {
    this.rows.set(`${record.userId}/${record.id}`, structuredClone(record));
  }
  async remove(userId: string, id: string) {
    this.rows.delete(`${userId}/${id}`);
  }
  async removeUser(userId: string) {
    for (const row of await this.list(userId)) this.rows.delete(`${userId}/${row.id}`);
  }
}

/** Google's token endpoint and Drive API, faked. Each code is a different Google account. */
function fakeGoogle() {
  const drive = new FakeGoogleDrive();
  drive.owners.set("token-2", { permissionId: "acc-2", emailAddress: "work@example.com", displayName: "Work" });
  drive.tokens.add("token-2");
  const revoked = new Set<string>();
  const refreshed: string[] = [];
  let issued = 10;
  const accessFor: Record<string, string> = { "code-1": "token-1", "code-2": "token-2" };
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    if (url.host === "oauth2.googleapis.com" && url.pathname === "/revoke") {
      revoked.add(url.searchParams.get("token")!);
      return new Response("{}");
    }
    if (url.host === "oauth2.googleapis.com") {
      const form = new URLSearchParams(String(init?.body));
      if (form.get("grant_type") === "authorization_code") {
        const access = accessFor[form.get("code")!];
        if (!access || !form.get("code_verifier")) return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 });
        return new Response(JSON.stringify({ access_token: access, refresh_token: `refresh-${access}`, expires_in: 3600 }));
      }
      const refresh = form.get("refresh_token")!;
      refreshed.push(refresh);
      if (revoked.has(refresh)) return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 });
      const access = `token-${issued++}`;
      drive.tokens.add(access);
      drive.owners.set(access, drive.owners.get("token-1")!);
      return new Response(JSON.stringify({ access_token: access, expires_in: 3600 }));
    }
    return drive.fetch(input, init);
  }) as typeof fetch;
  return { drive, fetchImpl, revoked, refreshed };
}

function setup() {
  const google = fakeGoogle();
  // Providers stamp token expiry with the real clock, so start from it.
  let now = new Date();
  const store = new MemoryConnectionStore();
  const drives = new DriveConnections({
    providers: new Map([["google-drive", new GoogleDriveProvider({ clientId: "gid", clientSecret: "gs" }, google.fetchImpl)]]),
    store,
    vault: new TokenVault("test-secret-that-is-long-enough-to-use-123", "drive-connections"),
    baseURL: BASE,
    now: () => now,
  });
  const auth = createAuth({
    database: memoryAdapter({ user: [], session: [], account: [], verification: [] }),
    baseURL: BASE,
    secret: "test-secret-that-is-long-enough-to-use-123",
    mailer: new ConsoleMailer(() => undefined),
  });
  const app = createCloudApp({
    auth,
    catalog: {} as never,
    files: new CloudFiles(new MemoryObjectStorage()),
    drives,
    providers: [],
  });

  const request = (path: string, init: RequestInit & { token?: string } = {}) => {
    const headers = new Headers(init.headers);
    if (init.token) headers.set("authorization", `Bearer ${init.token}`);
    if (init.body) headers.set("content-type", "application/json");
    return app.request(`${BASE}${path}`, { ...init, headers });
  };
  const post = (path: string, payload: unknown, token?: string) =>
    request(path, { method: "POST", body: JSON.stringify(payload), ...(token ? { token } : {}) });

  async function signUp(email: string) {
    const response = await post("/api/auth/sign-up/email", { email, password: "correct horse battery", name: "Someone" });
    return response.headers.get("set-auth-token")!;
  }

  /** The whole browser round trip: start, provider callback, back to the app. */
  async function connect(token: string, code: string, verifier = VERIFIER) {
    const started = await post("/v1/drives/connect", { provider: "google-drive", redirectUri: APP_CALLBACK, state: "app-state-123456789", codeChallenge: pkceChallenge(VERIFIER) }, token);
    expect(started.status).toBe(200);
    const authorize = new URL((await started.json()).url);
    expect(authorize.origin).toBe("https://accounts.google.com");
    expect(authorize.searchParams.get("redirect_uri")).toBe(`${BASE}/drives/callback`);
    const callback = await request(`/drives/callback?code=${code}&state=${encodeURIComponent(authorize.searchParams.get("state")!)}`);
    expect(callback.status).toBe(302);
    const back = new URL(callback.headers.get("location")!);
    expect(`${back.origin}${back.pathname}`).toBe(APP_CALLBACK);
    expect(back.searchParams.get("state")).toBe("app-state-123456789");
    return post("/v1/drives/complete", { code: back.searchParams.get("code"), codeVerifier: verifier, redirectUri: APP_CALLBACK }, token);
  }

  return { app, request, post, signUp, connect, store, google, advance: (ms: number) => (now = new Date(now.getTime() + ms)) };
}

describe("connected drives", () => {
  it("connects several drives and uses them through the storage API", async () => {
    const t = setup();
    const token = await t.signUp("firdaus@example.com");
    const first = await t.connect(token, "code-1");
    expect(first.status).toBe(200);
    const drive = (await first.json()).drive;
    expect(drive).toMatchObject({ provider: "google-drive", label: "Google Drive (me@gmail.com)", status: "connected" });

    const second = (await (await t.connect(token, "code-2")).json()).drive;
    expect(second.id).not.toBe(drive.id);
    // Connecting the same account again updates it rather than adding a third.
    expect((await (await t.connect(token, "code-1")).json()).drive.id).toBe(drive.id);
    const listed = await (await t.request("/v1/drives", { token })).json();
    expect(listed).toMatchObject({ providers: ["google-drive"] });
    expect(listed.drives.map((d: { email: string }) => d.email)).toEqual(["me@gmail.com", "work@example.com"]);

    const upload = await (await t.post(`/v1/drives/${drive.id}/storage/uploads`, { path: "trip/a.txt", size: 2, sha256: SHA, contentType: "text/plain" }, token)).json();
    expect((await sendSignedUpload(t.google.fetchImpl, upload.upload, new TextEncoder().encode("hi"))).ok).toBe(true);
    const stat = await (await t.request(`/v1/drives/${drive.id}/storage/stat?path=trip/a.txt`, { token })).json();
    expect(stat.file).toMatchObject({ size: 2, sha256: SHA });
    expect(t.google.drive.paths()).toEqual(["trip/a.txt"]);
    // Taken paths are refused, like Memories Cloud.
    expect((await t.post(`/v1/drives/${drive.id}/storage/uploads`, { path: "trip/a.txt", size: 2, sha256: SHA }, token)).status).toBe(409);
    // Memories Cloud is still its own space.
    expect((await (await t.request("/v1/storage/list", { token })).json()).entries).toEqual([]);
  });

  it("keeps each person's drives to themselves", async () => {
    const t = setup();
    const mine = await t.signUp("me@example.com");
    const theirs = await t.signUp("them@example.com");
    const drive = (await (await t.connect(mine, "code-1")).json()).drive;
    expect((await t.request(`/v1/drives/${drive.id}/storage/list`, { token: theirs })).status).toBe(404);
    expect((await (await t.request("/v1/drives", { token: theirs })).json()).drives).toEqual([]);
  });

  it("only finishes for the app and account that started it", async () => {
    const t = setup();
    const token = await t.signUp("me@example.com");
    expect((await t.connect(token, "code-1", "w".repeat(43))).status).toBe(400);
    expect((await t.request("/drives/callback?code=x&state=forged")).status).toBe(400);
    expect((await t.post("/v1/drives/connect", { provider: "google-drive", redirectUri: "https://evil.test/cloud/drives/callback", state: "s".repeat(20), codeChallenge: pkceChallenge(VERIFIER) }, token)).status).toBe(400);
    expect((await t.post("/v1/drives/connect", { provider: "onedrive", redirectUri: APP_CALLBACK, state: "s".repeat(20), codeChallenge: pkceChallenge(VERIFIER) }, token)).status).toBe(400);
  });

  it("sends the app back with an error when the person says no", async () => {
    const t = setup();
    const token = await t.signUp("me@example.com");
    const started = await (await t.post("/v1/drives/connect", { provider: "google-drive", redirectUri: APP_CALLBACK, state: "app-state-123456789", codeChallenge: pkceChallenge(VERIFIER) }, token)).json();
    const state = new URL(started.url).searchParams.get("state")!;
    const back = new URL((await t.request(`/drives/callback?error=access_denied&state=${encodeURIComponent(state)}`)).headers.get("location")!);
    expect(back.searchParams.get("error")).toBe("access_denied");
    expect(back.searchParams.has("code")).toBe(false);
  });

  it("refreshes expired tokens, and asks to reconnect when access is revoked", async () => {
    const t = setup();
    const token = await t.signUp("me@example.com");
    const drive = (await (await t.connect(token, "code-1")).json()).drive;
    t.advance(2 * 3600_000);
    expect((await t.request(`/v1/drives/${drive.id}/storage/list`, { token })).status).toBe(200);
    expect(t.google.refreshed).toEqual(["refresh-token-1"]);

    t.google.revoked.add("refresh-token-1");
    t.advance(2 * 3600_000);
    const refused = await t.request(`/v1/drives/${drive.id}/storage/list`, { token });
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ code: "RECONNECT" });
    expect((await (await t.request("/v1/drives", { token })).json()).drives[0].status).toBe("reconnect");
    // Connecting it again brings it back under the same id.
    t.google.revoked.clear();
    expect((await (await t.connect(token, "code-1")).json()).drive).toMatchObject({ id: drive.id, status: "connected" });
  });

  it("renames and disconnects, revoking access and leaving the files", async () => {
    const t = setup();
    const token = await t.signUp("me@example.com");
    const drive = (await (await t.connect(token, "code-1")).json()).drive;
    const renamed = await t.request(`/v1/drives/${drive.id}`, { method: "PATCH", body: JSON.stringify({ label: "Family photos" }), token });
    expect((await renamed.json()).drive.label).toBe("Family photos");
    expect((await t.request(`/v1/drives/${drive.id}`, { method: "DELETE", token })).status).toBe(200);
    expect(t.google.revoked.has("refresh-token-1")).toBe(true);
    expect((await (await t.request("/v1/drives", { token })).json()).drives).toEqual([]);
    expect([...t.store.rows.values()][0]?.sealedTokens ?? null).toBeNull();
  });

  it("never stores tokens in the clear", async () => {
    const t = setup();
    const token = await t.signUp("me@example.com");
    await t.connect(token, "code-1");
    const row = [...t.store.rows.values()][0]!;
    expect(row.sealedTokens).not.toContain("refresh-token-1");
    expect(row.sealedTokens).not.toContain("token-1");
  });
});
