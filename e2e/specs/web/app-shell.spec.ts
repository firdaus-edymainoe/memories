import { expect, test } from "../../support/fixtures.js";
import { familyPictures } from "../../support/places.js";
import { main, nav } from "../../support/ui.js";

test.describe("settings and app shell (UI)", () => {
  test("Dark appearance applies at once and survives a reload", async ({ app }) => {
    await nav(app).getByRole("button", { name: "Settings" }).click();
    await app.getByRole("radio", { name: /Dark/ }).click();
    await expect(app.locator("html")).toHaveAttribute("data-theme", "dark");
    await app.reload();
    await expect(app.locator("html")).toHaveAttribute("data-theme", "dark");
    await nav(app).getByRole("button", { name: "Settings" }).click();
    await app.getByRole("radio", { name: /Light/ }).click();
    await expect(app.locator("html")).toHaveAttribute("data-theme", "light");
  });

  test("Match my computer follows the OS colour scheme", async ({ app }) => {
    await nav(app).getByRole("button", { name: "Settings" }).click();
    await app.getByRole("radio", { name: /Match my computer/ }).click();
    await app.emulateMedia({ colorScheme: "dark" });
    await expect(app.locator("html")).toHaveAttribute("data-theme", "dark");
    await app.emulateMedia({ colorScheme: "light" });
    await expect(app.locator("html")).toHaveAttribute("data-theme", "light");
  });

  test("the sidebar switch flips light and dark", async ({ app }) => {
    await app.getByRole("button", { name: "Switch to dark" }).click();
    await expect(app.locator("html")).toHaveAttribute("data-theme", "dark");
    await expect(app.getByRole("button", { name: "Switch to light" })).toBeVisible();
  });

  test("Settings states that everything stays on this computer", async ({ app }) => {
    await nav(app).getByRole("button", { name: "Settings" }).click();
    await expect(app.getByRole("heading", { name: "Your privacy" })).toBeVisible();
    await expect(app.getByText("Everything stays on this computer")).toBeVisible();
  });

  test("a narrow window turns the sidebar into a drawer", async ({ app }) => {
    await app.setViewportSize({ width: 700, height: 800 });
    await app.getByRole("button", { name: "Menu" }).click();
    await expect(app.getByRole("button", { name: "Menu", expanded: true })).toBeVisible();
    await expect(app.locator(".drawer-panel")).toBeVisible();
  });

  test("the Mac window inset comes from ?chrome=darwin when the preload is missing", async ({ page, mem }) => {
    await page.goto(mem.appUrl("&chrome=darwin"));
    await expect(page.locator("html")).toHaveAttribute("data-chrome", "darwin");
  });
});

test.describe("API failures (UI)", () => {
  test("when the API is not running the user sees “Memories is getting ready” with the error", async ({ page, mem }) => {
    await page.goto(mem.appUrl().replace(encodeURIComponent(mem.url), encodeURIComponent("http://127.0.0.1:9")));
    await expect(page.getByRole("heading", { name: "Memories is getting ready" })).toBeVisible();
    await expect(page.locator(".hint")).not.toBeEmpty();
  });

  test("Settings still opens while the API is down", async ({ page, mem }) => {
    await page.goto(mem.appUrl().replace(encodeURIComponent(mem.url), encodeURIComponent("http://127.0.0.1:9")));
    await expect(page.getByRole("heading", { name: "Memories is getting ready" })).toBeVisible();
    await nav(page).getByRole("button", { name: "Settings" }).click();
    await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible({ timeout: 3000 });
  });

  test("the app recovers by itself when the API comes up after the UI", async ({ page, mem }) => {
    const root = await mem.place("Pictures", familyPictures());
    await mem.addAndIngest({ name: "Pictures", kind: "computer", rootPath: root });
    const apiPattern = new RegExp(`^${mem.url.replace(/[.]/g, "\\.")}/`);
    await page.route(apiPattern, (route) => route.abort("connectionrefused"));
    await page.goto(mem.appUrl());
    await expect(page.getByRole("heading", { name: "Memories is getting ready" })).toBeVisible();
    await page.unroute(apiPattern);
    await expect(main(page).getByRole("button", { name: /First dance\.jpg/ })).toBeVisible({ timeout: 12_000 });
  });

  test("when the API is not running the message is friendly", async ({ page, mem }) => {
    await page.goto(mem.appUrl().replace(encodeURIComponent(mem.url), encodeURIComponent("http://127.0.0.1:9")));
    await expect(page.locator(".hint")).toHaveText(/Memories isn’t responding/, { timeout: 3000 });
  });

  test("Try again reconnects as soon as the API answers", async ({ page, mem }) => {
    const root = await mem.place("Pictures", familyPictures());
    await mem.addAndIngest({ name: "Pictures", kind: "computer", rootPath: root });
    const apiPattern = new RegExp(`^${mem.url.replace(/[.]/g, "\\.")}/`);
    await page.route(apiPattern, (route) => route.abort("connectionrefused"));
    await page.goto(mem.appUrl());
    await expect(page.getByRole("heading", { name: "Memories is getting ready" })).toBeVisible();
    await page.unroute(apiPattern);
    await page.getByRole("button", { name: "Try again" }).click();
    await expect(main(page).getByRole("button", { name: /First dance\.jpg/ })).toBeVisible({ timeout: 3000 });
  });

  test("appearance can be changed while the API is down", async ({ page, mem }) => {
    await page.goto(mem.appUrl().replace(encodeURIComponent(mem.url), encodeURIComponent("http://127.0.0.1:9")));
    await nav(page).getByRole("button", { name: "Settings" }).click();
    await page.getByRole("radio", { name: /Dark/ }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  });

  test("a server error loading the library is shown and a reload recovers", async ({ page, mem }) => {
    const root = await mem.place("Pictures", familyPictures());
    await mem.addAndIngest({ name: "Pictures", kind: "computer", rootPath: root });
    await page.route(/\/files(\?|$)/, (route) => route.fulfill({ status: 500, contentType: "application/json", body: '{"error":"database is locked"}' }));
    await page.goto(mem.appUrl());
    await expect(page.getByText("database is locked")).toBeVisible();
    await page.unroute(/\/files(\?|$)/);
    await page.reload();
    await expect(main(page).getByRole("button", { name: /First dance\.jpg/ })).toBeVisible();
  });

  test("a slow folder shows the waiting polaroid, then the folder", async ({ app, mem }) => {
    const root = await mem.place("Pictures", familyPictures());
    await mem.addAndIngest({ name: "Pictures", kind: "computer", rootPath: root });
    await app.reload();
    await app.route(/\/entries\?path=Wedding/, async (route) => {
      await new Promise((r) => setTimeout(r, 1500));
      await route.continue();
    });
    await nav(app).getByRole("button", { name: "Pictures" }).click();
    await main(app).getByRole("button", { name: /Wedding/ }).click();
    await expect(app.getByRole("status")).toContainText("Opening Wedding");
    await expect(main(app).getByRole("button", { name: /First dance\.jpg/ })).toBeVisible();
  });
});
