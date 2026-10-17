import { describe, expect, it } from "vitest";
import { FakeGoogleDrive, FakeGraph, FakeTokens, sendSignedUpload } from "./drive-fakes.js";
import {
  DriveAuthorizationError,
  GoogleDriveProvider,
  GoogleDriveStorage,
  MemoryObjectStorage,
  ObjectExistsError,
  ObjectNotFoundError,
  type ObjectStorage,
  OneDriveProvider,
  OneDriveStorage,
  createDriveProviders,
  driveProviderSettingsFromEnv,
} from "./index.js";

const bytes = (text: string) => new TextEncoder().encode(text);
const text = (data: Uint8Array) => new TextDecoder().decode(data);

/** One storage plus how a client sends bytes to it and reads them back. */
type Harness = {
  storage: ObjectStorage;
  upload(key: string, data: Uint8Array, sha256?: string): Promise<void>;
  download(key: string): Promise<string>;
};

function memoryHarness(): Harness {
  const storage = new MemoryObjectStorage();
  return {
    storage,
    async upload(key, data, sha256 = "s") {
      await storage.presignUpload(key, { size: data.byteLength, contentType: "text/plain", metadata: { sha256 } });
      await storage.receive(key, data);
    },
    async download(key) {
      await storage.presignDownload(key);
      return text(storage.bytes(key)!);
    },
  };
}

function signedHarness(storage: ObjectStorage, fetchImpl: typeof fetch): Harness {
  return {
    storage,
    async upload(key, data, sha256 = "s") {
      const request = await storage.presignUpload(key, { size: data.byteLength, contentType: "text/plain", metadata: { sha256 } });
      const response = await sendSignedUpload(fetchImpl, request, data);
      if (!response.ok) throw new Error(`upload failed: ${response.status} ${await response.text()}`);
    },
    async download(key) {
      const request = await storage.presignDownload(key);
      const response = await fetchImpl(request.url, { headers: request.headers });
      return text(new Uint8Array(await response.arrayBuffer()));
    },
  };
}

function googleHarness() {
  const drive = new FakeGoogleDrive();
  const storage = new GoogleDriveStorage({ tokens: new FakeTokens(), rootFolderId: "root-folder", fetch: drive.fetch });
  return { ...signedHarness(storage, drive.fetch), drive };
}

function oneDriveHarness() {
  const graph = new FakeGraph();
  // Tiny pieces so the chunked upload path runs on small test files.
  const storage = new OneDriveStorage({ tokens: new FakeTokens(), fetch: graph.fetch, chunkBytes: 4 });
  return { ...signedHarness(storage, graph.fetch), graph };
}

/** Every adapter keeps the same contract the rest of the app relies on. */
describe.each([
  ["memory", memoryHarness],
  ["google-drive", googleHarness],
  ["onedrive", oneDriveHarness],
] as const)("ObjectStorage contract: %s", (_name, make) => {
  it("stores uploads with their metadata and reads them back", async () => {
    const { storage, upload, download } = make();
    await upload("users/u1/files/trip/a.txt", bytes("hello world"), "abc");
    expect(await storage.head("users/u1/files/trip/a.txt")).toMatchObject({ key: "users/u1/files/trip/a.txt", size: 11, metadata: { sha256: "abc" } });
    expect(await download("users/u1/files/trip/a.txt")).toBe("hello world");
    expect(await storage.head("users/u1/files/trip/missing.txt")).toBeNull();
    expect(await storage.head("users/u1/files/trip/")).toBeNull();
  });

  it("lists one level with a delimiter, or everything below", async () => {
    const { storage, upload } = make();
    await upload("p/a.jpg", bytes("a"));
    await upload("p/trip/b.jpg", bytes("b"));
    await upload("p/trip/c/d.jpg", bytes("d"));
    const listing = await storage.list("p/", { delimiter: "/" });
    expect(listing.objects.map((o) => o.key)).toEqual(["p/a.jpg"]);
    expect(listing.prefixes).toEqual(["p/trip/"]);
    expect((await storage.list("p/")).objects.map((o) => o.key)).toEqual(["p/a.jpg", "p/trip/b.jpg", "p/trip/c/d.jpg"]);
    expect((await storage.list("nothing/")).objects).toEqual([]);
  });

  it("never overwrites on upload or copy", async () => {
    const { storage, upload, download } = make();
    await upload("a.txt", bytes("one"));
    await expect(storage.presignUpload("a.txt", { size: 3, contentType: "text/plain" })).rejects.toBeInstanceOf(ObjectExistsError);
    await upload("b.txt", bytes("two"));
    await expect(storage.copy("a.txt", "b.txt")).rejects.toBeInstanceOf(ObjectExistsError);
    expect(await download("b.txt")).toBe("two");
    await expect(storage.copy("missing.txt", "c.txt")).rejects.toBeInstanceOf(ObjectNotFoundError);
  });

  it("copies into new folders, keeping metadata, and deletes", async () => {
    const { storage, upload, download } = make();
    await upload("a.txt", bytes("one"), "h1");
    await storage.copy("a.txt", "backup/2026/a.txt");
    expect(await storage.head("backup/2026/a.txt")).toMatchObject({ size: 3, metadata: { sha256: "h1" } });
    expect(await download("backup/2026/a.txt")).toBe("one");
    await storage.delete("a.txt");
    await storage.delete("never-there.txt");
    expect(await storage.exists("a.txt")).toBe(false);
    await expect(storage.presignDownload("a.txt")).rejects.toBeInstanceOf(ObjectNotFoundError);
  });

  it("keeps a scoped view inside its prefix", async () => {
    const { storage, upload } = make();
    await upload("users/other/secret.txt", bytes("no"));
    const mine = storage.scoped("users/me/files/");
    await upload("users/me/files/notes.txt", bytes("hi"));
    expect((await mine.list("")).objects.map((o) => o.key)).toEqual(["notes.txt"]);
    expect(await mine.head("notes.txt")).toMatchObject({ key: "notes.txt", size: 2 });
  });
});

