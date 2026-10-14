import { integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

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
  trashedAt: text("trashed_at"),
});

export const replicas = sqliteTable(
  "replicas",
  {
    fileId: text("file_id").notNull(),
    driveId: text("drive_id").notNull(),
    relativePath: text("relative_path").notNull(),
    status: text("status").notNull(),
    progress: integer("progress"),
    size: integer("size"),
    modifiedAt: text("modified_at"),
    objectHash: text("object_hash"),
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
  auto: integer("auto", { mode: "boolean" }).notNull().default(false),
});

export const fileVersions = sqliteTable(
  "file_versions",
  {
    fileId: text("file_id").notNull(),
    version: integer("version").notNull(),
    objectHash: text("object_hash").notNull(),
    size: integer("size").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.fileId, table.version] })],
);

export const backupRuns = sqliteTable("backup_runs", {
  id: text("id").primaryKey(),
  jobId: text("job_id").notNull(),
  trigger: text("trigger").notNull(),
  status: text("status").notNull(),
  startedAt: text("started_at").notNull(),
  finishedAt: text("finished_at"),
  copied: integer("copied").notNull(),
  skipped: integer("skipped").notNull(),
  failed: integer("failed").notNull(),
  error: text("error"),
});

export const pendingDeletions = sqliteTable(
  "pending_deletions",
  {
    driveId: text("drive_id").notNull(),
    relativePath: text("relative_path").notNull(),
    objectHash: text("object_hash"),
  },
  (table) => [primaryKey({ columns: [table.driveId, table.relativePath] })],
);
