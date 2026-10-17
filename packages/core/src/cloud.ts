import type { BackupJob, ContentObject, Drive, FileVersion, LibraryFile, Replica, VirtualFolder } from "./domain.js";

/**
 * Optional cloud mode. Memories works without an account; signing in lets a device copy its
 * catalog to the cloud database and use cloud storage as a place. Each device syncs its own
 * catalog (paths on one computer mean nothing on another), so devices never conflict.
 */

export type CloudRole = "admin" | "user";

export type CloudUser = {
  id: string;
  email: string;
  name: string;
  /** Admins manage people as well as using the app like anyone else. */
  role: CloudRole;
  emailVerified: boolean;
  image: string | null;
};

/** A person as an admin sees them. */
export type CloudAdminUser = CloudUser & {
  banned: boolean;
  banReason: string | null;
  createdAt: string;
};

/** Sign-in methods the cloud server has set up. Email and password is always there. */
export type CloudProvider = "google" | "apple" | "microsoft" | "github" | "facebook";

export type CloudSyncState = {
  enabled: boolean;
  /** Changes waiting to be sent. */
  pending: number;
  lastSyncedAt: string | null;
  /** Why the last attempt failed, if it did. */
  error: string | null;
  running: boolean;
};

export type CloudStatus = {
  /** A cloud server is configured for this app. When false, cloud mode is not offered. */
  available: boolean;
  serverUrl: string | null;
  providers: CloudProvider[];
  user: CloudUser | null;
  sync: CloudSyncState;
  /** The cloud storage place, once the person has added it. */
  storageDriveId: string | null;
};

/** One catalog row as it is now, or `data: null` when it was deleted. */
export type SyncRecord =
  | { entity: "drive"; key: [id: string]; data: Drive | null }
  | { entity: "object"; key: [hash: string]; data: ContentObject | null }
  | { entity: "file"; key: [id: string]; data: LibraryFile | null }
  | { entity: "replica"; key: [driveId: string, relativePath: string]; data: Replica | null }
  | { entity: "folder"; key: [id: string]; data: VirtualFolder | null }
  | { entity: "fileFolder"; key: [fileId: string]; data: { fileId: string; folderId: string } | null }
  | { entity: "version"; key: [fileId: string, version: number]; data: FileVersion | null }
  | { entity: "backupJob"; key: [id: string]; data: BackupJob | null };

export type SyncEntity = SyncRecord["entity"];

export const SYNC_ENTITIES: readonly SyncEntity[] = [
  "drive",
  "object",
  "file",
  "replica",
  "folder",
  "fileFolder",
  "version",
  "backupJob",
];

/** What one device sends. `replace` drops everything the cloud held for it first. */
export type SyncBatch = {
  deviceId: string;
  replace: boolean;
  records: SyncRecord[];
};

/** Local changes waiting to be sent, oldest first. Acknowledge `cursor` once they are stored. */
export type ChangeBatch = {
  cursor: number;
  replace: boolean;
  records: SyncRecord[];
};

/**
 * The local catalog's outgoing changes. Implemented next to the catalog (it needs the same
 * storage) so a change and its record are written together.
 */
export type CatalogChangeFeed = {
  read(limit: number): Promise<ChangeBatch>;
  /** Forget changes up to `cursor`. Changes made after they were read are kept. */
  acknowledge(cursor: number): Promise<void>;
  pendingCount(): Promise<number>;
  /** Start recording changes, and queue every row so the next sync sends the whole catalog. */
  start(): Promise<void>;
  /** Stop recording and drop anything queued. */
  stop(): Promise<void>;
  isTracking(): Promise<boolean>;
};

/** The cloud side of a sync. */
export type CloudCatalogGateway = {
  push(batch: SyncBatch): Promise<void>;
};

/** A computer that syncs its catalog. The id is made on the device and kept there. */
export type CloudDevice = {
  id: string;
  name: string;
  platform: string;
  createdAt: string;
  lastSyncedAt: string | null;
};

/** Where the cloud keeps every device's catalog (the cloud server's database). */
export type CloudCatalogStore = {
  registerDevice(userId: string, device: { id: string; name: string; platform: string }): Promise<CloudDevice>;
  listDevices(userId: string): Promise<CloudDevice[]>;
  /** Stores one batch from a device, all or nothing. */
  apply(userId: string, batch: SyncBatch): Promise<void>;
  /** Everything stored for one device. */
  snapshot(userId: string, deviceId: string): Promise<SyncRecord[]>;
  removeDevice(userId: string, deviceId: string): Promise<void>;
  /** Drops every device and catalog of a person (their account was deleted). */
  removeUser(userId: string): Promise<void>;
};

export type SyncResult = { records: number; batches: number };

/**
 * Sends every queued change to the cloud, a batch at a time. A batch is forgotten locally only
 * after the cloud stored it, so a failure part-way loses nothing: the next sync resends it.
 */
export async function syncCatalog(
  feed: CatalogChangeFeed,
  gateway: CloudCatalogGateway,
  input: { deviceId: string; batchSize?: number },
): Promise<SyncResult> {
  const batchSize = input.batchSize ?? 500;
  const result: SyncResult = { records: 0, batches: 0 };
  let lastCursor = -1;
  for (;;) {
    const batch = await feed.read(batchSize);
    if (batch.records.length === 0 && !batch.replace) break;
    if (batch.cursor === lastCursor && !batch.replace) throw new Error("Sync is not making progress");
    lastCursor = batch.cursor;
    await gateway.push({ deviceId: input.deviceId, replace: batch.replace, records: batch.records });
    await feed.acknowledge(batch.cursor);
    result.records += batch.records.length;
    result.batches += 1;
    if (batch.records.length < batchSize) break;
  }
  return result;
}

/** Stable text form of a record's key, for maps and logs. */
export function syncKey(record: Pick<SyncRecord, "entity" | "key">) {
  return `${record.entity}:${JSON.stringify(record.key)}`;
}
