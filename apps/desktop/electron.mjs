import { app, BrowserWindow, ipcMain, nativeTheme } from "electron";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const port = process.env.MEMORIES_PORT || "47821";
const ui =
  process.env.MEMORIES_UI ||
  `http://127.0.0.1:5173/?api=${encodeURIComponent(`http://127.0.0.1:${port}`)}&chrome=${process.platform}`;

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

ipcMain.handle("memories-maximized", (event) => {
  return BrowserWindow.fromWebContents(event.sender)?.isMaximized() ?? false;
});

app.whenReady().then(() => {
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
