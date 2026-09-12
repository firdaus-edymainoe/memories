#!/usr/bin/env node
import { execFile } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync } from "node:fs";
import { rm } from "node:fs/promises";
import { platform, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const pkg = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const dest =
  platform() === "win32"
    ? join(pkg, "vendor", "win32", "adb.exe")
    : platform() === "darwin"
      ? join(pkg, "vendor", "darwin", "adb")
      : join(pkg, "vendor", "linux", "adb");
const slug = platform() === "win32" ? "windows" : platform() === "darwin" ? "darwin" : "linux";
const url = `https://dl.google.com/android/repository/platform-tools-latest-${slug}.zip`;
const work = join(tmpdir(), `memories-adb-fetch-${Date.now()}`);
const zip = join(work, "platform-tools.zip");
mkdirSync(work, { recursive: true });
console.log(`Fetching ${url}`);
await execFileAsync("curl", ["-fsSL", url, "-o", zip]);
await execFileAsync("unzip", ["-q", zip, "-d", work]);
const extracted = join(work, "platform-tools");
const src = platform() === "win32" ? join(extracted, "adb.exe") : join(extracted, "adb");
if (!existsSync(src)) throw new Error("platform-tools zip did not contain adb");
mkdirSync(dirname(dest), { recursive: true });
copyFileSync(src, dest);
if (platform() !== "win32") chmodSync(dest, 0o755);
if (platform() === "win32") {
  for (const dll of ["AdbWinApi.dll", "AdbWinUsbApi.dll"]) {
    const from = join(extracted, dll);
    if (existsSync(from)) copyFileSync(from, join(dirname(dest), dll));
  }
}
await rm(work, { recursive: true, force: true });
console.log(`adb → ${dest}`);