describe("GoogleDriveStorage", () => {
  it("keeps files in the app's folder and moves deleted ones to the trash", async () => {
    const { storage, upload, drive } = googleHarness();
    await upload("trip/a.txt", bytes("a"));
    expect(drive.paths()).toEqual(["trip/a.txt"]);
    await storage.delete("trip/a.txt");
    expect(drive.paths()).toEqual([]);
    expect([...drive.files.values()].find((file) => file.name === "a.txt")?.trashed).toBe(true);
  });

  it("gets a new token once when Google refuses the old one", async () => {
    const drive = new FakeGoogleDrive();
    const tokens = new FakeTokens();
    drive.tokens = new Set(["token-2"]);
    const storage = new GoogleDriveStorage({ tokens, rootFolderId: "root-folder", fetch: drive.fetch });
    expect(await storage.head("a.txt")).toBeNull();
    expect(tokens.expired).toBe(1);
  });

  it("handles names with quotes", async () => {
    const { storage, upload } = googleHarness();
    await upload("it's/o'clock.txt", bytes("x"));
    expect(await storage.head("it's/o'clock.txt")).toMatchObject({ size: 1 });
  });
});

describe("OneDriveStorage", () => {
  it("uploads in pieces without sending a token to the upload URL", async () => {
    const { storage, upload, graph } = oneDriveHarness();
    await upload("big/file.txt", bytes("0123456789abcdef!"));
    expect(graph.paths()).toEqual(["big/file.txt"]);
    expect(await storage.head("big/file.txt")).toMatchObject({ size: 17 });
  });

  it("uploads empty files", async () => {
    const { storage, upload } = oneDriveHarness();
    await upload("empty.txt", new Uint8Array());
    expect(await storage.head("empty.txt")).toMatchObject({ size: 0 });
  });

  it("reports no metadata where OneDrive drops descriptions (work accounts)", async () => {
    const { storage, upload, graph } = oneDriveHarness();
    graph.keepDescriptions = false;
    await upload("a.txt", bytes("abc"), "h");
    expect(await storage.head("a.txt")).toMatchObject({ size: 3, metadata: {} });
  });

  it("follows pages when listing a folder", async () => {
    const { storage, upload } = oneDriveHarness();
    for (const name of ["a", "b", "c", "d", "e"]) await upload(`many/${name}.txt`, bytes(name));
    expect((await storage.list("many/")).objects).toHaveLength(5);
  });
});

describe("drive providers", () => {
  const google = new GoogleDriveProvider({ clientId: "gid", clientSecret: "gsecret" });
  const onedrive = new OneDriveProvider({ clientId: "mid", clientSecret: "msecret" });

  it("asks for the narrowest access, a refresh token and an account picker", () => {
    const url = new URL(google.authorizeUrl({ redirectUri: "https://cloud.test/drives/callback", state: "s", codeChallenge: "c" }));
    expect(url.searchParams.get("scope")).toContain("https://www.googleapis.com/auth/drive.file");
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toContain("select_account");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");

    const ms = new URL(onedrive.authorizeUrl({ redirectUri: "https://cloud.test/drives/callback", state: "s", codeChallenge: "c" }));
    expect(ms.pathname).toBe("/common/oauth2/v2.0/authorize");
    expect(ms.searchParams.get("scope")).toBe("offline_access User.Read Files.ReadWrite.AppFolder");
  });

  it("refreshes tokens, keeps the refresh token, and spots a revoked grant", async () => {
    const seen: URLSearchParams[] = [];
    let revoked = false;
    const provider = new OneDriveProvider({ clientId: "mid", clientSecret: "msecret" }, (async (_url: RequestInfo | URL, init?: RequestInit) => {
      seen.push(new URLSearchParams(String(init?.body)));
      if (revoked) return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 });
      return new Response(JSON.stringify({ access_token: "new", expires_in: 60 }));
    }) as typeof fetch);
    const tokens = await provider.refresh("keep-me");
    expect(tokens).toMatchObject({ accessToken: "new", refreshToken: "keep-me" });
    expect(seen[0]!.get("scope")).toContain("Files.ReadWrite.AppFolder");
    revoked = true;
    await expect(provider.refresh("keep-me")).rejects.toBeInstanceOf(DriveAuthorizationError);
  });

  it("offers only the drives with an OAuth client", () => {
    const settings = driveProviderSettingsFromEnv({ GOOGLE_DRIVE_CLIENT_ID: "a", GOOGLE_DRIVE_CLIENT_SECRET: "b", ONEDRIVE_CLIENT_ID: "c" });
    expect([...createDriveProviders(settings).keys()]).toEqual(["google-drive"]);
  });
});
