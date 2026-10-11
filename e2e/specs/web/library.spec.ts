import { expect, knownBug, test } from "../../support/fixtures.js";
import { familyPictures, jpeg, text } from "../../support/places.js";
import { addPlaceViaUi, main, nav } from "../../support/ui.js";

test.describe("first run and adding a place (UI)", () => {
  test("an empty catalog shows live data, not the sample cabinet", async ({ app }) => {
    await expect(app.getByText("Sample data")).toHaveCount(0);
    await expect(nav(app).getByRole("button", { name: "This Mac · Pictures" })).toHaveCount(0);
    await nav(app).getByRole("button", { name: "Places" }).click();
    await expect(app.getByRole("heading", { name: "No places yet" })).toBeVisible();
  });

  test("adds a computer folder through the dialog and fills the library", async ({ app, mem }) => {
    const root = await mem.place("Pictures", familyPictures());
    await addPlaceViaUi(app, { kind: /This computer/, path: root, name: "Family pictures" });
    await expect(app.getByText("Added Family pictures")).toBeVisible();
    await expect(nav(app).getByRole("button", { name: "Family pictures" })).toBeVisible();
    await nav(app).getByRole("button", { name: "Everything" }).click();
    await expect(main(app).getByText("8 files")).toBeVisible();
    await expect(main(app).getByRole("region", { name: "Photos" })).toContainText("First dance.jpg");
    await expect(main(app).getByRole("region", { name: "Videos" })).toContainText("Speeches.mp4");
    await expect(main(app).getByRole("region", { name: "Documents" })).toContainText("Flight tickets.pdf");
    expect((await mem.drives()).map((d) => [d.name, d.kind, d.rootPath])).toEqual([["Family pictures", "computer", root]]);
  });

  test("the add dialog cannot be submitted without a folder and a name", async ({ app }) => {
    await nav(app).getByRole("button", { name: "Add a place" }).click();
    const dialog = app.getByRole("dialog");
    await dialog.getByRole("button", { name: /USB stick/ }).click();
    const add = dialog.getByRole("button", { name: "Add place" });
    await expect(add).toBeDisabled();
    await dialog.getByRole("button", { name: /Choose folder/ }).click();
    await dialog.getByLabel("Folder location").fill("/somewhere");
    await dialog.getByLabel("Call it").fill("   ");
    await expect(add).toBeDisabled();
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toBeHidden();
  });

  test("Choose folder opens the system folder picker", async ({ app }) => {
    knownBug("POST /pick-folder is not implemented and Electron has no dialog IPC; the UI always falls back to a typed path");
    await nav(app).getByRole("button", { name: "Add a place" }).click();
    const dialog = app.getByRole("dialog");
    await dialog.getByRole("button", { name: /This computer/ }).click();
    const picked = app.waitForResponse((res) => res.url().endsWith("/pick-folder"));
    await dialog.getByRole("button", { name: /Choose folder/ }).click();
    expect((await picked).status()).toBe(200);
    await expect(dialog.locator(".folder-pick.chosen")).toBeVisible({ timeout: 2000 });
  });

  test("adding a folder that does not exist tells the user", async ({ app, mem }) => {
    knownBug("a non-existent folder is registered and shown as 'Ready' with 0 files instead of an error");
    const ingest = app.waitForResponse((res) => res.url().endsWith("/ingest"));
    await addPlaceViaUi(app, { kind: /This computer/, path: mem.path("does-not-exist"), name: "Ghost" });
    await ingest;
    await expect(app.getByText(/doesn’t exist|can’t find|couldn’t find|not found/i)).toBeVisible({ timeout: 3000 });
  });

  test.describe("with sample photos stubbed", () => {
    test.use({ stubExternalHosts: ["images.unsplash.com"] });

  test("the welcome tour walks every scene and Get started opens Add a place", async ({ app }) => {
    await nav(app).getByRole("button", { name: "Welcome tour" }).click();
    await expect(app.getByRole("dialog", { name: "Welcome to Memories" })).toBeVisible();
    const tour = app.getByRole("dialog");
    const steps = ["Add the places you keep things", "You don’t have to organize", "Unplugged? Still in the list", "Keep a spare with Backup"];
    for (const step of steps) {
      await tour.getByRole("button", { name: "Next" }).click();
      await expect(app.getByRole("dialog", { name: step })).toBeVisible();
    }
    await expect(tour.getByRole("heading", { name: "Keep a spare with Backup" })).toBeVisible();
    await tour.getByRole("button", { name: "Get started" }).click();
    await expect(app.getByRole("heading", { name: "Add a place" })).toBeVisible();
  });

  test("Skip welcome closes the tour", async ({ app }) => {
    await nav(app).getByRole("button", { name: "Welcome tour" }).click();
    await app.getByRole("button", { name: "Skip welcome" }).click();
    await expect(app.getByRole("dialog", { name: "Welcome to Memories" })).toBeHidden();
  });
  });

  test("the welcome tour works offline without fetching photos from the internet", async ({ app, externalRequests }) => {
    knownBug("Welcome.tsx hot-links images.unsplash.com, so the 'everything stays on this computer' app calls the internet");
    await nav(app).getByRole("button", { name: "Welcome tour" }).click();
    await expect(app.getByRole("dialog", { name: "Welcome to Memories" })).toBeVisible();
    await app.waitForTimeout(500);
    expect(externalRequests).toEqual([]);
    externalRequests.length = 0;
  });
});

