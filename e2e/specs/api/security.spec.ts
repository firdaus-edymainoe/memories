import { request as httpRequest } from "node:http";
import { symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, type Mem } from "../../support/fixtures.js";
import { jpeg, text } from "../../support/places.js";

async function onePlace(mem: Mem) {
  await writeFile(mem.path("secret.txt"), "outside the place");
  const root = await mem.place("Pictures", { "a.jpg": jpeg("a"), "Sub/b.txt": text("b") });
  const drive = await mem.addAndIngest({ name: "Pics", kind: "computer", rootPath: root });
  const usbVol = await mem.plugDrive("TRAVEL");
  const usb = await mem.addPlace({ name: "Travel USB", kind: "usb", rootPath: usbVol.mountPath });
  return { root, drive, usb };
}

/** Raw HTTP so the Host header can be spoofed (fetch and Playwright pin it). */
function rawGet(port: number, path: string, headers: Record<string, string>) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, path, method: "GET", headers }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

const TRAVERSALS = ["../secret.txt", "..%2fsecret.txt", "%2e%2e/secret.txt", "Sub/../../secret.txt", "..\\secret.txt", "Sub\\..\\..\\secret.txt"];

test.describe("path safety (API)", () => {
  for (const path of TRAVERSALS) {
    test(`drive media and entries refuse ${path}`, async ({ mem }) => {
      const { drive } = await onePlace(mem);
      for (const route of ["media", "entries"]) {
        const res = await mem.api.get(`/drives/${drive.id}/${route}?path=${path}`);
        expect(res.status(), route).toBe(400);
        expect(await res.text()).not.toContain("outside the place");
      }
    });
  }

  test("ingest, copy and relocate refuse paths outside the place", async ({ mem }) => {
    const { drive, usb } = await onePlace(mem);
    const file = await mem.fileByName("a.jpg");
    const checks = [
      mem.api.post("/ingest", { data: { driveId: drive.id, relativePath: "../" } }),
      mem.api.post(`/files/${file.id}/copy`, { data: { destDriveId: usb.id, destRelativePath: "../../escaped.jpg" } }),
      mem.api.post(`/files/${file.id}/relocate`, { data: { destDriveId: usb.id, destRelativePath: "../escaped.jpg" } }),
    ];
    for (const res of await Promise.all(checks)) {
      expect(res.status()).toBe(400);
      expect((await res.json()).error).toBe("Path escapes drive root");
    }
  });

  test("an absolute path is treated as inside the place", async ({ mem }) => {
    const { drive } = await onePlace(mem);
    const res = await mem.api.get(`/drives/${drive.id}/media?path=/etc/passwd`);
    expect(res.status()).not.toBe(200);
    expect(await res.text()).not.toContain("root:");
  });

  test("backup refuses folders outside the place", async ({ mem }) => {
    const { drive, usb } = await onePlace(mem);
    const res = await mem.api.post("/backups", { data: { sourceDriveId: drive.id, destDriveId: usb.id, sourceRelativePaths: ["../"] } });
    expect(res.status()).toBe(400);
  });

  test("a symlink inside a place cannot read files outside it", async ({ mem }) => {
    const { root, drive } = await onePlace(mem);
    await symlink(mem.path("secret.txt"), join(root, "link.txt"));
    const res = await mem.api.get(`/drives/${drive.id}/media?path=link.txt`);
    expect(await res.text()).not.toContain("outside the place");
  });

  test("a symlinked folder inside a place cannot list outside it", async ({ mem }) => {
    const { root, drive } = await onePlace(mem);
    await symlink(mem.dir, join(root, "dirlink"));
    const res = await mem.api.get(`/drives/${drive.id}/entries?path=dirlink`);
    const names = res.ok() ? ((await res.json()).entries as { name: string }[]).map((e) => e.name) : [];
    expect(names).not.toContain("secret.txt");
  });
});

