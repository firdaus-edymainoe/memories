import {
  CloudFileIO,
  CloudService,
  CloudVolumes,
  JsonFileStateStore,
  type SecretBox,
  WithCloudFileIO,
  WithCloudVolumes,
} from "@memories/cloud-link";
import { BackupScheduler, type FileIO, type Ports, registerDrive, type Volumes } from "@memories/core";
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
import { homedir, hostname, platform } from "node:os";
import { dirname, join } from "node:path";

function phonePorts() {
  void ensureAdb().catch(() => undefined);
  const mtp = createOsMtpHost();
  const phoneIO = new PhoneFileIO(new MtpFileIO(mtp), new AndroidFileIO());
  const phoneVolumes = new PhoneVolumes(new MtpVolumes(mtp), new AndroidVolumes());
  return { phoneIO, phoneVolumes };
}

export async function createLocalPorts(catalogPath: string): Promise<Ports & { catalog: SqliteCatalog }> {
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

export type CloudHostOptions = {
  /** The Memories cloud server. Without it the app is local only, with no sign-in offered. */
  serverUrl: string | null;
  /** Seals the session token on disk (Electron's `safeStorage`). */
  secrets: SecretBox;
  /** Opens the system browser for signing in with a provider. */
  openExternal: (url: string) => Promise<void>;
};

/**
 * Adds optional cloud mode to local ports: the account and sync service, and cloud storage as
 * a place (`cloud://` paths go to the cloud, everything else stays on the local adapters).
 */
export async function withCloud(local: Ports & { catalog: SqliteCatalog }, catalogPath: string, options: CloudHostOptions) {
  let ports: Ports;
  const cloud = new CloudService({
    serverUrl: options.serverUrl,
    store: new JsonFileStateStore(join(dirname(catalogPath), "cloud.json"), options.secrets),
    changes: local.catalog.changes(),
    places: {
      list: () => local.catalog.listDrives(),
      register: (input) => registerDrive(ports, input),
    },
    openExternal: options.openExternal,
    device: { name: hostname(), platform: platform() },
  });
  await cloud.load();
  ports = {
    catalog: local.catalog,
    fileIO: new WithCloudFileIO(local.fileIO, new CloudFileIO(cloud)),
    volumes: new WithCloudVolumes(local.volumes, new CloudVolumes(cloud)),
  };
  return { ports, cloud };
}

/** The API plus the background work that runs next to it (automatic backups, cloud sync). */
export async function createLocalHost(
  catalogPath = defaultCatalogPath(),
  options: AppOptions = {},
  cloudOptions?: CloudHostOptions,
) {
  const local = await createLocalPorts(catalogPath);
  if (!cloudOptions?.serverUrl) {
    return { app: createApp(local, options), ports: local as Ports, cloud: null, stopAutoBackups: startAutoBackups(local) };
  }
  const { ports, cloud } = await withCloud(local, catalogPath, cloudOptions);
  const stopBackups = startAutoBackups(ports);
  cloud.startBackgroundSync();
  return {
    app: createApp(ports, { ...options, cloud }),
    ports,
    cloud,
    stopAutoBackups: () => {
      stopBackups();
      cloud.stopBackgroundSync();
    },
  };
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
