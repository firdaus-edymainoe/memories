import { type CloudStatus, type CloudUser, MemoryCatalog, MemoryFileIO, MemoryVolumes } from "@memories/core";
import { describe, expect, it } from "vitest";
import { type CloudControl, createApp } from "./index.js";

const user: CloudUser = { id: "u1", email: "a@example.com", name: "Aisha", role: "admin", emailVerified: true, image: null };

function fakeCloud(overrides: Partial<CloudControl> = {}) {
  const calls: Array<[string, unknown]> = [];
  const record =
    (name: string, result: unknown = undefined) =>
    async (input?: unknown, extra?: unknown) => {
      calls.push([name, extra === undefined ? input : [input, extra]]);
      return result;
    };
  const status: CloudStatus = {
    available: true,
    serverUrl: "https://cloud.test",
    providers: ["google"],
    user,
    sync: { enabled: false, pending: 0, lastSyncedAt: null, error: null, running: false },
    storageDriveId: null,
  };
  const cloud = {
    status: async () => status,
    signUp: record("signUp", user),
    signIn: record("signIn", user),
    startSignIn: record("startSignIn", { url: "https://cloud.test/desktop/sign-in" }),
    completeSignIn: record("completeSignIn", user),
    signOut: record("signOut"),
    forgotPassword: record("forgotPassword"),
    resendVerification: record("resendVerification"),
    refresh: record("refresh", user),
    setSyncEnabled: record("setSyncEnabled"),
    syncNow: record("syncNow"),
    addStoragePlace: record("addStoragePlace", { id: "drv_cloud", kind: "cloud" }),
    listUsers: record("listUsers", { users: [], total: 0 }),
    setRole: record("setRole"),
    banUser: record("banUser"),
    unbanUser: record("unbanUser"),
    removeUser: record("removeUser"),
    ...overrides,
  } as CloudControl;
  return { cloud, calls };
}

function app(cloud?: CloudControl, onCloudSignedIn?: () => void) {
  return createApp(
    { catalog: new MemoryCatalog(), fileIO: new MemoryFileIO(), volumes: new MemoryVolumes() },
    { token: "launch-token", ...(cloud ? { cloud } : {}), ...(onCloudSignedIn ? { onCloudSignedIn } : {}) },
  );
}

const post = (path: string, body: unknown = {}) => ({
  method: "POST",
  headers: { "content-type": "application/json", "x-memories-token": "launch-token" },
  body: JSON.stringify(body),
});

describe("cloud routes", () => {
  it("reports local only when no cloud is configured", async () => {
    const res = await app().request("/cloud/status", { headers: { "x-memories-token": "launch-token" } });
    expect((await res.json()).status).toMatchObject({ available: false, user: null });
    expect((await app().request("/cloud/sign-in", post("/cloud/sign-in"))).status).toBe(404);
  });

  it("still needs the launch token, except for the browser callback", async () => {
    const { cloud } = fakeCloud();
    expect((await app(cloud).request("/cloud/status")).status).toBe(401);
    expect((await app(cloud).request("/cloud/callback?code=c&state=s")).status).toBe(200);
  });

  it("starts a provider sign-in with this server's own callback", async () => {
    const { cloud, calls } = fakeCloud();
    const res = await app(cloud).request("http://127.0.0.1:4100/cloud/sign-in/provider", post("", { provider: "google" }));
    expect(res.status).toBe(200);
    expect(calls).toEqual([["startSignIn", ["google", "http://127.0.0.1:4100/cloud/callback"]]]);
    expect((await app(cloud).request("/cloud/sign-in/provider", post("", { provider: "myspace" }))).status).toBe(400);
  });

  it("finishes a browser sign-in and tells the host", async () => {
    let signedIn = 0;
    const { cloud, calls } = fakeCloud();
    const res = await app(cloud, () => signedIn++).request("/cloud/callback?code=abc&state=xyz");
    expect(await res.text()).toContain("signed in");
    expect(calls).toEqual([["completeSignIn", { code: "abc", state: "xyz" }]]);
    expect(signedIn).toBe(1);

    const failing = fakeCloud({ completeSignIn: async () => Promise.reject(new Error("took too long")) });
    const bad = await app(failing.cloud).request("/cloud/callback?code=abc&state=xyz");
    expect(bad.status).toBe(400);
    expect(await bad.text()).toContain("took too long");
  });

  it("passes cloud errors through with their status", async () => {
    const forbidden = Object.assign(new Error("Only admins can do that"), { status: 403 });
    const { cloud } = fakeCloud({ listUsers: async () => Promise.reject(forbidden) });
    const res = await app(cloud).request("/cloud/admin/users", { headers: { "x-memories-token": "launch-token" } });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Only admins can do that" });
  });

  it("manages people and sync", async () => {
    const { cloud, calls } = fakeCloud();
    const a = app(cloud);
    expect((await a.request("/cloud/admin/users/u2/role", post("", { role: "admin" }))).status).toBe(200);
    expect((await a.request("/cloud/admin/users/u2/role", post("", { role: "owner" }))).status).toBe(400);
    await a.request("/cloud/admin/users/u2/ban", post("", { reason: "spam" }));
    await a.request("/cloud/admin/users/u2/unban", post(""));
    await a.request("/cloud/admin/users/u2/remove", post(""));
    await a.request("/cloud/sync/enabled", post("", { enabled: true }));
    expect((await a.request("/cloud/storage", post(""))).status).toBe(201);
    expect(calls.map(([name]) => name)).toEqual(["setRole", "banUser", "unbanUser", "removeUser", "setSyncEnabled", "addStoragePlace"]);
  });
});