test.describe("local API hardening (API)", () => {
  test("CORS only answers the Memories UI origin", async ({ mem }) => {
    const good = await mem.api.fetch("/drives", {
      method: "OPTIONS",
      headers: { Origin: "http://127.0.0.1:5173", "Access-Control-Request-Method": "POST" },
    });
    expect(good.headers()["access-control-allow-origin"]).toBe("http://127.0.0.1:5173");
    const evil = await mem.api.fetch("/drives", {
      method: "OPTIONS",
      headers: { Origin: "http://evil.example", "Access-Control-Request-Method": "POST" },
    });
    expect(evil.headers()["access-control-allow-origin"]).toBeUndefined();
  });

  test("a cross-origin 'simple' POST from a web page cannot change anything", async ({ mem }) => {
    const res = await mem.api.post("/folders", {
      headers: { Origin: "http://evil.example", "Content-Type": "text/plain" },
      data: JSON.stringify({ name: "planted-by-a-website" }),
    });
    const { folders } = await mem.json<{ folders: { name: string }[] }>("GET", "/folders");
    expect(folders.map((f) => f.name)).not.toContain("planted-by-a-website");
    expect(res.status()).toBe(403);
  });

  test("a JSON POST from a foreign origin is refused", async ({ mem }) => {
    const res = await mem.api.post("/folders", { headers: { Origin: "http://evil.example" }, data: { name: "planted" } });
    expect(res.status()).toBe(403);
  });

  test("changes that are not sent as JSON are refused even without an Origin", async ({ mem }) => {
    const res = await mem.api.post("/folders", { headers: { "Content-Type": "text/plain" }, data: JSON.stringify({ name: "x" }) });
    expect(res.status()).toBe(415);
    const form = await mem.api.post("/sync", { form: { a: "1" } });
    expect(form.status()).toBe(415);
  });

  test("the UI's own origin may still make changes", async ({ mem }) => {
    const res = await mem.api.post("/folders", { headers: { Origin: "http://127.0.0.1:5173" }, data: { name: "Family" } });
    expect(res.status()).toBe(201);
  });

  test("a cross-origin POST cannot register the whole disk as a place", async ({ mem }) => {
    await mem.api.post("/drives", {
      headers: { Origin: "http://evil.example", "Content-Type": "text/plain" },
      data: JSON.stringify({ name: "everything", kind: "computer", rootPath: "/" }),
    });
    expect((await mem.drives()).map((d) => d.rootPath)).not.toContain("/");
  });

  test("requests with a foreign Host header are refused (DNS rebinding)", async ({ mem }) => {
    const res = await rawGet(mem.server.port, "/drives", { Host: "attacker.example:80" });
    expect(res.status).toBe(403);
    expect((await rawGet(mem.server.port, "/health", { Host: `localhost:${mem.server.port}` })).status).toBe(200);
  });

  test("the API does not list the whole computer outside registered places", async ({ mem }) => {
    const res = await mem.api.get(`/volumes/entries?mount=${encodeURIComponent("/")}&path=etc`);
    expect(res.status()).toBe(403);
    const usbVol = await mem.plugDrive("TRAVEL");
    expect((await mem.api.get(`/volumes/entries?mount=${encodeURIComponent(usbVol.mountPath)}`)).status()).toBe(403);
  });

  test("volume browsing refuses traversal and unknown mounts", async ({ mem }) => {
    const usbVol = await mem.plugDrive("TRAVEL");
    expect((await mem.api.get(`/volumes/entries?mount=${encodeURIComponent(usbVol.mountPath)}&path=../..`)).status()).toBe(400);
    expect((await mem.api.get(`/volumes/entries?mount=${encodeURIComponent("/nope")}`)).status()).toBe(404);
  });

  test("malformed JSON is a 400 with a friendly message", async ({ mem }) => {
    const res = await mem.api.post("/drives", { headers: { "Content-Type": "application/json" }, data: Buffer.from("not json") });
    expect(res.status()).toBe(400);
  });

  test("the folder picker endpoint the UI calls exists", async ({ mem }) => {
    await mem.queuePicker("/Users/aisha/Pictures");
    const res = await mem.api.post("/pick-folder", { data: {} });
    expect([res.status(), await res.json()]).toEqual([200, { rootPath: "/Users/aisha/Pictures" }]);
    const cancelled = await mem.api.post("/pick-folder", { data: {} });
    expect(await cancelled.json()).toEqual({ rootPath: null });
    expect(await mem.pickerCalls()).toBe(2);
  });

  test("unknown routes are 404 and never 500", async ({ mem }) => {
    for (const path of ["/nope", "/files/x/y/z", "/drives/x/nope"]) {
      expect((await mem.api.get(path)).status(), path).toBe(404);
    }
  });
});
