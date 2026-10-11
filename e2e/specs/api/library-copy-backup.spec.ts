import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, type Mem } from "../../support/fixtures.js";
import { familyPictures, jpeg, pdf, sha256, text } from "../../support/places.js";

async function twoPlaces(mem: Mem) {
  const root = await mem.place("Pictures", familyPictures());
  const pics = await mem.addAndIngest({ name: "Pictures", kind: "computer", rootPath: root });
  const usbVol = await mem.plugDrive("TRAVEL");
  const usb = await mem.addPlace({ name: "Travel USB", kind: "usb", rootPath: usbVol.mountPath });
  return { root, pics, usb, usbVol };
}

test.describe("library (API)", () => {
  test("the same bytes in two places are one library item with two copies", async ({ mem }) => {
    const a = await mem.place("A", { "IMG_0001.jpg": jpeg("same") });
    const b = await mem.place("B", { "Wedding/first.jpg": jpeg("same") });
    await mem.addAndIngest({ name: "A", kind: "computer", rootPath: a });
    await mem.addAndIngest({ name: "B", kind: "computer", rootPath: b });
    const files = await mem.files();
    expect(files).toHaveLength(1);
    const detail = await mem.detail(files[0]!.id);
    expect(detail.replicas.map((r) => [r.drive.name, r.replica.relativePath]).sort()).toEqual([
      ["A", "IMG_0001.jpg"],
      ["B", "Wedding/first.jpg"],
    ]);
    expect(detail.object).toEqual({ hash: sha256(jpeg("same")), size: jpeg("same").length, mime: "image/jpeg" });
  });

  test("mark as sorted clears the New flag and survives filters", async ({ mem }) => {
    await twoPlaces(mem);
    const file = await mem.fileByName("notes.txt");
    const placed = await mem.json<{ file: { inbox: boolean } }>("POST", `/files/${file.id}/place`);
    expect(placed.file.inbox).toBe(false);
    expect((await mem.files("?inbox=true")).map((f) => f.name)).not.toContain("notes.txt");
    expect((await mem.files("?inbox=false")).map((f) => f.name)).toEqual(["notes.txt"]);
    expect((await mem.api.post("/files/file_nope/place", { data: {} })).status()).toBe(404);
  });

  test("serves a photo's bytes with its type", async ({ mem }) => {
    await twoPlaces(mem);
    const file = await mem.fileByName("First dance.jpg");
    const res = await mem.api.get(`/files/${file.id}/media`);
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toBe("image/jpeg");
    expect(sha256(await res.body())).toBe(sha256(jpeg("first-dance")));
  });

  test("file detail and media for unknown ids", async ({ mem }) => {
    expect((await mem.api.get("/files/file_nope")).status()).toBe(404);
    expect((await mem.api.get("/files/file_nope/media")).status()).toBe(404);
  });

  test("media says 'no connected copy' when every copy is unplugged", async ({ mem }) => {
    const usbVol = await mem.plugDrive("TRAVEL");
    await mem.place("Volumes/TRAVEL", { "a.jpg": jpeg("a") });
    await mem.addAndIngest({ name: "Travel USB", kind: "usb", rootPath: usbVol.mountPath });
    const file = await mem.fileByName("a.jpg");
    await mem.unplug(usbVol.volumeId);
    await mem.drives();
    const res = await mem.api.get(`/files/${file.id}/media`);
    expect(res.status()).toBe(409);
    expect(await res.json()).toEqual({ error: "No connected copy" });
  });

  test("serves files whose names are not plain ASCII", async ({ mem }) => {
    const root = await mem.place("Pictures", { "Adam’s birthday.jpg": jpeg("adam") });
    const drive = await mem.addAndIngest({ name: "Pics", kind: "computer", rootPath: root });
    const file = await mem.fileByName("Adam’s birthday.jpg");
    expect((await mem.api.get(`/files/${file.id}/media`)).status()).toBe(200);
    expect((await mem.api.get(`/drives/${drive.id}/media?path=${encodeURIComponent("Adam’s birthday.jpg")}`)).status()).toBe(200);
  });

  test("falls back to another copy when the first copy was deleted on disk", async ({ mem }) => {
    const { root, usb } = await twoPlaces(mem);
    const file = await mem.fileByName("First dance.jpg");
    await mem.json("POST", `/files/${file.id}/copy`, { destDriveId: usb.id });
    await rm(join(root, "Wedding", "First dance.jpg"));
    const res = await mem.api.get(`/files/${file.id}/media`);
    expect(res.status()).toBe(200);
    expect(Buffer.from(await res.body()).equals(await readFile(join(mem.path("Volumes", "TRAVEL"), "Wedding", "First dance.jpg")))).toBe(true);
  });

  test("media is a 404 without a server path when every connected copy was deleted", async ({ mem }) => {
    const { root } = await twoPlaces(mem);
    const file = await mem.fileByName("First dance.jpg");
    await rm(join(root, "Wedding", "First dance.jpg"));
    const res = await mem.api.get(`/files/${file.id}/media`);
    expect(res.status()).toBe(404);
    expect(JSON.stringify(await res.json())).not.toContain(root);
  });

  test("non-ASCII names keep their real name in Content-Disposition", async ({ mem }) => {
    const root = await mem.place("Pictures", { "Adam’s birthday 🎂.jpg": jpeg("adam") });
    await mem.addAndIngest({ name: "Pics", kind: "computer", rootPath: root });
    const file = await mem.fileByName("Adam’s birthday 🎂.jpg");
    const res = await mem.api.get(`/files/${file.id}/media`);
    expect(res.headers()["content-disposition"]).toContain(`filename*=UTF-8''${encodeURIComponent("Adam’s birthday 🎂.jpg")}`);
  });

  test("a missing file on disk is a 404, not a 500 with a server path", async ({ mem }) => {
    const root = await mem.place("Pictures", { "a.jpg": jpeg("a") });
    const drive = await mem.addAndIngest({ name: "Pics", kind: "computer", rootPath: root });
    const res = await mem.api.get(`/drives/${drive.id}/media?path=nope.jpg`);
    expect(res.status()).toBe(404);
    expect(JSON.stringify(await res.json())).not.toContain(root);
  });

  test("virtual folders: create, move a file in and out, refuse unknown folders", async ({ mem }) => {
    await twoPlaces(mem);
    const file = await mem.fileByName("notes.txt");
    const { folder } = await mem.json<{ folder: { id: string; name: string } }>("POST", "/folders", { name: "Family" });
    expect((await mem.json<{ folders: unknown[] }>("GET", "/folders")).folders).toEqual([{ id: folder.id, name: "Family", parentId: null }]);
    expect(await mem.json("POST", `/files/${file.id}/move`, { folderId: folder.id })).toEqual({ ok: true });
    expect(await mem.json("POST", `/files/${file.id}/move`, { folderId: null })).toEqual({ ok: true });
    expect((await mem.api.post(`/files/${file.id}/move`, { data: { folderId: "fld_nope" } })).status()).toBe(404);
    expect((await mem.api.post(`/files/file_nope/move`, { data: { folderId: folder.id } })).status()).toBe(404);
  });

  test("creating a folder without a name is a 400", async ({ mem }) => {
    expect((await mem.api.post("/folders", { data: {} })).status()).toBe(400);
  });
});

