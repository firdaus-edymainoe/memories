const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("memoriesChrome", {
  platform: process.platform,
  setTitleBar(theme) {
    ipcRenderer.send("memories-titlebar", theme === "dark" ? "dark" : "light");
  },
  minimize() {
    ipcRenderer.send("memories-window", "minimize");
  },
  toggleMaximize() {
    ipcRenderer.send("memories-window", "maximize");
  },
  close() {
    ipcRenderer.send("memories-window", "close");
  },
  isMaximized() {
    return ipcRenderer.invoke("memories-maximized");
  },
  onMaximized(listener) {
    const fn = (_event, value) => listener(Boolean(value));
    ipcRenderer.on("memories-maximized", fn);
    return () => ipcRenderer.removeListener("memories-maximized", fn);
  },
});
