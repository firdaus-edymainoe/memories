import { chmodSync, copyFileSync, existsSync, mkdirSync } from "node:fs";
import { execFile } from "node:child_process";
import { rm } from "node:fs/promises";
import { homedir, platform as osPlatform, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export function vendorAdbPath() {
  const pkg = join(fileURLToPath(new URL(".", import.meta.url)), "..", "vendor");
  if (osPlatform() === "win32") return join(pkg, "win32", "adb.exe");
  if (osPlatform() === "darwin") return join(pkg, "darwin", "adb");
  return join(pkg, "linux", "adb");
}

export function userAdbPath() {
  const dir =
    osPlatform() === "win32"
      ? join(homedir(), "AppData", "Roaming", "Memories", "platform-tools")
      : join(homedir(), "Library", "Application Support", "Memories", "platform-tools");
  return osPlatform() === "win32" ? join(dir, "adb.exe") : join(dir, "adb");
}

export function resolveAdbBin() {
  if (process.env.MEMORIES_ADB) return process.env.MEMORIES_ADB;
  for (const candidate of [vendorAdbPath(), userAdbPath()]) {
    if (existsSync(candidate)) return candidate;
  }
  return "adb";
}

export function platformToolsZipUrl() {
  const os = osPlatform();
  const slug = os === "win32" ? "windows" : os === "darwin" ? "darwin" : "linux";
  return `https://dl.google.com/android/repository/platform-tools-latest-${slug}.zip`;
}

/** Copy adb (and Windows USB DLLs) from an extracted platform-tools folder. */
export function installAdbFromDir(extracted: string, destBin: string) {
  mkdirSync(dirname(destBin), { recursive: true });
  const src = osPlatform() === "win32" ? join(extracted, "adb.exe") : join(extracted, "adb");
  if (!existsSync(src)) throw new Error("platform-tools zip did not contain adb");
  copyFileSync(src, destBin);
  if (osPlatform() !== "win32") chmodSync(destBin, 0o755);
  if (osPlatform() === "win32") {
    for (const dll of ["AdbWinApi.dll", "AdbWinUsbApi.dll"]) {
      const from = join(extracted, dll);
      if (existsSync(from)) copyFileSync(from, join(dirname(destBin), dll));
    }
  }
}

export function tmpExtractDir() {
  return join(tmpdir(), `memories-platform-tools-${process.pid}`);
}

/** Download Google platform-tools and keep only adb next to the app. Users never install it. */
export async function ensureAdb(): Promise<string> {
  const resolved = resolveAdbBin();
  if (resolved !== "adb") return resolved;
  const dest = userAdbPath();
  const work = join(tmpdir(), `memories-adb-${Date.now()}`);
  const zip = join(work, "platform-tools.zip");
  mkdirSync(work, { recursive: true });
  try {
    await execFileAsync("curl", ["-fsSL", platformToolsZipUrl(), "-o", zip]);
    await execFileAsync("unzip", ["-q", zip, "-d", work]);
    installAdbFromDir(join(work, "platform-tools"), dest);
    return dest;
  } finally {
    await rm(work, { recursive: true, force: true }).catch(() => undefined);
  }
}
