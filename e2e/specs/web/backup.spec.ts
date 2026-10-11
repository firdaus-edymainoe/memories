import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "../../support/fixtures.js";
import { familyPictures, jpeg, sha256 } from "../../support/places.js";
import { main, nav } from "../../support/ui.js";
import { setNow } from "../../support/clock.js";

test.describe("backup (UI)", () => {
  let root = "";
  let usbMount = "";
  let usbVolume = "";

  test.beforeEach(async ({ mem }) => {
    root = await mem.place("Pictures", familyPictures());
    await mem.addAndIngest({ name: "Pictures", kind: "computer", rootPath: root });
    const usb = await mem.plugDrive("TRAVEL");
    usbMount = usb.mountPath;
    usbVolume = usb.volumeId;
    await mem.addPlace({ name: "Travel USB", kind: "usb", rootPath: usb.mountPath });
  });

  test("the wizard saves a backup of ticked folders and Back up now copies them", async ({ app, mem }) => {
    await nav(app).getByRole("button", { name: "Backup" }).click();
    await expect(app.getByRole("heading", { name: "No backups yet" })).toBeVisible();
    await app.getByRole("button", { name: "New backup" }).click();
    await app.getByRole("button", { name: /^Pictures.*Ready/ }).click();
    await app.getByRole("button", { name: "Select Wedding" }).click();
    await app.getByRole("button", { name: "Open Langkawi 2025" }).click();
    await expect(app.getByRole("navigation", { name: "Folder" })).toContainText("Langkawi 2025");
    await app.getByRole("button", { name: "Continue" }).click();
    await app.getByRole("button", { name: /^Travel USB.*Plugged in/ }).click();
    await app.getByRole("button", { name: "Save backup" }).click();
    await expect(app.getByText("Backup saved")).toBeVisible();
    const card = app.locator(".backup-card");
    await expect(card.getByRole("heading", { name: "Pictures to Travel USB" })).toBeVisible();
    await expect(card).toContainText("Wedding");
    await expect(card).toContainText("Not backed up yet");

    await card.getByRole("button", { name: "Back up now" }).click();
    await expect(card).toContainText("All done. 3 new files copied.");
    for (const rel of ["Wedding/First dance.jpg", "Wedding/Garden vows.jpg", "Wedding/Speeches.mp4"]) {
      expect(sha256(await readFile(join(usbMount, rel))), rel).toBe(sha256(await readFile(join(root, rel))));
    }
    expect((await mem.backups())[0]!.sourceRelativePaths).toEqual(["Wedding"]);
  });

  test("a second run says everything was already safe; a new file is copied next time", async ({ app, mem }) => {
    const [pics, usb] = [(await mem.drives()).find((d) => d.name === "Pictures")!, (await mem.drives()).find((d) => d.name === "Travel USB")!];
    const job = await mem.saveBackup(pics.id, usb.id, ["Wedding"]);
    await mem.runBackup(job.id);
    await nav(app).getByRole("button", { name: "Backup" }).click();
    const card = app.locator(".backup-card");
    await card.getByRole("button", { name: "Back up now" }).click();
    await expect(card).toContainText("All done. Everything was already safe.");
    await writeFile(join(root, "Wedding", "Cake.jpg"), jpeg("cake"));
    await card.getByRole("button", { name: "Back up now" }).click();
    await expect(card).toContainText("All done. 1 new file copied.");
  });

  test("a file skipped because of a name clash is reported on the card", async ({ app, mem }) => {
    const [pics, usb] = [(await mem.drives()).find((d) => d.name === "Pictures")!, (await mem.drives()).find((d) => d.name === "Travel USB")!];
    await mem.saveBackup(pics.id, usb.id, ["Wedding"]);
    await mkdir(join(usbMount, "Wedding"), { recursive: true });
    await writeFile(join(usbMount, "Wedding", "Speeches.mp4"), "someone else's video");
    await nav(app).getByRole("button", { name: "Backup" }).click();
    const card = app.locator(".backup-card");
    await card.getByRole("button", { name: "Back up now" }).click();
    await expect(card).toContainText("All done. 2 new files copied. Skipped 1 file: Travel USB already has a different file with the same name.");
    expect((await readFile(join(usbMount, "Wedding", "Speeches.mp4"))).toString()).toBe("someone else's video");
  });

  test("a backup whose folder was moved fails clearly", async ({ app, mem }) => {
    const [pics, usb] = [(await mem.drives()).find((d) => d.name === "Pictures")!, (await mem.drives()).find((d) => d.name === "Travel USB")!];
    await mem.saveBackup(pics.id, usb.id, ["Wedding"]);
    await rename(join(root, "Wedding"), join(root, "Wedding 2025"));
    await nav(app).getByRole("button", { name: "Backup" }).click();
    await app.locator(".backup-card").getByRole("button", { name: "Back up now" }).click();
    await expect(app.getByText("Can’t find “Wedding” on Pictures. It may have been moved or renamed.")).toBeVisible();
    await expect(app.locator(".backup-card")).toContainText("Not backed up yet");
  });

  test("the card says when it last ran (frozen clock)", async ({ app, mem }) => {
    const [pics, usb] = [(await mem.drives()).find((d) => d.name === "Pictures")!, (await mem.drives()).find((d) => d.name === "Travel USB")!];
    const job = await mem.saveBackup(pics.id, usb.id, ["Wedding"]);
    await mem.runBackup(job.id);
    const ranAt = new Date((await mem.backups())[0]!.lastRunAt!);
    await setNow(app, new Date(ranAt.getTime() + 60_000));
    await nav(app).getByRole("button", { name: "Backup" }).click();
    await expect(app.locator(".backup-card")).toContainText("Backed up today");
    await nav(app).getByRole("button", { name: "Places" }).click();
    await setNow(app, new Date(ranAt.getTime() + 3 * 86_400_000));
    await nav(app).getByRole("button", { name: "Backup" }).click();
    await expect(app.locator(".backup-card")).toContainText("Backed up 3 days ago");
  });

  test("an unplugged destination disables Back up now and says what to plug in", async ({ app, mem }) => {
    const [pics, usb] = [(await mem.drives()).find((d) => d.name === "Pictures")!, (await mem.drives()).find((d) => d.name === "Travel USB")!];
    await mem.saveBackup(pics.id, usb.id, ["Wedding"]);
    await mem.unplug(usbVolume);
    await nav(app).getByRole("button", { name: "Backup" }).click();
    const card = app.locator(".backup-card");
    await expect(card).toContainText("Plug in Travel USB to back up.");
    await expect(card.getByRole("button", { name: "Back up now" })).toBeDisabled();
  });

  test("the wizard waits for an unplugged destination but cannot start from an unplugged source", async ({ app, mem }) => {
    await mem.unplug(usbVolume);
    await app.reload();
    await nav(app).getByRole("button", { name: "Backup" }).click();
    await app.getByRole("button", { name: "New backup" }).click();
    await main(app).getByRole("button", { name: /^Travel USB/ }).click();
    await expect(app.getByText("Plug in Travel USB to choose its folders")).toBeVisible();
    await app.getByRole("button", { name: /^Pictures.*Ready/ }).click();
    await app.getByRole("button", { name: "Select School" }).click();
    await app.getByRole("button", { name: "Continue" }).click();
    await expect(main(app).getByRole("button", { name: /^Travel USB/ })).toContainText("Unplugged, that’s fine. We’ll wait for it.");
  });

  test("Continue stays disabled until a folder is ticked", async ({ app }) => {
    await nav(app).getByRole("button", { name: "Backup" }).click();
    await app.getByRole("button", { name: "New backup" }).click();
    await app.getByRole("button", { name: /^Pictures.*Ready/ }).click();
    await expect(app.getByRole("button", { name: "Continue" })).toBeDisabled();
    await app.getByRole("button", { name: "Select Wedding" }).click();
    await expect(app.getByRole("button", { name: "Continue" })).toBeEnabled();
  });

  test("a backup the API rejects shows the reason and re-enables the button", async ({ app, mem }) => {
    const [pics, usb] = [(await mem.drives()).find((d) => d.name === "Pictures")!, (await mem.drives()).find((d) => d.name === "Travel USB")!];
    await mem.saveBackup(pics.id, usb.id, ["Wedding"]);
    await nav(app).getByRole("button", { name: "Backup" }).click();
    // Simulate the drive vanishing between the last presence check and the click.
    await app.route(/\/backups\/[^/]+\/run$/, (route) =>
      route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ error: "Destination drive is offline" }) }),
    );
    await app.locator(".backup-card").getByRole("button", { name: "Back up now" }).click();
    await expect(app.locator(".backup-card").getByRole("button", { name: "Back up now" })).toBeEnabled();
    await expect(app.getByText("Destination drive is offline")).toBeVisible();
  });
});
