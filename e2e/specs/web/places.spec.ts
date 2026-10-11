import { rename } from "node:fs/promises";
import { expect, knownBug, nextPoll, test } from "../../support/fixtures.js";
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
    knownBug("presence ignores whether the folder exists; a moved Pictures folder still shows Ready");
    const root = await mem.place("Pictures", { "a.jpg": jpeg("a") });
    await mem.addAndIngest({ name: "Pictures", kind: "computer", rootPath: root });
    await rename(root, `${root} (moved)`);
    await nav(app).getByRole("button", { name: "Places" }).click();
    await nextPoll(app);
    await expect(card(app, "Pictures")).toContainText("Can’t find this folder", { timeout: 3000 });
  });

  test("Places in the breadcrumb or the sidebar goes back to the list of places", async ({ app, mem }) => {
    knownBug("go('places') only calls resetBrowse() when leaving Places, so both buttons keep you inside the place");
    const root = await mem.place("Pictures", familyPictures());
    await mem.addAndIngest({ name: "Pictures", kind: "computer", rootPath: root });
    await nav(app).getByRole("button", { name: "Places" }).click();
    await app.getByRole("button", { name: "Open Pictures" }).click();
    await expect(main(app).getByRole("button", { name: /Wedding/ })).toBeVisible();
    await app.getByRole("navigation", { name: "You are here" }).getByRole("button", { name: "Places" }).click();
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
