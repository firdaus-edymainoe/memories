import { _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import { access, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REPO, TZ } from "../../support/env.js";
import { expect, test, type Mem } from "../../support/fixtures.js";
import { familyPictures } from "../../support/places.js";

test.skip(process.platform === "linux" && !process.env.DISPLAY, "Electron needs a display: run `npm run test:e2e:electron` (xvfb-run)");
// Electron start-up is slow on a loaded CI box; each test launches and closes its own app.
test.describe.configure({ timeout: 90_000 });

const MAIN = join(REPO, "apps", "desktop", "electron.mjs");

/**
 * Launch the desktop app. If an API already answers on MEMORIES_PORT the app uses it; otherwise it
 * starts its own. Test mode is on so an API the app starts uses fake volumes and never runs adb.
 */
async function launch(env: Record<string, string>): Promise<{ electronApp: ElectronApplication; win: Page; profile: string }> {
  // A fresh profile per launch: otherwise localStorage (theme, lens) leaks between tests and runs.
  const profile = await mkdtemp(join(tmpdir(), "memories-e2e-electron-"));
  const base = { ...(process.env as Record<string, string>) };
  delete base.MEMORIES_DB;
  const electronApp = await electron.launch({
    args: [MAIN, `--user-data-dir=${profile}`, "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"],
    env: {
      ...base,
      TZ,
      ELECTRON_DISABLE_SECURITY_WARNINGS: "1",
      MEMORIES_TEST_MODE: "1",
      MEMORIES_ADB: join(REPO, "e2e", "support", "no-adb"),
      ...env,
    },
    timeout: 60_000,
  });
  electronApp.process().once("exit", () => void rm(profile, { recursive: true, force: true }));
  const win = await electronApp.firstWindow();
  await win.waitForLoadState("domcontentloaded");
  return { electronApp, win, profile };
}

/** Use this worker's API (the app sees it answering and doesn't start its own). */
function onWorkerApi(mem: Mem, ui = mem.appUrl()) {
  return { MEMORIES_PORT: String(mem.server.port), MEMORIES_UI: ui };
}

async function health(port: number) {
  return (await fetch(`http://127.0.0.1:${port}/health`).catch(() => null))?.status ?? 0;
}

async function seed(mem: Mem) {
  const root = await mem.place("Pictures", familyPictures());
  await mem.addAndIngest({ name: "Family pictures", kind: "computer", rootPath: root });
}

function freePort() {
  return new Promise<number>((resolve) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });
}