test.describe("copy and move (API)", () => {
  test("copies a file onto another place with identical bytes, once", async ({ mem }) => {
    const { root, usb, usbVol } = await twoPlaces(mem);
    const file = await mem.fileByName("First dance.jpg");
    const { replica } = await mem.json<{ replica: { relativePath: string } }>("POST", `/files/${file.id}/copy`, { destDriveId: usb.id });
    expect(replica.relativePath).toBe("Wedding/First dance.jpg");
    const copied = await readFile(join(usbVol.mountPath, "Wedding", "First dance.jpg"));
    expect(sha256(copied)).toBe(sha256(await readFile(join(root, "Wedding", "First dance.jpg"))));
    const again = await mem.json<{ replica: { relativePath: string } }>("POST", `/files/${file.id}/copy`, { destDriveId: usb.id });
    expect(again.replica.relativePath).toBe("Wedding/First dance.jpg");
    expect((await mem.detail(file.id)).replicas.map((r) => r.drive.name).sort()).toEqual(["Pictures", "Travel USB"]);
  });

  test("copy refuses the same place, an unknown place and an unplugged place", async ({ mem }) => {
    const { pics, usb, usbVol } = await twoPlaces(mem);
    const file = await mem.fileByName("notes.txt");
    const same = await mem.api.post(`/files/${file.id}/copy`, { data: { destDriveId: pics.id } });
    expect([same.status(), (await same.json()).error]).toEqual([400, "Copy needs a different drive"]);
    expect((await mem.api.post(`/files/${file.id}/copy`, { data: { destDriveId: "drv_nope" } })).status()).toBe(404);
    await mem.unplug(usbVol.volumeId);
    await mem.drives();
    const off = await mem.api.post(`/files/${file.id}/copy`, { data: { destDriveId: usb.id } });
    expect([off.status(), (await off.json()).error]).toEqual([400, "Destination drive is offline"]);
  });

  test("copy says there is no connected copy when the source is unplugged", async ({ mem }) => {
    const usbVol = await mem.plugDrive("TRAVEL");
    await mem.place("Volumes/TRAVEL", { "a.jpg": jpeg("a") });
    await mem.addAndIngest({ name: "Travel USB", kind: "usb", rootPath: usbVol.mountPath });
    const home = await mem.addPlace({ name: "Home", kind: "computer", rootPath: await mem.place("Home") });
    const file = await mem.fileByName("a.jpg");
    await mem.unplug(usbVol.volumeId);
    await mem.drives();
    const res = await mem.api.post(`/files/${file.id}/copy`, { data: { destDriveId: home.id } });
    expect([res.status(), (await res.json()).error]).toEqual([400, "No connected copy"]);
  });

  test("relocate moves a file to another place and removes the original", async ({ mem }) => {
    const { root, usb, usbVol } = await twoPlaces(mem);
    const file = await mem.fileByName("notes.txt");
    await mem.json("POST", `/files/${file.id}/relocate`, { destDriveId: usb.id, destRelativePath: "Inbox/notes.txt" });
    await expect(readFile(join(root, "notes.txt"))).rejects.toThrow();
    expect((await readFile(join(usbVol.mountPath, "Inbox", "notes.txt"))).toString()).toBe("A document on this drive.\n");
    expect((await mem.detail(file.id)).replicas.map((r) => [r.drive.name, r.replica.relativePath])).toEqual([["Travel USB", "Inbox/notes.txt"]]);
  });

  test("relocate within one place renames the file and keeps one copy", async ({ mem }) => {
    const { root, pics } = await twoPlaces(mem);
    const file = await mem.fileByName("notes.txt");
    await mem.json("POST", `/files/${file.id}/relocate`, { destDriveId: pics.id, destRelativePath: "Archive/notes.txt" });
    await expect(readFile(join(root, "notes.txt"))).rejects.toThrow();
    expect((await mem.detail(file.id)).replicas.map((r) => r.replica.relativePath)).toEqual(["Archive/notes.txt"]);
  });

  test("relocate needs a destination path", async ({ mem }) => {
    const { usb } = await twoPlaces(mem);
    const file = await mem.fileByName("notes.txt");
    const res = await mem.api.post(`/files/${file.id}/relocate`, { data: { destDriveId: usb.id, destRelativePath: "" } });
    expect([res.status(), (await res.json()).error]).toEqual([400, "Destination path required"]);
  });

  test("copy does not overwrite a different file already at the destination path", async ({ mem }) => {
    const { usb, usbVol } = await twoPlaces(mem);
    await writeFile(join(usbVol.mountPath, "notes.txt"), "precious, unrelated");
    const file = await mem.fileByName("notes.txt");
    const res = await mem.api.post(`/files/${file.id}/copy`, { data: { destDriveId: usb.id } });
    expect(res.status()).toBe(409);
    const body = await res.json();
    expect(body).toMatchObject({ skipped: true, relativePath: "notes.txt" });
    expect(body.error).toMatch(/^Skipped: Travel USB already has a different file called “notes.txt”/);
    expect((await readFile(join(usbVol.mountPath, "notes.txt"))).toString()).toBe("precious, unrelated");
    expect((await mem.detail(file.id)).replicas).toHaveLength(1);
  });

  test("relocate onto a name that is taken is skipped and keeps the original", async ({ mem }) => {
    const { root, pics } = await twoPlaces(mem);
    const file = await mem.fileByName("notes.txt");
    const notes = await readFile(join(root, "notes.txt"));
    const budget = await readFile(join(root, "Budget 2026.xlsx"));
    const res = await mem.api.post(`/files/${file.id}/relocate`, { data: { destDriveId: pics.id, destRelativePath: "Budget 2026.xlsx" } });
    expect(res.status()).toBe(409);
    expect((await res.json()).skipped).toBe(true);
    expect((await readFile(join(root, "notes.txt"))).equals(notes)).toBe(true);
    expect((await readFile(join(root, "Budget 2026.xlsx"))).equals(budget)).toBe(true);
  });
});

