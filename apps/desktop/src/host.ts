import { BackupScheduler, type FileIO, type Ports, type Volumes } from "@memories/core";
import { SqliteCatalog } from "@memories/db-sqlite";
import {
  AndroidFileIO,
  AndroidVolumes,
  MergeVolumes,
  MtpFileIO,
  MtpVolumes,
  PhoneFileIO,
  PhoneVolumes,
  SwitchFileIO,
  createOsMtpHost,
  ensureAdb,
} from "@memories/fs-android";
import { type AppOptions, createApp } from "@memories/server";
import { mkdirSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";

function phonePorts() {
  void ensureAdb().catch(() => undefined);
  const mtp = createOsMtpHost();
  const phoneIO = new PhoneFileIO(new MtpFileIO(mtp), new AndroidFileIO());
  const phoneVolumes = new PhoneVolumes(new MtpVolumes(mtp), new AndroidVolumes());
  return { phoneIO, phoneVolumes };
}

export async function createLocalPorts(catalogPath: string): Promise<Ports> {
  const catalog = new SqliteCatalog(catalogPath);
  const { phoneIO, phoneVolumes } = phonePorts();
  if (platform() === "win32") {
    const { NodeFileIO, Win32Volumes } = await import("@memories/fs-win32");
    return {
      catalog,
      fileIO: new SwitchFileIO(new NodeFileIO() as FileIO, phoneIO),
      volumes: new MergeVolumes(new Win32Volumes() as Volumes, phoneVolumes),
    };
  }
  const { NodeFileIO, DarwinVolumes } = await import("@memories/fs-darwin");
  return {
    catalog,
    fileIO: new SwitchFileIO(new NodeFileIO() as FileIO, phoneIO),
    volumes: new MergeVolumes(new DarwinVolumes() as Volumes, phoneVolumes),
  };
}

export function defaultCatalogPath() {
  const dir =
    platform() === "win32"
      ? join(homedir(), "AppData", "Roaming", "Memories")
      : join(homedir(), "Library", "Application Support", "Memories");
  mkdirSync(dir, { recursive: true });
  return join(dir, "catalog.sqlite");
}

export async function createLocalApp(catalogPath = defaultCatalogPath(), options: AppOptions = {}) {
  const ports = await createLocalPorts(catalogPath);
  return createApp(ports, options);
}

/** The API plus the background work that runs next to it (automatic backups). */
export async function createLocalHost(catalogPath = defaultCatalogPath(), options: AppOptions = {}) {
  const ports = await createLocalPorts(catalogPath);
  return { app: createApp(ports, options), ports, stopAutoBackups: startAutoBackups(ports) };
}

/**
 * Checks every few seconds whether places came online and runs the backups marked automatic.
 * Returns a function that stops it.
 */
export function startAutoBackups(ports: Ports, everyMs = 10_000) {
  const scheduler = new BackupScheduler(ports);
  const timer = setInterval(() => void scheduler.tick().catch(() => undefined), everyMs);
  void scheduler.tick().catch(() => undefined);
  return () => clearInterval(timer);
}
