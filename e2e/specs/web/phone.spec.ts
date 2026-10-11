import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { expect, nextPoll, test, type FakePhone, type Mem } from "../../support/fixtures.js";
import { jpeg, mp4, sha256, writeTree } from "../../support/places.js";
import { details, main, nav } from "../../support/ui.js";

async function plugPixel(mem: Mem): Promise<FakePhone> {
  const dir = mem.path("pixel-storage");
  await writeTree(dir, {
    "DCIM/Camera/IMG_0001.jpg": { bytes: jpeg("pixel-1"), mtime: "2026-03-14T09:30:00+08:00" },
    "DCIM/Camera/VID_0001.mp4": { bytes: mp4("pixel-vid", 4096), mtime: "2026-03-14T09:35:00+08:00" },
    "Download/boarding-pass.pdf": "pdf",
  });
  const phone = { vendorId: 0x18d1, productId: 0x4ee2, serial: "PX6", label: "Pixel 6", dir };
  await mem.setPhones([phone]);
  return phone;
}

async function addCamera(page: import("@playwright/test").Page) {
  await nav(page).getByRole("button", { name: "Places" }).click();
  await page.getByRole("button", { name: "Choose a folder on Pixel 6" }).click();
  await main(page).getByRole("button", { name: /DCIM/ }).click();
  await main(page).getByRole("button", { name: /Camera/ }).click();
  await expect(main(page).getByRole("button", { name: /IMG_0001\.jpg/ })).toBeVisible();
  await page.getByRole("button", { name: "Add this folder" }).click();
  await expect(page.getByText("Added Pixel 6 · Camera")).toBeVisible();
}