test.describe("backup (API)", () => {
  test("validates a new backup", async ({ mem }) => {
    const { pics, usb } = await twoPlaces(mem);
    const same = await mem.api.post("/backups", { data: { sourceDriveId: pics.id, destDriveId: pics.id, sourceRelativePaths: ["Wedding"] } });
    expect([same.status(), (await same.json()).error]).toEqual([400, "Source and destination must be different drives"]);
    const none = await mem.api.post("/backups", { data: { sourceDriveId: pics.id, destDriveId: usb.id, sourceRelativePaths: [] } });
    expect([none.status(), (await none.json()).error]).toEqual([400, "Choose a folder to copy"]);
    const unknown = await mem.api.post("/backups", { data: { sourceDriveId: "drv_nope", destDriveId: usb.id, sourceRelativePaths: [""] } });
    expect(unknown.status()).toBe(404);
    expect((await mem.api.post("/backups/job_nope/run", { data: {} })).status()).toBe(404);
  });

  test("keeps a parent folder and drops folders inside it", async ({ mem }) => {
    const { pics, usb } = await twoPlaces(mem);
    const job = await mem.saveBackup(pics.id, usb.id, ["Wedding/Day 2", "Wedding", "School", "School/"]);
    expect(job.sourceRelativePaths).toEqual(["School", "Wedding"]);
    const all = await mem.saveBackup(pics.id, usb.id, ["Wedding", ""]);
    expect(all.sourceRelativePaths).toEqual([""]);
  });

  test("copies only the chosen folders, then skips what is already safe", async ({ mem }) => {
    const { root, pics, usb, usbVol } = await twoPlaces(mem);
    const job = await mem.saveBackup(pics.id, usb.id, ["Wedding", "School"]);
    expect(await mem.runBackup(job.id)).toEqual({ copied: 4, skipped: 0, conflicts: [] });
    for (const rel of ["Wedding/First dance.jpg", "Wedding/Garden vows.jpg", "Wedding/Speeches.mp4", "School/School report 2026.pdf"]) {
      expect(sha256(await readFile(join(usbVol.mountPath, rel))), rel).toBe(sha256(await readFile(join(root, rel))));
    }
    await expect(readFile(join(usbVol.mountPath, "notes.txt"))).rejects.toThrow();
    expect(await mem.runBackup(job.id)).toEqual({ copied: 0, skipped: 4, conflicts: [] });
    expect((await mem.backups())[0]!.lastRunAt).not.toBeNull();
  });

  test("picks up a file added after the backup was saved", async ({ mem }) => {
    const { root, pics, usb, usbVol } = await twoPlaces(mem);
    const job = await mem.saveBackup(pics.id, usb.id, ["Wedding"]);
    await mem.runBackup(job.id);
    await writeFile(join(root, "Wedding", "Cake.jpg"), jpeg("cake"));
    expect(await mem.runBackup(job.id)).toEqual({ copied: 1, skipped: 3, conflicts: [] });
    expect(sha256(await readFile(join(usbVol.mountPath, "Wedding", "Cake.jpg")))).toBe(sha256(jpeg("cake")));
    expect((await mem.fileByName("Cake.jpg")).inbox).toBe(true);
  });

  test("backs up the whole place when the root is chosen", async ({ mem }) => {
    const { pics, usb } = await twoPlaces(mem);
    const job = await mem.saveBackup(pics.id, usb.id, [""]);
    expect(await mem.runBackup(job.id)).toEqual({ copied: 8, skipped: 0, conflicts: [] });
  });

  test("refuses to run when either side is unplugged", async ({ mem }) => {
    const { pics, usb, usbVol } = await twoPlaces(mem);
    const job = await mem.saveBackup(pics.id, usb.id, ["Wedding"]);
    await mem.unplug(usbVol.volumeId);
    await mem.drives();
    const res = await mem.api.post(`/backups/${job.id}/run`, { data: {} });
    expect([res.status(), (await res.json()).error]).toEqual([400, "Destination drive is offline"]);
    expect((await mem.backups())[0]!.lastRunAt).toBeNull();
  });

  test("a chosen folder that has disappeared fails the backup instead of reporting success", async ({ mem }) => {
    const { root, pics, usb } = await twoPlaces(mem);
    const job = await mem.saveBackup(pics.id, usb.id, ["Wedding"]);
    await rename(join(root, "Wedding"), join(root, "Wedding (old)"));
    const res = await mem.api.post(`/backups/${job.id}/run`, { data: {} });
    expect(res.status()).toBe(404);
    expect((await res.json()).error).toMatch(/Can’t find “Wedding” on Pictures/);
    expect((await mem.backups())[0]!.lastRunAt).toBeNull();
  });

  test("a different file with the same name on the destination is skipped and reported, never overwritten", async ({ mem }) => {
    const { pics, usb, usbVol } = await twoPlaces(mem);
    await writeFile(join(usbVol.mountPath, "notes.txt"), "precious, unrelated");
    const job = await mem.saveBackup(pics.id, usb.id, [""]);
    expect(await mem.runBackup(job.id)).toEqual({ copied: 7, skipped: 1, conflicts: ["notes.txt"] });
    expect((await readFile(join(usbVol.mountPath, "notes.txt"))).toString()).toBe("precious, unrelated");
    const notes = await mem.detail((await mem.fileByName("notes.txt")).id);
    expect(notes.replicas.map((row) => row.drive.id)).toEqual([pics.id]);
  });

  test("the same file already at the destination path is recognised, not copied again", async ({ mem }) => {
    const { root, pics, usb, usbVol } = await twoPlaces(mem);
    await writeFile(join(usbVol.mountPath, "notes.txt"), await readFile(join(root, "notes.txt")));
    const job = await mem.saveBackup(pics.id, usb.id, [""]);
    expect(await mem.runBackup(job.id)).toEqual({ copied: 7, skipped: 1, conflicts: [] });
    const notes = await mem.detail((await mem.fileByName("notes.txt")).id);
    expect(notes.replicas.map((row) => row.drive.id).sort()).toEqual([pics.id, usb.id].sort());
  });

  test("survives an API restart on the same catalog", async ({ mem }) => {
    const { startApi } = await import("../../support/api-server.js");
    const { pics, usb } = await twoPlaces(mem);
    const job = await mem.saveBackup(pics.id, usb.id, ["Wedding"]);
    await mem.runBackup(job.id);
    await mem.json("POST", `/files/${(await mem.fileByName("notes.txt")).id}/place`);
    const dbPath = join(mem.dir, "restart.sqlite");
    // Copy the worker catalog to a private file so a second process can own it.
    const { copyFile } = await import("node:fs/promises");
    await copyFile(mem.server.dbPath, dbPath);
    const second = await startApi({ dbPath });
    try {
      const get = async (path: string) => (await fetch(`${second.url}${path}`)).json();
      expect((await get("/drives")).drives.map((d: { name: string }) => d.name).sort()).toEqual(["Pictures", "Travel USB"]);
      expect((await get("/files")).files).toHaveLength(8);
      expect((await get("/files?inbox=false")).files.map((f: { name: string }) => f.name)).toEqual(["notes.txt"]);
      const jobs = (await get("/backups")).jobs;
      expect(jobs).toEqual([expect.objectContaining({ id: job.id, sourceRelativePaths: ["Wedding"], lastRunAt: expect.any(String) })]);
    } finally {
      await second.stop();
    }
  });

  test("documents and other kinds are copied byte-for-byte", async ({ mem }) => {
    const root = await mem.place("Docs", { "a.pdf": pdf("a"), "b.txt": text("b"), "c.bin": Buffer.from([0, 1, 2, 255]) });
    const docs = await mem.addAndIngest({ name: "Docs", kind: "computer", rootPath: root });
    const usbVol = await mem.plugDrive("TRAVEL");
    const usb = await mem.addPlace({ name: "Travel USB", kind: "usb", rootPath: usbVol.mountPath });
    const job = await mem.saveBackup(docs.id, usb.id, [""]);
    expect(await mem.runBackup(job.id)).toEqual({ copied: 3, skipped: 0, conflicts: [] });
    expect([...(await readFile(join(usbVol.mountPath, "c.bin")))]).toEqual([0, 1, 2, 255]);
  });
});
