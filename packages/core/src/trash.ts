import type { LibraryFile } from "./domain.js";
import type { Ports } from "./ports.js";
import { replicaHash } from "./use-cases.js";

/** Moves files to the Trash. They disappear from the library but nothing on disk changes. */
export async function trashFiles(ports: Ports, fileIds: string[]): Promise<number> {
  const at = new Date().toISOString();
  let moved = 0;
  for (const id of fileIds) {
    const file = await ports.catalog.getFile(id);
    if (!file || file.trashedAt) continue;
    await ports.catalog.upsertFile({ ...file, trashedAt: at });
    moved += 1;
  }
  return moved;
}

export async function restoreFiles(ports: Ports, fileIds: string[]): Promise<number> {
  let restored = 0;
  for (const id of fileIds) {
    const file = await ports.catalog.getFile(id);
    if (!file?.trashedAt) continue;
    await ports.catalog.upsertFile({ ...file, trashedAt: null });
    restored += 1;
  }
  return restored;
}

/** Most recently trashed first. */
export async function listTrash(ports: Ports): Promise<LibraryFile[]> {
  const files = await ports.catalog.listFiles({ trashed: true });
  return files.sort((a, b) => (b.trashedAt ?? "").localeCompare(a.trashedAt ?? ""));
}

export type DeleteResult = {
  /** Files removed from the library. */
  deleted: number;
  /** Copies removed from connected drives. */
  removed: number;
  /** Drives whose copies will be removed the next time they are plugged in. */
  waiting: string[];
};

/**
 * Deletes trashed files for good: every copy on every drive, including older versions. Copies on
 * drives that are not connected are removed the next time those drives are plugged in. Files that
 * are not in the Trash are left alone.
 */
export async function deleteForever(ports: Ports, fileIds: string[]): Promise<DeleteResult> {
  const result: DeleteResult = { deleted: 0, removed: 0, waiting: [] };
  const waiting = new Set<string>();

  for (const id of fileIds) {
    const file = await ports.catalog.getFile(id);
    if (!file?.trashedAt) continue;

    for (const replica of await ports.catalog.listReplicas(file.id)) {
      const drive = await ports.catalog.getDrive(replica.driveId);
      if (!drive) continue;
      const pending = { driveId: drive.id, relativePath: replica.relativePath, objectHash: replicaHash(replica, file) };
      if (!drive.online) {
        await ports.catalog.addPendingDeletion(pending);
        waiting.add(drive.name);
        continue;
      }
      try {
        if (await ports.fileIO.exists(drive.rootPath, replica.relativePath)) {
          await ports.fileIO.remove(drive.rootPath, replica.relativePath);
          result.removed += 1;
        }
      } catch {
        // The drive went away mid-way: finish the job when it comes back.
        await ports.catalog.addPendingDeletion(pending);
        waiting.add(drive.name);
      }
    }

    await ports.catalog.deleteFile(file.id);
    result.deleted += 1;
  }

  result.waiting = [...waiting].sort();
  return result;
}

export async function emptyTrash(ports: Ports): Promise<DeleteResult> {
  return deleteForever(
    ports,
    (await listTrash(ports)).map((file) => file.id),
  );
}