test.describe("Android phone over MTP (UI, fake phone)", () => {
  test("a plugged-in phone is offered on Places", async ({ app, mem }) => {
    await plugPixel(mem);
    await nav(app).getByRole("button", { name: "Places" }).click();
    await expect(app.getByText("Pixel 6 is plugged in")).toBeVisible();
    await expect(app.getByRole("button", { name: "Choose a folder on Pixel 6" })).toBeVisible();
  });

  test("a phone plugged in while Places is open appears on the next check", async ({ app, mem }) => {
    await nav(app).getByRole("button", { name: "Places" }).click();
    await expect(app.getByText("Pixel 6 is plugged in")).toHaveCount(0);
    await plugPixel(mem);
    await nextPoll(app);
    await expect(app.getByText("Pixel 6 is plugged in")).toBeVisible();
  });

  test("browsing the phone and adding Camera registers and indexes it", async ({ app, mem }) => {
    await plugPixel(mem);
    await addCamera(app);
    const drives = await mem.drives();
    expect(drives.map((d) => [d.name, d.kind, d.rootPath, d.volumeId, d.online])).toEqual([
      ["Pixel 6 · Camera", "phone", "mtp://18d1-4ee2.PX6/DCIM/Camera", "mtp:18d1:4ee2:PX6", true],
    ]);
    expect((await mem.files()).map((f) => f.name).sort()).toEqual(["IMG_0001.jpg", "VID_0001.mp4"]);
  });

  test("a phone photo previews from the cable", async ({ app, mem }) => {
    await plugPixel(mem);
    await addCamera(app);
    await main(app).getByRole("button", { name: /IMG_0001\.jpg/ }).click();
    await expect(details(app).getByRole("heading", { name: "IMG_0001.jpg" })).toBeVisible();
    const img = details(app).locator(".insp-preview img");
    await expect(img).toHaveAttribute("src", /\/drives\/drv_[^/]+\/media\?path=IMG_0001\.jpg/);
    await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBeGreaterThan(0);
  });

  test("a phone video asks before loading over the cable", async ({ app, mem }) => {
    await plugPixel(mem);
    await addCamera(app);
    const videoRequests: string[] = [];
    app.on("request", (req) => req.url().includes("VID_0001.mp4") && videoRequests.push(req.url()));
    await main(app).getByRole("button", { name: /VID_0001\.mp4/ }).click();
    await expect(details(app).getByRole("button", { name: "Preview" })).toBeVisible();
    await app.waitForTimeout(300);
    expect(videoRequests, "nothing is pulled over the cable before Preview").toEqual([]);
    await details(app).getByRole("button", { name: "Preview" }).click();
    await expect.poll(() => videoRequests.length).toBeGreaterThan(0);
    expect(videoRequests[0]).toMatch(/\/drives\/drv_[^/]+\/media\?path=VID_0001\.mp4/);
  });

  test("unplugging the phone marks the place Unplugged; its files stay listed", async ({ app, mem }) => {
    await plugPixel(mem);
    await addCamera(app);
    await mem.setPhones([]);
    // Leave the place browser via another screen (Places → Places does not leave it; see places.spec).
    await nav(app).getByRole("button", { name: "Settings" }).click();
    await nav(app).getByRole("button", { name: "Places" }).click();
    await nextPoll(app);
    await expect(app.locator(".place-card").filter({ hasText: "Pixel 6 · Camera" })).toContainText("Unplugged");
    await nav(app).getByRole("button", { name: "Everything" }).click();
    await expect(main(app).getByRole("button", { name: /IMG_0001\.jpg/ })).toBeVisible();
  });

  test("copying a phone photo to this computer is byte-identical", async ({ app, mem }) => {
    const phone = await plugPixel(mem);
    const home = await mem.place("Home");
    await mem.addPlace({ name: "This computer", kind: "computer", rootPath: home });
    await addCamera(app);
    await nav(app).getByRole("button", { name: "Everything" }).click();
    await main(app).getByRole("button", { name: /IMG_0001\.jpg/ }).click();
    await details(app).getByRole("button", { name: "Copy to…" }).click();
    await app.getByRole("menuitem", { name: /This computer/ }).click();
    await expect(app.getByText("Copied to This computer")).toBeVisible();
    expect(sha256(await readFile(join(home, "IMG_0001.jpg")))).toBe(sha256(await readFile(join(phone.dir, "DCIM/Camera/IMG_0001.jpg"))));
  });

  test("backing up the phone Camera onto a USB stick", async ({ app, mem }) => {
    const phone = await plugPixel(mem);
    const usb = await mem.plugDrive("TRAVEL");
    await mem.addPlace({ name: "Travel USB", kind: "usb", rootPath: usb.mountPath });
    await addCamera(app);
    await nav(app).getByRole("button", { name: "Backup" }).click();
    await app.getByRole("button", { name: "New backup" }).click();
    await main(app).getByRole("button", { name: /^Pixel 6 · Camera.*Plugged in/ }).click();
    await app.getByRole("button", { name: "Select Pixel 6 · Camera" }).click();
    await app.getByRole("button", { name: "Continue" }).click();
    await main(app).getByRole("button", { name: /^Travel USB.*Plugged in/ }).click();
    await app.getByRole("button", { name: "Save backup" }).click();
    await app.locator(".backup-card").getByRole("button", { name: "Back up now" }).click();
    await expect(app.locator(".backup-card")).toContainText("All done. 2 new files copied.");
    expect(sha256(await readFile(join(usb.mountPath, "IMG_0001.jpg")))).toBe(sha256(await readFile(join(phone.dir, "DCIM/Camera/IMG_0001.jpg"))));
  });

  test("a folder that disappears from the phone mid-browse shows an error, not a crash", async ({ app, mem }) => {
    const phone = await plugPixel(mem);
    await nav(app).getByRole("button", { name: "Places" }).click();
    await app.getByRole("button", { name: "Choose a folder on Pixel 6" }).click();
    await expect(main(app).getByRole("button", { name: /DCIM/ })).toBeVisible();
    await rm(join(phone.dir, "DCIM"), { recursive: true });
    await main(app).getByRole("button", { name: /DCIM/ }).click();
    await expect(app.getByRole("heading", { name: "This folder didn’t open" })).toBeVisible();
    await expect(nav(app)).toBeVisible();
  });

  test("without a phone, Android phone shows the File transfer steps", async ({ app }) => {
    await nav(app).getByRole("button", { name: "Add a place" }).click();
    await app.getByRole("dialog").getByRole("button", { name: /Android phone/ }).click();
    await expect(app.getByRole("heading", { name: "Add your phone" })).toBeVisible();
    await expect(app.getByRole("dialog")).toContainText("File transfer");
  });
});
