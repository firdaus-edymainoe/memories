import type { BackupJob, Drive, DriveKind, FileKind, LibraryFile, Replica, ReplicaStatus } from "@memories/core";
import type * as schema from "./schema.js";

/** Row → domain mappers, shared by the catalog and its change feed. */
export function toDrive(row: typeof schema.drives.$inferSelect): Drive {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind as DriveKind,
    rootPath: row.rootPath,
    volumeId: row.volumeId,
    online: row.online,
  };
}

export function toFile(row: typeof schema.files.$inferSelect): LibraryFile {
  return {
    id: row.id,
    objectHash: row.objectHash,
    name: row.name,
    kind: row.kind as FileKind,
    takenAt: row.takenAt,
    place: row.place,
    inbox: row.inbox,
    trashedAt: row.trashedAt,
  };
}

export function toReplica(row: typeof schema.replicas.$inferSelect): Replica {
  return {
    fileId: row.fileId,
    driveId: row.driveId,
    relativePath: row.relativePath,
    status: row.status as ReplicaStatus,
    progress: row.progress,
    size: row.size,
    modifiedAt: row.modifiedAt,
    objectHash: row.objectHash,
  };
}

export function toJob(row: typeof schema.backupJobs.$inferSelect): BackupJob {
  return {
    id: row.id,
    sourceDriveId: row.sourceDriveId,
    destDriveId: row.destDriveId,
    sourceRelativePaths: JSON.parse(row.sourceRelativePaths) as string[],
    lastRunAt: row.lastRunAt,
    auto: row.auto,
  };
}
