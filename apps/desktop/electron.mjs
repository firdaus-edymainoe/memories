import { app, BrowserWindow, dialog, ipcMain, nativeTheme, shell } from "electron";
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const port = process.env.MEMORIES_PORT || "47821";
const apiUrl = `http://127.0.0.1:${port}`;
const ui =
  process.env.MEMORIES_UI ||
  `http://127.0.0.1:5173/?live=1&api=${encodeURIComponent(apiUrl)}&chrome=${process.platform}`;
const uiOrigin = new URL(ui).origin;

/** @type {import("node:child_process").ChildProcess | null} */
let api = null;

async function apiHealthy() {
  try {
    const res = await fetch(`${apiUrl}/health`, { signal: AbortSignal.timeout(1000) });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Start the local API as a child process, with the catalog in this app's userData folder.
 * If an API already answers on the port (npm run dev:api), use that one instead.
 * The UI retries on its own, so a slow start shows "getting ready" rather than an error.
 */
async function startApi() {
  if (process.env.MEMORIES_SPAWN_API === "0" || (await apiHealthy())) return;
  const dataDir = app.getPath("userData");
  mkdirSync(dataDir, { recursive: true });
  const env = {
    ...process.env,
    MEMORIES_PORT: port,
    MEMORIES_DB: process.env.MEMORIES_DB || join(dataDir, "catalog.sqlite"),
    MEMORIES_UI_ORIGINS: uiOrigin,
    MEMORIES_PARENT_PID: String(process.pid),
  };
  delete env.ELECTRON_RUN_AS_NODE;
  api = spawn(process.env.MEMORIES_NODE || "node", ["--import", "tsx", join(here, "src", "serve.ts")], {
    cwd: here,
    env,
    stdio: ["ignore", "inherit", "inherit"],
  });
  api.on("error", (error) => console.error("Memories API failed to start:", error.message));
  api.on("exit", () => {
    api = null;
  });
  const deadline = Date.now() + 15_000;
  while (api && Date.now() < deadline) {
    if (await apiHealthy()) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

function stopApi() {
  if (api && api.exitCode === null) api.kill();
  api = null;
}

const CHROME = {
  light: "#FBFBFD",
  dark: "#1C1C1E",
};

const DARWIN_INSET = `
html[data-chrome="darwin"] .brand,
.brand {
  padding-left: 74px !important;
  min-height: 32px !important;
  display: flex !important;
  align-items: center !important;
}
`;

function createWindow() {
  const window = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 420,
    minHeight: 400,
    title: "Memories",
    backgroundColor: nativeTheme.shouldUseDarkColors ? CHROME.dark : CHROME.light,
    show: false,
    autoHideMenuBar: true,
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : process.platform === "win32" ? "hidden" : "default",
    trafficLightPosition: { x: 14, y: 16 },
    webPreferences: {
      preload: join(here, "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
    },
  });

  const sendMaximized = () => window.webContents.send("memories-maximized", window.isMaximized());
  window.on("maximize", sendMaximized);
  window.on("unmaximize", sendMaximized);
  window.webContents.on("dom-ready", () => {
    if (process.platform === "darwin") void window.webContents.insertCSS(DARWIN_INSET);
  });
  window.once("ready-to-show", () => window.show());

  // Links never open new app windows: web links go to the browser, everything else is dropped.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url) && new URL(url).origin !== uiOrigin) void shell.openExternal(url);
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event, url) => {
    if (new URL(url).origin !== uiOrigin) event.preventDefault();
  });
  void window.loadURL(ui);
  return window;
}

ipcMain.on("memories-titlebar", (event, theme) => {
  const window = BrowserWindow.fromWebContents(event.sender);
  if (window) window.setBackgroundColor(theme === "dark" ? CHROME.dark : CHROME.light);
});

ipcMain.on("memories-window", (event, action) => {
  const window = BrowserWindow.fromWebContents(event.sender);
  if (!window) return;
  if (action === "minimize") window.minimize();
  if (action === "maximize") window.isMaximized() ? window.unmaximize() : window.maximize();
  if (action === "close") window.close();
});

ipcMain.handle("memories-pick-folder", async (event) => {
  const window = BrowserWindow.fromWebContents(event.sender);
  const options = { title: "Choose a folder for Memories", properties: ["openDirectory", "createDirectory"] };
  const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options);
  return result.canceled ? null : (result.filePaths[0] ?? null);
});

ipcMain.handle("memories-maximized", (event) => {
  return BrowserWindow.fromWebContents(event.sender)?.isMaximized() ?? false;
});

app.whenReady().then(async () => {
  await startApi();
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("will-quit", stopApi);

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
