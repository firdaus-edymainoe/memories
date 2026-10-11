import { rename } from "node:fs/promises";
import { expect, nextPoll, test } from "../../support/fixtures.js";
import { familyPictures, jpeg } from "../../support/places.js";
import { main, nav } from "../../support/ui.js";

function card(page: import("@playwright/test").Page, name: string) {
  return page.locator(".place-card").filter({ has: page.getByRole("button", { name: `Open ${name}` }) });
}

test.describe("places (UI)", () => {
  test("lists places with kind and status, and browses folders with thumbnails", async ({ app, mem }) => {
    const root = await mem.place("Pictures", familyPictures());
    await mem.addAndIngest({ name: "Pictures", kind: "computer", rootPath: root });
    const usb = await mem.plugDrive("TRAVEL");
    await mem.addPlace({ name: "Travel USB", kind: "usb", rootPath: usb.mountPath });
    await nav(app).getByRole("button", { name: "Places" }).click();
    await expect(card(app, "Pictures")).toContainText("Pictures folder");
    await expect(card(app, "Pictures")).toContainText("Ready");
    await expect(card(app, "Travel USB")).toContainText("Plugged in");

    await app.getByRole("button", { name: "Open Pictures" }).click();
    await expect(main(app).getByRole("button", { name: /Wedding/ })).toBeVisible();
    await main(app).getByRole("button", { name: /Wedding/ }).click();
    const thumb = main(app).getByRole("button", { name: /First dance\.jpg/ }).locator("img");
    await expect(thumb).toBeVisible();
    await expect.poll(() => thumb.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBeGreaterThan(0);
  });

  test("an empty place says it is empty", async ({ app, mem }) => {
    const usb = await mem.plugDrive("TRAVEL");
    await mem.addPlace({ name: "Travel USB", kind: "usb", rootPath: usb.mountPath });
    await app.reload();
    await nav(app).getByRole("button", { name: "Travel USB" }).click();
    await expect(app.getByRole("heading", { name: "This folder is empty" })).toBeVisible();
  });

  test("unplugging a drive shows it as Unplugged on the next check, and replugging brings it back", async ({ app, mem }) => {
    const usb = await mem.plugDrive("TRAVEL");
    await mem.place("Volumes/TRAVEL", { "a.jpg": jpeg("a") });
    await mem.addAndIngest({ name: "Travel USB", kind: "usb", rootPath: usb.mountPath });
    await app.reload();
    await nav(app).getByRole("button", { name: "Places" }).click();
    await expect(card(app, "Travel USB")).toContainText("Plugged in");
    await mem.unplug(usb.volumeId);
    await nextPoll(app);
    await expect(card(app, "Travel USB")).toContainText("Unplugged");
    await app.getByRole("button", { name: "Open Travel USB" }).click();
    await expect(app.getByText("Plug in Travel USB to open it")).toBeVisible();
    await mem.plugDrive("TRAVEL", usb.volumeId);
    await nextPoll(app);
    await expect(card(app, "Travel USB")).toContainText("Plugged in");
  });

  test("an unplugged drive's files stay in the library", async ({ app, mem }) => {
    const usb = await mem.plugDrive("TRAVEL");
    await mem.place("Volumes/TRAVEL", { "Holiday.jpg": jpeg("holiday") });
    await mem.addAndIngest({ name: "Travel USB", kind: "usb", rootPath: usb.mountPath });
    await mem.unplug(usb.volumeId);
    await app.reload();
    await expect(main(app).getByRole("button", { name: /Holiday\.jpg/ })).toBeVisible();
    await main(app).getByRole("button", { name: /Holiday\.jpg/ }).click();
    await expect(app.locator(".kept li")).toHaveText([/Travel USB\s*Unplugged/]);
  });

  test("a computer folder that was moved away shows “Can’t find this folder”", async ({ app, mem }) => {
    const root = await mem.place("Pictures", { "a.jpg": jpeg("a") });
    await mem.addAndIngest({ name: "Pictures", kind: "computer", rootPath: root });
    await rename(root, `${root} (moved)`);
    await nav(app).getByRole("button", { name: "Places" }).click();
    await nextPoll(app);
    await expect(card(app, "Pictures")).toContainText("Can’t find this folder", { timeout: 3000 });
  });

  test("Locate… re-points a moved folder and keeps its files", async ({ app, mem }) => {
    const root = await mem.place("Pictures", familyPictures());
    const pics = await mem.addAndIngest({ name: "Pictures", kind: "computer", rootPath: root });
    const ids = (await mem.files()).map((f) => f.id).sort();
    await rename(root, `${root} (moved)`);
    await nav(app).getByRole("button", { name: "Places" }).click();
    await nextPoll(app);
    await expect(card(app, "Pictures")).toContainText("Can’t find this folder", { timeout: 3000 });
    await mem.queuePicker(`${root} (moved)`);
    await card(app, "Pictures").getByRole("button", { name: "Locate Pictures" }).click();
    await expect(app.getByText("Found Pictures")).toBeVisible();
    await expect(card(app, "Pictures")).toContainText("Ready");
    await expect(card(app, "Pictures").getByRole("button", { name: "Back up" })).toBeVisible();
    expect((await mem.drive(pics.id)).rootPath).toBe(`${root} (moved)`);
    expect((await mem.files()).map((f) => f.id).sort()).toEqual(ids);
    await app.getByRole("button", { name: "Open Pictures" }).click();
    await expect(main(app).getByRole("button", { name: /Wedding/ })).toBeVisible();
  });

  test("Locate… with a cancelled picker changes nothing", async ({ app, mem }) => {
    const root = await mem.place("Pictures", { "a.jpg": jpeg("a") });
    const pics = await mem.addAndIngest({ name: "Pictures", kind: "computer", rootPath: root });
    await rename(root, `${root} (moved)`);
    await nav(app).getByRole("button", { name: "Places" }).click();
    await nextPoll(app);
    await card(app, "Pictures").getByRole("button", { name: "Locate Pictures" }).click();
    await expect.poll(() => mem.pickerCalls()).toBe(1);
    await expect(card(app, "Pictures")).toContainText("Can’t find this folder");
    expect((await mem.drive(pics.id)).rootPath).toBe(root);
  });

  test("a USB stick whose folder is gone says “Can’t find this folder”, not Unplugged", async ({ app, mem }) => {
    const usb = await mem.plugDrive("TRAVEL");
    const folder = await mem.place("Volumes/TRAVEL/Photos", { "a.jpg": jpeg("a") });
    await mem.addAndIngest({ name: "Travel photos", kind: "usb", rootPath: folder });
    await rename(folder, `${folder} 2`);
    await nav(app).getByRole("button", { name: "Places" }).click();
    await nextPoll(app);
    await expect(card(app, "Travel photos")).toContainText("Can’t find this folder", { timeout: 3000 });
    await expect(card(app, "Travel photos").getByRole("button", { name: "Locate Travel photos" })).toBeVisible();
    void usb;
  });

  test("Places in the breadcrumb or the sidebar goes back to the list of places", async ({ app, mem }) => {
    const root = await mem.place("Pictures", familyPictures());
    await mem.addAndIngest({ name: "Pictures", kind: "computer", rootPath: root });
    await nav(app).getByRole("button", { name: "Places" }).click();
    await app.getByRole("button", { name: "Open Pictures" }).click();
    await expect(main(app).getByRole("button", { name: /Wedding/ })).toBeVisible();
    await app.getByRole("navigation", { name: "You are here" }).getByRole("button", { name: "Places" }).click();
    await expect(app.getByRole("button", { name: "Open Pictures" })).toBeVisible({ timeout: 3000 });
    await app.getByRole("button", { name: "Open Pictures" }).click();
    await expect(main(app).getByRole("button", { name: /Wedding/ })).toBeVisible();
    await nav(app).getByRole("button", { name: "Places", exact: true }).click();
    await expect(app.getByRole("button", { name: "Open Pictures" })).toBeVisible({ timeout: 3000 });
  });

  test("Back up from a place card starts the wizard with that place chosen", async ({ app, mem }) => {
    const root = await mem.place("Pictures", familyPictures());
    await mem.addAndIngest({ name: "Pictures", kind: "computer", rootPath: root });
    await nav(app).getByRole("button", { name: "Places" }).click();
    await card(app, "Pictures").getByRole("button", { name: "Back up" }).click();
    await expect(app.getByRole("heading", { name: "New backup" })).toBeVisible();
    await expect(app.getByRole("button", { name: "Open Wedding" })).toBeVisible();
  });
});
