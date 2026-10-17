import { bigint, boolean, integer, jsonb, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";

/**
 * The cloud copy of each device's catalog. Every table is keyed by person and device: a device
 * only ever writes its own rows, so devices never conflict. Columns mirror the local SQLite
 * catalog (`@memories/db-sqlite`). Accounts live in Better Auth's own tables. The DDL, with
 * foreign keys, is in `migrations.ts`.
 */

export const devices = pgTable(
  "cloud_devices",
  {
    userId: text("user_id").notNull(),
    id: text("id").notNull(),
    name: text("name").notNull(),
    platform: text("platform").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
  },
  (table) => [primaryKey({ columns: [table.userId, table.id] })],
);

const owner = {
  userId: text("user_id").notNull(),
  deviceId: text("device_id").notNull(),
};


export const drives = pgTable(
  "catalog_drives",
  {
    ...owner,
    id: text("id").notNull(),
    name: text("name").notNull(),
    kind: text("kind").notNull(),
    rootPath: text("root_path").notNull(),
    volumeId: text("volume_id").notNull(),
    online: boolean("online").notNull(),
  },
  (table) => [primaryKey({ columns: [table.userId, table.deviceId, table.id] })],
);

export const objects = pgTable(
  "catalog_objects",
  {
    ...owner,
    hash: text("hash").notNull(),
    size: bigint("size", { mode: "number" }).notNull(),
    mime: text("mime").notNull(),
  },
  (table) => [primaryKey({ columns: [table.userId, table.deviceId, table.hash] })],
);

export const files = pgTable(
  "catalog_files",
  {
    ...owner,
    id: text("id").notNull(),
    objectHash: text("object_hash").notNull(),
    name: text("name").notNull(),
    kind: text("kind").notNull(),
    takenAt: text("taken_at"),
    place: text("place"),
    inbox: boolean("inbox").notNull(),
    trashedAt: text("trashed_at"),
  },
  (table) => [primaryKey({ columns: [table.userId, table.deviceId, table.id] })],
);

export const replicas = pgTable(
  "catalog_replicas",
  {
    ...owner,
    driveId: text("drive_id").notNull(),
    relativePath: text("relative_path").notNull(),
    fileId: text("file_id").notNull(),
    status: text("status").notNull(),
    progress: integer("progress"),
    size: bigint("size", { mode: "number" }),
    modifiedAt: text("modified_at"),
    objectHash: text("object_hash"),
  },
  (table) => [primaryKey({ columns: [table.userId, table.deviceId, table.driveId, table.relativePath] })],
);

export const folders = pgTable(
  "catalog_folders",
  {
    ...owner,
    id: text("id").notNull(),
    name: text("name").notNull(),
    parentId: text("parent_id"),
  },
  (table) => [primaryKey({ columns: [table.userId, table.deviceId, table.id] })],
);

export const fileFolders = pgTable(
  "catalog_file_folders",
  {
    ...owner,
    fileId: text("file_id").notNull(),
    folderId: text("folder_id").notNull(),
  },
  (table) => [primaryKey({ columns: [table.userId, table.deviceId, table.fileId] })],
);

export const fileVersions = pgTable(
  "catalog_file_versions",
  {
    ...owner,
    fileId: text("file_id").notNull(),
    version: integer("version").notNull(),
    objectHash: text("object_hash").notNull(),
    size: bigint("size", { mode: "number" }).notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.userId, table.deviceId, table.fileId, table.version] })],
);

export const backupJobs = pgTable(
  "catalog_backup_jobs",
  {
    ...owner,
    id: text("id").notNull(),
    sourceDriveId: text("source_drive_id").notNull(),
    destDriveId: text("dest_drive_id").notNull(),
    sourceRelativePaths: jsonb("source_relative_paths").$type<string[]>().notNull(),
    lastRunAt: text("last_run_at"),
    auto: boolean("auto").notNull().default(false),
  },
  (table) => [primaryKey({ columns: [table.userId, table.deviceId, table.id] })],
);

/** Drives people connect from their own Google or Microsoft account. Tokens are sealed by the server. */
export const driveConnections = pgTable(
  "drive_connections",
  {
    userId: text("user_id").notNull(),
    id: text("id").notNull(),
    provider: text("provider").notNull(),
    accountId: text("account_id").notNull(),
    label: text("label").notNull(),
    email: text("email"),
    status: text("status").notNull(),
    rootId: text("root_id").notNull(),
    sealedTokens: text("sealed_tokens").notNull(),
    connectedAt: timestamp("connected_at", { withTimezone: true, mode: "string" }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.userId, table.id] })],
);
