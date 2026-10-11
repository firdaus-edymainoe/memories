import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "../../support/fixtures.js";
import { familyPictures, sha256 } from "../../support/places.js";
import { details, main, nav, openFile } from "../../support/ui.js";

test.describe("file details, copy and mark as sorted (UI)", () => {
  let usbMount = "";
  let picturesRoot = "";

  test.beforeEach(async ({ mem }) => {
    picturesRoot = await mem.place("Pictures", familyPictures());
    await mem.addAndIngest({ name: "Pictures", kind: "computer", rootPath: picturesRoot });
    const usb = await mem.plugDrive("TRAVEL");
    usbMount = usb.mountPath;
    await mem.addPlace({ name: "Travel USB", kind: "usb", rootPath: usb.mountPath });
  });

  test("a photo opens with a real preview and its facts", async ({ app }) => {
    await openFile(app, "First dance.jpg");
    const panel = details(app);
    await expect(panel).toContainText("Photo");
    await expect(panel).toContainText("12 Aug 2025");
    await expect(panel.getByRole("heading", { name: "Kept on" })).toBeVisible();
    await expect(panel.locator(".kept li")).toHaveText([/Pictures\s*Ready/]);
    const img = panel.locator(".insp-preview img");
    await expect(img).toBeVisible();
    await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBeGreaterThan(0);
  });

  test("Open shows the photo full size and Escape closes it", async ({ app }) => {
    await openFile(app, "Beach morning.jpg");
    await details(app).getByRole("button", { name: "Open", exact: true }).click();
    await expect(app.getByRole("img", { name: "Beach morning.jpg" })).toBeVisible();
    await app.keyboard.press("Escape");
    await expect(app.getByRole("img", { name: "Beach morning.jpg" })).toBeHidden();
  });

  test("a document shows its kind, date and size", async ({ app }) => {
    await openFile(app, "Flight tickets.pdf");
    await expect(details(app)).toContainText("KindPDF");
    await expect(details(app)).toContainText("Date30 Nov 2025");
    await expect(details(app)).toContainText("Size54 bytes");
  });

  test("Copy to… puts a byte-identical copy on the USB stick and lists it", async ({ app }) => {
    await openFile(app, "First dance.jpg");
    await details(app).getByRole("button", { name: "Copy to…" }).click();
    await app.getByRole("menuitem", { name: /Travel USB/ }).click();
    await expect(app.getByText("Copied to Travel USB")).toBeVisible();
    await expect(details(app).locator(".kept li")).toHaveText([/Pictures\s*Ready/, /Travel USB\s*Ready/]);
    const copied = await readFile(join(usbMount, "Wedding", "First dance.jpg"));
    expect(sha256(copied)).toBe(sha256(await readFile(join(picturesRoot, "Wedding", "First dance.jpg"))));
    await details(app).getByRole("button", { name: "Copy to…" }).click();
    await expect(app.getByRole("menu")).toContainText("Add another place first");
  });

  test("Copy to… shows an unplugged place but does not allow it", async ({ app, mem }) => {
    const usb = (await mem.drives()).find((d) => d.name === "Travel USB")!;
    await mem.unplug(usb.volumeId);
    await app.reload();
    await openFile(app, "notes.txt");
    await details(app).getByRole("button", { name: "Copy to…" }).click();
    const item = app.getByRole("menuitem", { name: /Travel USB/ });
    await expect(item).toBeDisabled();
    await expect(item).toContainText("Unplugged");
  });

  test("Mark as sorted removes the New flag and is remembered", async ({ app, mem }) => {
    await openFile(app, "notes.txt");
    await details(app).getByRole("button", { name: "Mark as sorted" }).click();
    await expect(app.getByText("Marked as sorted")).toBeVisible();
    await expect(details(app).getByRole("button", { name: "Mark as sorted" })).toHaveCount(0);
    expect((await mem.fileByName("notes.txt")).inbox).toBe(false);
    await app.reload();
    await openFile(app, "notes.txt");
    await expect(details(app).getByRole("button", { name: "Mark as sorted" })).toHaveCount(0);
  });

  test("closing details clears the selection", async ({ app }) => {
    await openFile(app, "notes.txt");
    await details(app).getByRole("button", { name: "Close details for notes.txt" }).click();
    await expect(details(app)).toBeHidden();
  });

  test("a copy that fails shows the reason", async ({ app, mem }) => {
    await openFile(app, "notes.txt");
    const usb = (await mem.drives()).find((d) => d.name === "Travel USB")!;
    await details(app).getByRole("button", { name: "Copy to…" }).click();
    await mem.unplug(usb.volumeId);
    await mem.drives();
    await app.getByRole("menuitem", { name: /Travel USB/ }).click();
    await expect(app.getByText("Destination drive is offline")).toBeVisible();
    await expect(nav(app)).toBeVisible();
    await expect(main(app)).toBeVisible();
  });
});
