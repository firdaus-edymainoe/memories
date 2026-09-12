import { integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const drives = sqliteTable("drives", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  kind: text("kind").notNull(),
  rootPath: text("root_path").notNull(),
  volumeId: text("volume_id").notNull(),
  online: integer("online", { mode: "boolean" }).notNull(),
});

export const objects = sqliteTable("objects", {
  hash: text("hash").primaryKey(),
  size: integer("size").notNull(),
  mime: text("mime").notNull(),
});

export const files = sqliteTable("files", {
  id: text("id").primaryKey(),
  objectHash: text("object_hash").notNull(),
  name: text("name").notNull(),
  kind: text("kind").notNull(),
  takenAt: text("taken_at"),
  place: text("place"),
  inbox: integer("inbox", { mode: "boolean" }).notNull(),
});

export const replicas = sqliteTable(
  "replicas",
  {
    fileId: text("file_id").notNull(),
    driveId: text("drive_id").notNull(),
    relativePath: text("relative_path").notNull(),
    status: text("status").notNull(),
    progress: integer("progress"),
  },
  (table) => [uniqueIndex("replicas_drive_path").on(table.driveId, table.relativePath)],
);

export const virtualFolders = sqliteTable("virtual_folders", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  parentId: text("parent_id"),
});

export const fileFolders = sqliteTable("file_folders", {
  fileId: text("file_id").primaryKey(),
  folderId: text("folder_id").notNull(),
});

export const backupJobs = sqliteTable("backup_jobs", {
  id: text("id").primaryKey(),
  sourceDriveId: text("source_drive_id").notNull(),
  destDriveId: text("dest_drive_id").notNull(),
  sourceRelativePaths: text("source_relative_paths").notNull(),
  lastRunAt: text("last_run_at"),
});
