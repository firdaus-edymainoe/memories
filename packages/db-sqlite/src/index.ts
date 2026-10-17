import type {
  BackupJob,
  BackupRun,
  FileVersion,
  PendingDeletion,
  CatalogPort,
  ContentObject,
  Drive,
  FileQuery,
  LibraryFile,
  Replica,
  VirtualFolder,
} from "@memories/core";
import { and, desc, eq, isNotNull, isNull } from "drizzle-orm";
import { drizzle, type SqliteRemoteDatabase } from "drizzle-orm/sqlite-proxy";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type SQLInputValue, type StatementSync } from "node:sqlite";
import { ChangeFeed, installChangeTracking } from "./changes.js";
import { toDrive, toFile, toJob, toReplica } from "./rows.js";
import * as schema from "./schema.js";

const DDL = `
CREATE TABLE IF NOT EXISTS drives (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  root_path TEXT NOT NULL,
  volume_id TEXT NOT NULL,
  online INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS objects (
  hash TEXT PRIMARY KEY,
  size INTEGER NOT NULL,
  mime TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS files (
  id TEXT PRIMARY KEY,
  object_hash TEXT NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  taken_at TEXT,
  place TEXT,
  inbox INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS replicas (
  file_id TEXT NOT NULL,
  drive_id TEXT NOT NULL,
  relative_path TEXT NOT NULL,
  status TEXT NOT NULL,
  progress INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS replicas_drive_path ON replicas (drive_id, relative_path);
CREATE TABLE IF NOT EXISTS virtual_folders (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  parent_id TEXT
);
CREATE TABLE IF NOT EXISTS file_folders (
  file_id TEXT PRIMARY KEY,
  folder_id TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS backup_jobs (
  id TEXT PRIMARY KEY,
  source_drive_id TEXT NOT NULL,
  dest_drive_id TEXT NOT NULL,
  source_relative_paths TEXT NOT NULL,
  last_run_at TEXT
);
`;



/**
 * Changes to apply after the base schema, in order. `PRAGMA user_version` records how many have
 * run, so existing catalogs are upgraded in place. Append only — never edit a shipped step.
 */
