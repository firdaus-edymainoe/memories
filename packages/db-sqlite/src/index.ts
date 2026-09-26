import type {
  BackupJob,
  CatalogPort,
  ContentObject,
  Drive,
  DriveKind,
  FileKind,
  FileQuery,
  LibraryFile,
  Replica,
  ReplicaStatus,
  VirtualFolder,
} from "@memories/core";
import Database from "better-sqlite3";
import { and, eq } from "drizzle-orm";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
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

function toDrive(row: typeof schema.drives.$inferSelect): Drive {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind as DriveKind,
    rootPath: row.rootPath,
    volumeId: row.volumeId,
    online: row.online,
  };
}

function toFile(row: typeof schema.files.$inferSelect): LibraryFile {
  return {
    id: row.id,
    objectHash: row.objectHash,
    name: row.name,
    kind: row.kind as FileKind,
    takenAt: row.takenAt,
    place: row.place,
    inbox: row.inbox,
  };
}

export class SqliteCatalog implements CatalogPort {
  private db: BetterSQLite3Database<typeof schema>;

  constructor(filename = ":memory:") {
    const sqlite = new Database(filename);
    sqlite.exec(DDL);
    this.db = drizzle(sqlite, { schema });
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
    const rows = await this.db.select().from(schema.files);
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
    await this.db
      .insert(schema.files)
      .values(file)
      .onConflictDoUpdate({ target: schema.files.id, set: file });
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

  async upsertReplica(replica: Replica) {
    const [byFile] = await this.db
      .select()
      .from(schema.replicas)
      .where(and(eq(schema.replicas.driveId, replica.driveId), eq(schema.replicas.fileId, replica.fileId)));
    if (byFile) {
      await this.db
        .update(schema.replicas)
        .set({
          relativePath: replica.relativePath,
          status: replica.status,
          progress: replica.progress,
        })
        .where(and(eq(schema.replicas.driveId, replica.driveId), eq(schema.replicas.fileId, replica.fileId)));
      return;
    }
    const existing = await this.findReplica(replica.driveId, replica.relativePath);
    if (existing) {
      await this.db
        .update(schema.replicas)
        .set({
          fileId: replica.fileId,
          status: replica.status,
          progress: replica.progress,
        })
        .where(
          and(eq(schema.replicas.driveId, replica.driveId), eq(schema.replicas.relativePath, replica.relativePath)),
        );
      return;
    }
    await this.db.insert(schema.replicas).values({
      fileId: replica.fileId,
      driveId: replica.driveId,
      relativePath: replica.relativePath,
      status: replica.status,
      progress: replica.progress,
    });
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
    };
    await this.db
      .insert(schema.backupJobs)
      .values(row)
      .onConflictDoUpdate({ target: schema.backupJobs.id, set: row });
  }
}

function toReplica(row: typeof schema.replicas.$inferSelect): Replica {
  return {
    fileId: row.fileId,
    driveId: row.driveId,
    relativePath: row.relativePath,
    status: row.status as ReplicaStatus,
    progress: row.progress,
  };
}

function toJob(row: typeof schema.backupJobs.$inferSelect): BackupJob {
  return {
    id: row.id,
    sourceDriveId: row.sourceDriveId,
    destDriveId: row.destDriveId,
    sourceRelativePaths: JSON.parse(row.sourceRelativePaths) as string[],
    lastRunAt: row.lastRunAt,
  };
}
