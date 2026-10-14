import { _electron as electron, type ElectronApplication, expect, type Page, test } from "@playwright/test";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The desktop app end to end: the API runs inside Electron behind a launch token, the native
 * folder picker registers places, photos are dated from EXIF and previewed by the OS, and backups
 * never overwrite what is already on the destination.
 */
const fixtures = join(import.meta.dirname, "..", "..", "..", "fixtures");

let app: ElectronApplication;
let page: Page;
let root: string;

async function api<T>(path: string, body?: unknown): Promise<T> {
  return page.evaluate(
    async ([path, body]) => {
      const token = sessionStorage.getItem("memories-token") ?? "";
      const response = await fetch(path, {
        method: body === undefined ? "GET" : "POST",
        headers: { "x-memories-token": token, "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return response.json();
    },
    [path, body] as const,
  ) as Promise<T>;
}

test.beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "memories-e2e-"));
  for (const dir of ["phone/DCIM", "backup/DCIM"]) mkdirSync(join(root, dir), { recursive: true });
  copyFileSync(join(fixtures, "taken-2019-07-04.jpg"), join(root, "phone/DCIM/IMG_0001.jpg"));
  copyFileSync(join(fixtures, "notes.txt"), join(root, "backup/DCIM/IMG_0001.jpg"));

  app = await electron.launch({ args: ["."], env: { ...process.env, MEMORIES_DB: join(root, "data", "catalog.sqlite") } });
  page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  await app.evaluate(({ dialog }, folders) => {
    let next = 0;
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [folders[next++]] })) as never;
  }, [join(root, "phone"), join(root, "backup")]);
});

test.afterAll(async () => {
  await app?.close();
});

test("serves the UI from the embedded API and keeps the token out of the address bar", async () => {
  const url = new URL(page.url());
  expect(url.hostname).toBe("127.0.0.1");
  expect(url.searchParams.has("token")).toBe(false);
  expect(await page.evaluate(() => fetch("/drives").then((response) => response.status))).toBe(401);
});

test("registers folders with the native picker and dates photos from EXIF", async () => {
  const phoneRoot = (await api<{ rootPath: string }>("/pick-folder", {})).rootPath;
  const backupRoot = (await api<{ rootPath: string }>("/pick-folder", {})).rootPath;
  const phone = (await api<{ drive: { id: string } }>("/drives", { name: "Phone", kind: "usb", rootPath: phoneRoot })).drive;
  await api("/drives", { name: "Backup", kind: "disk", rootPath: backupRoot });
  await api("/ingest", { driveId: phone.id });

  const { files } = await api<{ files: Array<{ name: string; takenAt: string }> }>("/files");
  expect(files.map((file) => file.name)).toEqual(["IMG_0001.jpg"]);
  expect(new Date(files[0]!.takenAt).getFullYear()).toBe(2019);
});

test("backs up without overwriting a different file with the same name", async () => {
  const { drives } = await api<{ drives: Array<{ id: string; name: string }> }>("/drives");
  const [phone, backup] = ["Phone", "Backup"].map((name) => drives.find((drive) => drive.name === name)!);
  const { job } = await api<{ job: { id: string } }>("/backups", {
    sourceDriveId: phone!.id,
    destDriveId: backup!.id,
    sourceRelativePaths: [""],
  });

  expect(await api(`/backups/${job.id}/run`, {})).toEqual({ copied: 1, skipped: 0, failed: 0 });
  expect(readdirSync(join(root, "backup/DCIM")).filter((name) => !name.startsWith(".")).sort()).toEqual([
    "IMG_0001 (2).jpg",
    "IMG_0001.jpg",
  ]);
  expect(await api(`/backups/${job.id}/run`, {})).toEqual({ copied: 0, skipped: 1, failed: 0 });
});

test("shows the library with thumbnails in the grid", async () => {
  await page.reload();
  const tile = page.locator('img[src*="/thumb"]').first();
  await expect(tile).toBeVisible();
  await expect.poll(() => tile.evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0)).toBe(true);
});

test("lists backup history, restores from the Trash and saves a copy to a folder", async () => {
  // The drive is also called "Backup"; the screen comes after Places in the sidebar.
  await page.getByRole("navigation", { name: "Main" }).getByRole("button", { name: "Backup", exact: true }).last().click();
  await expect(page.getByRole("heading", { name: "Recent backups" })).toBeVisible();
  await expect(page.locator(".history-row")).toHaveCount(2);

  const { files } = await api<{ files: Array<{ id: string; name: string }> }>("/files");
  await api("/trash", { fileIds: [files[0]!.id] });
  expect((await api<{ files: unknown[] }>("/files")).files).toEqual([]);

  await page.getByRole("navigation", { name: "Main" }).getByRole("button", { name: "Trash", exact: true }).click();
  await page.reload();
  await page.getByRole("navigation", { name: "Main" }).getByRole("button", { name: "Trash", exact: true }).click();
  await expect(page.getByText("IMG_0001.jpg")).toBeVisible();
  await page.getByRole("button", { name: /Restore/ }).first().click();
  await expect(page.getByText("IMG_0001.jpg")).toHaveCount(0);
  expect((await api<{ files: unknown[] }>("/files")).files).toHaveLength(1);

  const target = join(root, "export");
  mkdirSync(target);
  expect(await api("/export", { fileIds: [files[0]!.id], rootPath: target })).toEqual({ exported: 1, failed: [] });
  expect(readdirSync(target)).toEqual(["IMG_0001.jpg"]);
});