const MIGRATIONS: ReadonlyArray<(sqlite: DatabaseSync) => void> = [
  // 1: remember size + modification time per replica so unchanged files skip re-hashing.
  (sqlite) => {
    const columns = sqlite.prepare("PRAGMA table_info(replicas)").all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === "size")) {
      sqlite.exec("ALTER TABLE replicas ADD COLUMN size INTEGER");
    }
    if (!columns.some((column) => column.name === "modified_at")) {
      sqlite.exec("ALTER TABLE replicas ADD COLUMN modified_at TEXT");
    }
  },
  // 2: trash, versions, backup history and automatic backups.
  (sqlite) => {
    addColumn(sqlite, "files", "trashed_at", "TEXT");
    addColumn(sqlite, "replicas", "object_hash", "TEXT");
    addColumn(sqlite, "backup_jobs", "auto", "INTEGER NOT NULL DEFAULT 0");
    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS file_versions (
        file_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        object_hash TEXT NOT NULL,
        size INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (file_id, version)
      );
      CREATE TABLE IF NOT EXISTS backup_runs (
        id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL,
        trigger TEXT NOT NULL,
        status TEXT NOT NULL,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        copied INTEGER NOT NULL,
        skipped INTEGER NOT NULL,
        failed INTEGER NOT NULL,
        error TEXT
      );
      CREATE INDEX IF NOT EXISTS backup_runs_started ON backup_runs (started_at);
      CREATE TABLE IF NOT EXISTS pending_deletions (
        drive_id TEXT NOT NULL,
        relative_path TEXT NOT NULL,
        object_hash TEXT,
        PRIMARY KEY (drive_id, relative_path)
      );
    `);
  },
  // 3: queue catalog changes for the optional cloud sync (off until the person turns it on).
  (sqlite) => installChangeTracking(sqlite),
];

function addColumn(sqlite: DatabaseSync, table: string, column: string, type: string) {
  const columns = sqlite.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!columns.some((row) => row.name === column)) sqlite.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
}

function migrate(sqlite: DatabaseSync) {
  sqlite.exec(DDL);
  const { user_version: current } = sqlite.prepare("PRAGMA user_version").get() as { user_version: number };
  for (let version = current; version < MIGRATIONS.length; version++) {
    sqlite.exec("BEGIN");
    try {
      MIGRATIONS[version]!(sqlite);
      sqlite.exec(`PRAGMA user_version = ${version + 1}`);
      sqlite.exec("COMMIT");
    } catch (error) {
      sqlite.exec("ROLLBACK");
      throw error;
    }
  }
}

/**
 * Drizzle on Node's built-in `node:sqlite` (through Drizzle's proxy driver). No native module, so
 * the same catalog runs under Node and inside Electron without rebuilding anything.
 */
function nodeSqliteDriver(sqlite: DatabaseSync) {
  const statements = new Map<string, StatementSync>();
  const prepare = (sql: string) => {
    let statement = statements.get(sql);
    if (!statement) {
      statement = sqlite.prepare(sql);
      statement.setReturnArrays(true);
      statements.set(sql, statement);
    }
    return statement;
  };

  return async (sql: string, params: unknown[], method: "run" | "all" | "values" | "get") => {
    const statement = prepare(sql);
    const values = params as SQLInputValue[];
    if (method === "run") {
      statement.run(...values);
      return { rows: [] };
    }
    if (method === "get") {
      return { rows: (statement.get(...values) as unknown as unknown[] | undefined) ?? [] };
    }
    return { rows: statement.all(...values) as unknown as unknown[][] };
  };
}

export class SqliteCatalog implements CatalogPort {
  private db: SqliteRemoteDatabase<typeof schema>;
  private sqlite: DatabaseSync;

  constructor(filename = ":memory:") {
    if (filename !== ":memory:") mkdirSync(dirname(filename), { recursive: true });
    this.sqlite = new DatabaseSync(filename);
    if (filename !== ":memory:") this.sqlite.exec("PRAGMA journal_mode = WAL");
    this.sqlite.exec("PRAGMA busy_timeout = 5000");
    migrate(this.sqlite);
    this.db = drizzle(nodeSqliteDriver(this.sqlite), { schema });
  }

  close() {
    this.sqlite.close();
  }

  /** Outgoing changes for cloud sync. Recording starts only when sync is turned on. */
  changes() {
    return new ChangeFeed(this.sqlite, this.db);
  }

  async listDrives() {
    return (await this.db.select().from(schema.drives)).map(toDrive);
  }

  async getDrive(id: string) {
    const [row] = await this.db.select().from(schema.drives).where(eq(schema.drives.id, id));
    return row ? toDrive(row) : null;
  }

  async upsertDrive(drive: Drive) {
    await this.db
      .insert(schema.drives)
      .values(drive)
      .onConflictDoUpdate({ target: schema.drives.id, set: drive });
  }

  async setDriveOnline(id: string, online: boolean) {
    await this.db.update(schema.drives).set({ online }).where(eq(schema.drives.id, id));
  }

  async getObject(hash: string) {
    const [row] = await this.db.select().from(schema.objects).where(eq(schema.objects.hash, hash));
    return row ?? null;
  }

  async upsertObject(object: ContentObject) {
    await this.db
      .insert(schema.objects)
      .values(object)
      .onConflictDoUpdate({ target: schema.objects.hash, set: object });
  }

  async listFiles(query?: FileQuery) {
    const rows = await this.db
      .select()
      .from(schema.files)
      .where(query?.trashed ? isNotNull(schema.files.trashedAt) : isNull(schema.files.trashedAt));
    return rows.map(toFile).filter((file) => {
      if (query?.kind && file.kind !== query.kind) return false;
      if (query?.inbox !== undefined && file.inbox !== query.inbox) return false;
      return true;
    });
  }

  async getFile(id: string) {
    const [row] = await this.db.select().from(schema.files).where(eq(schema.files.id, id));
    return row ? toFile(row) : null;
  }

  async getFileByHash(hash: string) {
    const [row] = await this.db.select().from(schema.files).where(eq(schema.files.objectHash, hash));
    return row ? toFile(row) : null;
  }

  async upsertFile(file: LibraryFile) {
    const row = { ...file, trashedAt: file.trashedAt ?? null };
    await this.db
      .insert(schema.files)
      .values(row)
      .onConflictDoUpdate({ target: schema.files.id, set: row });
  }

  async deleteFile(id: string) {
    await this.db.delete(schema.replicas).where(eq(schema.replicas.fileId, id));
    await this.db.delete(schema.fileVersions).where(eq(schema.fileVersions.fileId, id));
    await this.db.delete(schema.fileFolders).where(eq(schema.fileFolders.fileId, id));
    await this.db.delete(schema.files).where(eq(schema.files.id, id));
  }

  async listReplicas(fileId: string): Promise<Replica[]> {
    const rows = await this.db.select().from(schema.replicas).where(eq(schema.replicas.fileId, fileId));
    return rows.map(toReplica);
  }

  async listReplicasOnDrive(driveId: string): Promise<Replica[]> {
    const rows = await this.db.select().from(schema.replicas).where(eq(schema.replicas.driveId, driveId));
    return rows.map(toReplica);
  }

  async findReplica(driveId: string, relativePath: string) {
    const [row] = await this.db
      .select()
      .from(schema.replicas)
      .where(and(eq(schema.replicas.driveId, driveId), eq(schema.replicas.relativePath, relativePath)));
    return row ? toReplica(row) : null;
  }

  /** One copy per path on a drive; a drive may hold several versions of one file. */
  async upsertReplica(replica: Replica) {
    const row = {
      fileId: replica.fileId,
      driveId: replica.driveId,
      relativePath: replica.relativePath,
      status: replica.status,
      progress: replica.progress,
      size: replica.size ?? null,
      modifiedAt: replica.modifiedAt ?? null,
      objectHash: replica.objectHash ?? null,
    };
    await this.db
      .insert(schema.replicas)
      .values(row)
      .onConflictDoUpdate({ target: [schema.replicas.driveId, schema.replicas.relativePath], set: row });
  }

  async deleteReplica(driveId: string, relativePath: string) {
    await this.db
      .delete(schema.replicas)
      .where(and(eq(schema.replicas.driveId, driveId), eq(schema.replicas.relativePath, relativePath)));
  }

  async listVirtualFolders() {
    return (await this.db.select().from(schema.virtualFolders)).map(
      (row): VirtualFolder => ({ id: row.id, name: row.name, parentId: row.parentId }),
    );
  }

  async upsertVirtualFolder(folder: VirtualFolder) {
    await this.db
      .insert(schema.virtualFolders)
      .values(folder)
      .onConflictDoUpdate({ target: schema.virtualFolders.id, set: folder });
  }

  async listFileIdsInFolder(folderId: string) {
    const rows = await this.db.select().from(schema.fileFolders).where(eq(schema.fileFolders.folderId, folderId));
    return rows.map((row) => row.fileId);
  }

  async setFileFolder(fileId: string, folderId: string | null) {
    await this.db.delete(schema.fileFolders).where(eq(schema.fileFolders.fileId, fileId));
    if (folderId) await this.db.insert(schema.fileFolders).values({ fileId, folderId });
  }

  async listBackupJobs(): Promise<BackupJob[]> {
    return (await this.db.select().from(schema.backupJobs)).map(toJob);
  }

  async getBackupJob(id: string) {
    const [row] = await this.db.select().from(schema.backupJobs).where(eq(schema.backupJobs.id, id));
    return row ? toJob(row) : null;
  }

  async upsertBackupJob(job: BackupJob) {
    const row = {
      id: job.id,
      sourceDriveId: job.sourceDriveId,
      destDriveId: job.destDriveId,
      sourceRelativePaths: JSON.stringify(job.sourceRelativePaths),
      lastRunAt: job.lastRunAt,
      auto: job.auto ?? false,
    };
    await this.db
      .insert(schema.backupJobs)
      .values(row)
      .onConflictDoUpdate({ target: schema.backupJobs.id, set: row });
  }

  async listVersions(fileId: string): Promise<FileVersion[]> {
    return this.db
      .select()
      .from(schema.fileVersions)
      .where(eq(schema.fileVersions.fileId, fileId))
      .orderBy(desc(schema.fileVersions.version));
  }

  async addVersion(version: FileVersion) {
    await this.db.insert(schema.fileVersions).values(version).onConflictDoNothing();
  }

  async upsertBackupRun(run: BackupRun) {
    await this.db
      .insert(schema.backupRuns)
      .values(run)
      .onConflictDoUpdate({ target: schema.backupRuns.id, set: run });
  }

  async listBackupRuns(limit: number): Promise<BackupRun[]> {
    const rows = await this.db.select().from(schema.backupRuns).orderBy(desc(schema.backupRuns.startedAt)).limit(limit);
    return rows.map((row) => ({
      ...row,
      trigger: row.trigger as BackupRun["trigger"],
      status: row.status as BackupRun["status"],
    }));
  }

  async addPendingDeletion(deletion: PendingDeletion) {
    await this.db.insert(schema.pendingDeletions).values(deletion).onConflictDoNothing();
  }

  async listPendingDeletions(driveId: string): Promise<PendingDeletion[]> {
    return this.db.select().from(schema.pendingDeletions).where(eq(schema.pendingDeletions.driveId, driveId));
  }

  async removePendingDeletion(deletion: PendingDeletion) {
    await this.db
      .delete(schema.pendingDeletions)
      .where(
        and(
          eq(schema.pendingDeletions.driveId, deletion.driveId),
          eq(schema.pendingDeletions.relativePath, deletion.relativePath),
        ),
      );
  }
}
