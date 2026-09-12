import { app, BrowserWindow } from "electron";

const port = process.env.MEMORIES_PORT || "47821";
const ui = process.env.MEMORIES_UI || `http://127.0.0.1:5173/?api=${encodeURIComponent(`http://127.0.0.1:${port}`)}`;

app.whenReady().then(async () => {
  const window = new BrowserWindow({ width: 1280, height: 800, title: "Memories" });
  await window.loadURL(ui);
});