test.describe("browsing the library (UI)", () => {
  test.beforeEach(async ({ mem }) => {
    const root = await mem.place("Pictures", {
      ...familyPictures(),
      "Downloads/Printer driver.dmg": { bytes: text("dmg"), mtime: "2026-02-14T10:00:00+08:00" },
      "Music/Grandma’s songs.mp3": { bytes: text("mp3"), mtime: "2025-09-20T15:00:00+08:00" },
    });
    await mem.addAndIngest({ name: "Pictures", kind: "computer", rootPath: root });
  });

  test("Type lens groups by kind; Date lens groups by month in local time", async ({ app }) => {
    await expect(main(app).getByRole("region", { name: "Photos" })).toBeVisible();
    await expect(main(app).getByRole("region", { name: "Apps & installers" })).toContainText("Printer driver.dmg");
    await expect(main(app).getByRole("region", { name: "Music & audio" })).toContainText("Grandma’s songs.mp3");
    await app.getByRole("radio", { name: "Date" }).click();
    await expect(main(app).getByRole("region", { name: "August 2025" })).toContainText("First dance.jpg");
    await expect(main(app).getByRole("region", { name: "June 2026" })).toContainText("School report 2026.pdf");
  });

  test("Moments gathers photos and videos from the same day", async ({ app }) => {
    await app.getByRole("radio", { name: "Moments" }).click();
    await expect(main(app)).toContainText("First dance.jpg");
    await expect(main(app)).toContainText("Speeches.mp4");
    await expect(main(app)).not.toContainText("Flight tickets.pdf");
  });

  test("lens and tile/list view are remembered after a reload", async ({ app }) => {
    await app.getByRole("radio", { name: "Date" }).click();
    await app.getByRole("radio", { name: /List/i }).click();
    await app.reload();
    await expect(app.getByRole("radio", { name: "Date" })).toHaveAttribute("aria-checked", "true");
    await expect(app.getByRole("radio", { name: /List/i })).toHaveAttribute("aria-checked", "true");
    expect(await app.evaluate(() => [localStorage.getItem("memories-lens"), localStorage.getItem("memories-view")])).toEqual(["date", "list"]);
  });

  test("Find by name filters, Ctrl+F focuses it, and a miss says so", async ({ app }) => {
    await app.keyboard.press("Control+f");
    const search = app.getByRole("searchbox", { name: "Find by name" });
    await expect(search).toBeFocused();
    await search.fill("ticket");
    await expect(main(app).getByRole("button", { name: /Flight tickets\.pdf/ })).toBeVisible();
    await expect(main(app).getByRole("region", { name: "Photos" })).toHaveCount(0);
    await search.fill("zebra");
    await expect(main(app).getByRole("heading", { name: "Nothing called “zebra”" })).toBeVisible();
  });

  test("shelves in the sidebar open just that kind", async ({ app }) => {
    await nav(app).getByRole("button", { name: "Photos" }).click();
    await expect(main(app).getByRole("heading", { name: "Photos", level: 1 })).toBeVisible();
    await expect(main(app)).toContainText("Beach morning.jpg");
    await expect(main(app)).not.toContainText("notes.txt");
    await nav(app).getByRole("button", { name: "Videos" }).click();
    await expect(main(app)).toContainText("Speeches.mp4");
    await expect(main(app)).not.toContainText("Beach morning.jpg");
  });

  test("Documents expand into formats, and specialty shelves only appear when used", async ({ app }) => {
    await expect(nav(app).getByRole("button", { name: "Code" })).toHaveCount(0);
    await expect(nav(app).getByRole("button", { name: "Zip files" })).toHaveCount(0);
    await expect(nav(app).getByRole("button", { name: "Apps & installers" })).toBeVisible();
    await nav(app).getByRole("button", { name: "Show document formats" }).click();
    await nav(app).getByRole("button", { name: "PDF" }).click();
    await expect(main(app).getByRole("heading", { name: "PDFs" })).toBeVisible();
    await expect(main(app)).toContainText("School report 2026.pdf");
    await expect(main(app)).not.toContainText("Budget 2026.xlsx");
  });

  test("the footer counts files and ready places", async ({ app }) => {
    await expect(nav(app).locator("..")).toContainText("10 files");
    await expect(app.getByText("1 of 1 place ready")).toBeVisible();
  });
});

test.describe("library edge cases (UI)", () => {
  test("a photo with a non-ASCII name shows its preview", async ({ app, mem }) => {
    knownBug("media for names like “Adam’s birthday.jpg” returns 500 (Content-Disposition), so the tile and preview stay blank");
    const root = await mem.place("Pictures", { "Adam’s birthday.jpg": jpeg("adam") });
    await mem.addAndIngest({ name: "Pictures", kind: "computer", rootPath: root });
    const media = app.waitForResponse((res) => res.url().includes("/media"));
    await app.reload();
    expect((await media).status()).toBe(200);
  });
});
