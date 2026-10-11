import { chmod, rename, rm } from "node:fs/promises";
import { expect, knownBug, test } from "../../support/fixtures.js";
import { familyPictures, jpeg, text } from "../../support/places.js";

test.describe("places and ingest (API)", () => {
  test("registers a computer folder and indexes every file once", async ({ mem }) => {
    const root = await mem.place("Pictures", familyPictures());
    const drive = await mem.addPlace({ name: "This computer", kind: "computer", rootPath: root });
    expect(drive).toMatchObject({ name: "This computer", kind: "computer", rootPath: root, volumeId: "test-root", online: true });
    expect(await mem.ingest(drive.id)).toEqual({ files: 8, replicas: 8 });
    expect(await mem.ingest(drive.id)).toEqual({ files: 0, replicas: 0 });
    const files = await mem.files();
    expect(files.map((f) => f.name).sort()).toEqual(
      ["Beach morning.jpg", "Budget 2026.xlsx", "First dance.jpg", "Flight tickets.pdf", "Garden vows.jpg", "School report 2026.pdf", "Speeches.mp4", "notes.txt"].sort(),
    );
    expect(files.every((f) => f.inbox)).toBe(true);
    expect((await mem.files("?kind=photo")).length).toBe(3);
    expect((await mem.files("?kind=video")).length).toBe(1);
    expect((await mem.files("?kind=document")).length).toBe(4);
  });

  test("uses the file's modified time as its date, newest first", async ({ mem }) => {
    const root = await mem.place("Pictures", familyPictures());
    await mem.addAndIngest({ name: "Pics", kind: "computer", rootPath: root });
    const files = await mem.files();
    expect(files[0]!.name).toBe("School report 2026.pdf");
    expect((await mem.fileByName("First dance.jpg")).takenAt).toBe("2025-08-12T11:40:00.000Z");
    expect(files.at(-1)!.name).toBe("Garden vows.jpg");
  });

  test("groups photos and videos into moments by day", async ({ mem }) => {
    const root = await mem.place("Pictures", familyPictures());
    await mem.addAndIngest({ name: "Pics", kind: "computer", rootPath: root });
    const { events } = await mem.json<{ events: { day: string; place: string | null; fileIds: string[] }[] }>("GET", "/events");
    expect(events.map((e) => [e.day, e.fileIds.length])).toEqual([
      ["2025-12-26", 1],
      ["2025-08-12", 3],
    ]);
  });

  test("groups moments by the local day the photo was taken", async ({ mem }) => {
    knownBug("moments use the UTC date (takenAt.slice(0, 10)); a 06:30 MYT photo lands on the previous day");
    const root = await mem.place("Pictures", {
      "early.jpg": { bytes: jpeg("early"), mtime: "2025-12-26T06:30:00+08:00" },
      "late.jpg": { bytes: jpeg("late"), mtime: "2025-12-26T18:00:00+08:00" },
    });
    await mem.addAndIngest({ name: "Pics", kind: "computer", rootPath: root });
    const { events } = await mem.json<{ events: { day: string; fileIds: string[] }[] }>("GET", "/events");
    expect(events.map((e) => [e.day, e.fileIds.length])).toEqual([["2025-12-26", 2]]);
  });

  test("registering the same folder twice updates the place instead of duplicating it", async ({ mem }) => {
    const root = await mem.place("Pictures", { "a.jpg": jpeg("a") });
    const first = await mem.addPlace({ name: "Pics", kind: "computer", rootPath: root });
    const second = await mem.addPlace({ name: "Family pictures", kind: "computer", rootPath: root });
    expect(second.id).toBe(first.id);
    expect(await mem.drives()).toEqual([expect.objectContaining({ id: first.id, name: "Family pictures" })]);
  });

  test("skips hidden files and folders", async ({ mem }) => {
    const root = await mem.place("Pictures", { ".DS_Store": "x", ".thumbs/a.jpg": jpeg("hidden"), "seen.jpg": jpeg("seen") });
    const drive = await mem.addAndIngest({ name: "Pics", kind: "computer", rootPath: root });
    expect((await mem.files()).map((f) => f.name)).toEqual(["seen.jpg"]);
    const { entries } = await mem.json<{ entries: { name: string }[] }>("GET", `/drives/${drive.id}/entries`);
    expect(entries.map((e) => e.name)).toEqual(["seen.jpg"]);
  });

  test("keeps indexing when one file cannot be read", async ({ mem }) => {
    const root = await mem.place("Pictures", { "locked.txt": text("locked"), "open.txt": text("open") });
    await chmod(`${root}/locked.txt`, 0o000);
    try {
      const drive = await mem.addPlace({ name: "Pics", kind: "computer", rootPath: root });
      expect(await mem.ingest(drive.id)).toEqual({ files: 1, replicas: 1 });
      expect((await mem.files()).map((f) => f.name)).toEqual(["open.txt"]);
    } finally {
      await chmod(`${root}/locked.txt`, 0o644);
    }
  });

  test("indexes an empty folder as an empty place", async ({ mem }) => {
    const root = await mem.place("Empty");
    const drive = await mem.addPlace({ name: "Empty", kind: "computer", rootPath: root });
    expect(await mem.ingest(drive.id)).toEqual({ files: 0, replicas: 0 });
  });

  test("handles non-ASCII, emoji and space-filled names in the catalog", async ({ mem }) => {
    const names = ["Adam’s birthday.jpg", "Café ☕ menu.pdf", "日本 旅行.jpg", "  spaced  name .txt"];
    const root = await mem.place("Pictures", Object.fromEntries(names.map((n) => [n, text(n)])));
    await mem.addAndIngest({ name: "Pics", kind: "computer", rootPath: root });
    expect((await mem.files()).map((f) => f.name).sort()).toEqual([...names].sort());
  });

  test("indexes one sub-folder only when asked", async ({ mem }) => {
    const root = await mem.place("Pictures", familyPictures());
    const drive = await mem.addPlace({ name: "Pics", kind: "computer", rootPath: root });
    expect(await mem.ingest(drive.id, "Wedding")).toEqual({ files: 3, replicas: 3 });
  });

  test("lists one folder level, folders first", async ({ mem }) => {
    const root = await mem.place("Pictures", familyPictures());
    const drive = await mem.addPlace({ name: "Pics", kind: "computer", rootPath: root });
    const { entries } = await mem.json<{ entries: { name: string; directory: boolean }[] }>("GET", `/drives/${drive.id}/entries`);
    expect(entries.map((e) => e.name)).toEqual(["Langkawi 2025", "School", "Wedding", "Budget 2026.xlsx", "notes.txt"]);
    const { folders } = await mem.json<{ folders: string[] }>("GET", `/drives/${drive.id}/folders`);
    expect(folders).toEqual(["Langkawi 2025", "School", "Wedding"]);
  });

  test("unknown drive ids give 404", async ({ mem }) => {
    for (const path of ["/drives/drv_nope/entries", "/drives/drv_nope/folders", "/drives/drv_nope/media?path=a.jpg"]) {
      expect((await mem.api.get(path)).status(), path).toBe(404);
    }
    expect((await mem.api.post("/ingest", { data: { driveId: "drv_nope" } })).status()).toBe(404);
  });

  test("refuses to index or browse a place whose drive is unplugged", async ({ mem }) => {
    const usb = await mem.plugDrive("TRAVEL");
    await mem.place("Volumes/TRAVEL", { "a.jpg": jpeg("a") });
    const drive = await mem.addPlace({ name: "Travel USB", kind: "usb", rootPath: usb.mountPath });
    expect(drive.volumeId).toBe(usb.volumeId);
    await mem.unplug(usb.volumeId);
    await mem.json("POST", "/sync");
    const ingest = await mem.api.post("/ingest", { data: { driveId: drive.id } });
    expect(ingest.status()).toBe(400);
    expect(await ingest.json()).toEqual({ error: "Drive is offline" });
    expect((await mem.api.get(`/drives/${drive.id}/entries`)).status()).toBe(400);
    expect(await mem.json("GET", `/drives/${drive.id}/folders`)).toEqual({ folders: [] });
  });

  test("ingest re-checks presence instead of trusting the last sync", async ({ mem }) => {
    knownBug("ingest/copy/backup read the cached 'online' flag; it only refreshes on GET /drives or POST /sync");
    const usb = await mem.plugDrive("TRAVEL");
    await mem.place("Volumes/TRAVEL", { "a.jpg": jpeg("a") });
    const drive = await mem.addPlace({ name: "Travel USB", kind: "usb", rootPath: usb.mountPath });
    await mem.unplug(usb.volumeId);
    const ingest = await mem.api.post("/ingest", { data: { driveId: drive.id } });
    expect(ingest.status()).toBe(400);
  });

  test("presence follows plug and unplug of the drive", async ({ mem }) => {
    const usb = await mem.plugDrive("TRAVEL");
    const drive = await mem.addPlace({ name: "Travel USB", kind: "usb", rootPath: usb.mountPath });
    expect((await mem.drive(drive.id)).online).toBe(true);
    await mem.unplug(usb.volumeId);
    expect((await mem.drive(drive.id)).online).toBe(false);
    await mem.plugDrive("TRAVEL", usb.volumeId);
    expect((await mem.drive(drive.id)).online).toBe(true);
  });

  test("a registered folder that no longer exists is reported as not found", async ({ mem }) => {
    knownBug("presence is volume-only; a deleted/renamed folder on a connected disk stays online and lists as empty");
    const root = await mem.place("Pictures", { "a.jpg": jpeg("a") });
    const drive = await mem.addAndIngest({ name: "Pics", kind: "computer", rootPath: root });
    await rename(root, `${root}-moved`);
    expect((await mem.drive(drive.id)).online).toBe(false);
  });

  test("registering a folder that does not exist is refused", async ({ mem }) => {
    knownBug("POST /drives accepts any path, even one that does not exist, and marks it online");
    const res = await mem.api.post("/drives", { data: { name: "Ghost", kind: "computer", rootPath: mem.path("no-such-folder") } });
    expect(res.status()).toBe(400);
  });

  test("registering a relative path is refused", async ({ mem }) => {
    knownBug("POST /drives accepts relative paths like 'relative/dir' (resolved against the API's cwd at read time)");
    const res = await mem.api.post("/drives", { data: { name: "Rel", kind: "computer", rootPath: "relative/dir" } });
    expect(res.status()).toBe(400);
  });

  test("invalid place input gets a clear 400, not an internal error message", async ({ mem }) => {
    knownBug("POST /drives has no input validation: missing rootPath surfaces 'Cannot read properties of undefined'");
    const res = await mem.api.post("/drives", { data: { name: "", kind: "spaceship" } });
    expect(res.status()).toBe(400);
    expect((await res.json()).error).not.toMatch(/Cannot read properties|undefined/);
  });

  test("re-indexing a deleted file removes it from the place", async ({ mem }) => {
    knownBug("ingest never prunes replicas of files that were deleted on disk");
    const root = await mem.place("Pictures", { "keep.jpg": jpeg("keep"), "gone.jpg": jpeg("gone") });
    const drive = await mem.addAndIngest({ name: "Pics", kind: "computer", rootPath: root });
    const gone = await mem.fileByName("gone.jpg");
    await rm(`${root}/gone.jpg`);
    await mem.ingest(drive.id);
    const detail = await mem.detail(gone.id).catch(() => null);
    expect(detail?.replicas ?? []).toEqual([]);
  });

  test("re-indexing a drive with two identical files is idempotent", async ({ mem }) => {
    knownBug("one replica per (file, drive): identical copies on one drive flip the replica path on every ingest");
    const same = jpeg("twin");
    const root = await mem.place("Pictures", { "a/twin.jpg": same, "b/twin copy.jpg": same });
    const drive = await mem.addAndIngest({ name: "Pics", kind: "computer", rootPath: root });
    expect(await mem.ingest(drive.id)).toEqual({ files: 0, replicas: 0 });
  });
});