test.describe("Electron desktop shell", () => {
  let current: ElectronApplication | null = null;
  test.afterEach(async () => {
    await current?.close().catch(() => {});
    current = null;
  });

  test("opens the Memories window on the live catalog with the preload bridge", async ({ mem }) => {
    await seed(mem);
    const { electronApp, win } = await launch(onWorkerApi(mem, `${mem.appUrl()}&chrome=${process.platform}`));
    current = electronApp;
    await expect(win).toHaveTitle("Memories");
    await expect(win.getByRole("navigation", { name: "Main" }).getByRole("button", { name: "Family pictures" })).toBeVisible();
    await expect(win.getByText("8 files").first()).toBeVisible();
    expect(await win.evaluate(() => window.memoriesChrome?.platform)).toBe(process.platform);
    await expect(win.locator("html")).toHaveAttribute("data-chrome", process.platform);
    const bounds = await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.getBounds());
    expect([bounds.width, bounds.height]).toEqual([1280, 800]);
  });

  test("the renderer is sandboxed: no Node globals, only the chrome bridge", async ({ mem }) => {
    const { electronApp, win } = await launch(onWorkerApi(mem));
    current = electronApp;
    await expect(win.getByRole("navigation", { name: "Main" })).toBeVisible();
    const globals = await win.evaluate(() => ({
      require: typeof (globalThis as { require?: unknown }).require,
      process: typeof (globalThis as { process?: unknown }).process,
      bridge: Object.keys(window.memoriesChrome ?? {}).sort(),
    }));
    expect(globals.require).toBe("undefined");
    expect(globals.process).toBe("undefined");
    expect(globals.bridge).toEqual(expect.arrayContaining(["pickFolder", "platform", "setTitleBar"]));
  });

  test("each launch starts from a clean profile (theme from a previous run does not leak)", async ({ mem }) => {
    const first = await launch(onWorkerApi(mem));
    current = first.electronApp;
    await first.win.getByRole("button", { name: "Switch to dark" }).click();
    await first.electronApp.close();
    const second = await launch(onWorkerApi(mem));
    current = second.electronApp;
    await expect(second.win.getByRole("button", { name: "Switch to dark" })).toBeVisible();
  });

  test("switching to dark tells the window to repaint its title bar colour", async ({ mem }) => {
    const { electronApp, win } = await launch(onWorkerApi(mem));
    current = electronApp;
    await win.getByRole("button", { name: "Switch to dark" }).click();
    await expect(win.locator("html")).toHaveAttribute("data-theme", "dark");
    await expect
      .poll(() => electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.getBackgroundColor()))
      .toBe("#1C1C1E");
  });

  test("closing the last window quits the app", async ({ mem }) => {
    test.skip(process.platform === "darwin", "macOS keeps the app alive after the last window closes");
    const { electronApp, win } = await launch(onWorkerApi(mem));
    current = electronApp;
    await expect(win.getByRole("navigation", { name: "Main" })).toBeVisible();
    const exited = new Promise<void>((resolve) => electronApp.process().once("exit", () => resolve()));
    await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.close());
    await exited;
    current = null;
  });

  test("a default launch shows the real catalog, not sample data", async ({ mem }) => {
    await seed(mem);
    const { electronApp, win } = await launch({ MEMORIES_PORT: String(mem.server.port), MEMORIES_UI: "" });
    current = electronApp;
    await expect(win.getByRole("navigation", { name: "Main" })).toBeVisible();
    await expect(win.getByRole("navigation", { name: "Main" }).getByRole("button", { name: "Family pictures" })).toBeVisible({ timeout: 5000 });
  });

  test("the desktop app starts its own local API with the catalog in userData, and stops it on quit", async () => {
    const port = await freePort();
    const { electronApp, win, profile } = await launch({ MEMORIES_PORT: String(port), MEMORIES_UI: "" });
    current = electronApp;
    await expect(win.getByRole("navigation", { name: "Main" })).toBeVisible();
    await expect.poll(() => health(port), { timeout: 15_000 }).toBe(200);
    const state = (await (await fetch(`http://127.0.0.1:${port}/__test/state`)).json()) as { catalogPath: string };
    expect(state.catalogPath).toBe(join(profile, "catalog.sqlite"));
    await access(state.catalogPath);
    await win.getByRole("navigation", { name: "Main" }).getByRole("button", { name: "Places" }).click();
    await expect(win.getByRole("heading", { name: "No places yet" })).toBeVisible();
    await electronApp.close();
    current = null;
    await expect.poll(() => health(port), { timeout: 10_000 }).toBe(0);
  });

  test("Choose folder uses the native dialog through the preload bridge", async ({ mem }) => {
    const root = await mem.place("Pictures", familyPictures());
    const { electronApp, win } = await launch(onWorkerApi(mem));
    current = electronApp;
    await electronApp.evaluate(({ dialog }, folder) => {
      (dialog as unknown as { showOpenDialog: unknown }).showOpenDialog = async () => ({ canceled: false, filePaths: [folder] });
    }, root);
    await win.getByRole("navigation", { name: "Main" }).getByRole("button", { name: "Add a place" }).click();
    const dialog = win.getByRole("dialog");
    await dialog.getByRole("button", { name: /This computer/ }).click();
    await dialog.getByRole("button", { name: /Choose folder/ }).click();
    await expect(dialog.locator(".folder-pick.chosen")).toContainText("Pictures");
    await dialog.getByRole("button", { name: "Add place" }).click();
    await expect(win.getByText("Added Pictures")).toBeVisible();
    expect((await mem.drives()).map((d) => d.rootPath)).toEqual([root]);
    expect(await mem.pickerCalls()).toBe(0);

    await electronApp.evaluate(({ dialog }) => {
      (dialog as unknown as { showOpenDialog: unknown }).showOpenDialog = async () => ({ canceled: true, filePaths: [] });
    });
    expect(await win.evaluate(() => window.memoriesChrome!.pickFolder!())).toBeNull();
  });

  test("links that open new windows do not load inside the app", async ({ mem }) => {
    const { electronApp, win } = await launch(onWorkerApi(mem));
    current = electronApp;
    await expect(win.getByRole("navigation", { name: "Main" })).toBeVisible();
    await win.evaluate(() => void window.open("http://127.0.0.1:9/not-memories", "_blank"));
    await win.waitForTimeout(1500);
    expect(await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1);
    const before = win.url();
    await win.evaluate(() => {
      window.location.href = "http://127.0.0.1:9/elsewhere";
    });
    await win.waitForTimeout(1000);
    expect(win.url()).toBe(before);
  });
});
