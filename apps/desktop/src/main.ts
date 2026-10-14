import { serve } from "@hono/node-server";
import { configureVendorDirectory } from "@memories/fs-android";
import { app, BrowserWindow, dialog, ipcMain, nativeTheme, shell } from "electron";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { dirname, extname, join, normalize, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { createLocalHost, defaultCatalogPath } from "./host.js";
import { createOsThumbnails } from "./thumbnails.js";

/**
 * Electron entry. Runs the Memories API inside the app (127.0.0.1 only, random port, a fresh
 * secret per launch) and opens the UI. Set MEMORIES_UI to load the Vite dev server instead of
 * the built UI.
 */
const here = dirname(fileURLToPath(import.meta.url));
const devUi = process.env.MEMORIES_UI;
const builtUi = app.isPackaged ? join(process.resourcesPath, "ui") : join(here, "ui");

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

const STATIC_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".json": "application/json",
};

let mainWindow: BrowserWindow | null = null;
let closeServer: (() => Promise<void>) | null = null;

function configureVendor() {
  const packaged = join(process.resourcesPath, "vendor");
  const source = join(here, "..", "..", "..", "packages", "fs-android", "vendor");
  configureVendorDirectory(app.isPackaged ? packaged : source);
}

async function pickFolder() {
  const options: Electron.OpenDialogOptions = {
    title: "Choose a folder",
    buttonLabel: "Choose",
    properties: ["openDirectory", "createDirectory"],
  };
  const result = mainWindow
    ? await dialog.showOpenDialog(mainWindow, options)
    : await dialog.showOpenDialog(options);
  return result.canceled ? null : (result.filePaths[0] ?? null);
}

/** Serves the built UI next to the API so both share one origin. */
function staticUi(root: string) {
  const ui = new Hono();
  ui.get("*", async (c, next) => {
    const requested = normalize(join(root, decodeURIComponent(new URL(c.req.url).pathname)));
    const inside = relative(root, requested);
    if (inside.startsWith("..") || inside.startsWith(sep)) return next();
    const file = inside === "" ? join(root, "index.html") : requested;
    const info = await stat(file).catch(() => null);
    if (!info?.isFile()) return next();
    return new Response(await readFile(file), {
      headers: {
        "content-type": STATIC_TYPES[extname(file)] ?? "application/octet-stream",
        "x-content-type-options": "nosniff",
        "cache-control": file.endsWith("index.html") ? "no-cache" : "public, max-age=31536000, immutable",
      },
    });
  });
  return ui;
}

async function startApi() {
  const token = randomBytes(32).toString("base64url");
  const catalogPath = process.env.MEMORIES_DB ?? defaultCatalogPath();
  const host = await createLocalHost(catalogPath, {
    token,
    allowedOrigins: devUi ? [new URL(devUi).origin] : [],
    pickFolder,
    thumbnail: createOsThumbnails(join(dirname(catalogPath), "thumbnails")),
  });

  const root = new Hono();
  if (!devUi && existsSync(builtUi)) root.route("/", staticUi(builtUi));
  root.route("/", host.app);

  // The Vite dev server proxies to a fixed port; the shipped app takes any free one.
  const port = devUi ? Number(process.env.MEMORIES_PORT || 47821) : 0;
  const server = await new Promise<ReturnType<typeof serve>>((resolve) => {
    const instance = serve({ fetch: root.fetch, hostname: "127.0.0.1", port }, () => resolve(instance));
  });
  closeServer = () =>
    new Promise((resolve) => {
      host.stopAutoBackups();
      server.close(() => resolve());
    });

  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { origin, token };
}

function uiUrl(api: { origin: string; token: string }) {
  const base = devUi ?? (existsSync(builtUi) ? api.origin : "http://127.0.0.1:5173");
  const url = new URL(base);
  url.searchParams.set("api", api.origin);
  url.searchParams.set("token", api.token);
  url.searchParams.set("chrome", process.platform);
  url.searchParams.set("live", "1");
  return url.toString();
}

function createWindow(url: string) {
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

  const appOrigin = new URL(url).origin;
  window.webContents.setWindowOpenHandler(({ url: target }) => {
    if (/^https?:\/\//.test(target) && !target.startsWith(appOrigin)) void shell.openExternal(target);
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event, target) => {
    if (!target.startsWith(appOrigin)) event.preventDefault();
  });

  const sendMaximized = () => window.webContents.send("memories-maximized", window.isMaximized());
  window.on("maximize", sendMaximized);
  window.on("unmaximize", sendMaximized);
  window.webContents.on("dom-ready", () => {
    if (process.platform === "darwin") void window.webContents.insertCSS(DARWIN_INSET);
  });
  window.once("ready-to-show", () => window.show());
  void window.loadURL(url);
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

ipcMain.handle("memories-maximized", (event) => {
  return BrowserWindow.fromWebContents(event.sender)?.isMaximized() ?? false;
});

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow?.isMinimized()) mainWindow.restore();
    mainWindow?.focus();
  });

  app.whenReady().then(async () => {
    configureVendor();
    let url: string;
    try {
      url = uiUrl(await startApi());
    } catch (error) {
      dialog.showErrorBox("Memories could not start", error instanceof Error ? error.message : String(error));
      app.quit();
      return;
    }
    mainWindow = createWindow(url);
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow(url);
    });
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });

  let quitting = false;
  app.on("before-quit", (event) => {
    if (quitting || !closeServer) return;
    event.preventDefault();
    quitting = true;
    void closeServer().finally(() => app.quit());
  });
}
