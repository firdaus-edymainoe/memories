import type {
  ContentObject,
  Drive,
  DriveKind,
  EventCluster,
  FileQuery,
  LibraryFile,
  Replica,
  VirtualFolder,
} from "./domain.js";
import { badRequest, conflict, isNotFound, MemoriesError, notFound } from "./errors.js";
import { dayFromTakenAt, mimeFromName } from "./kind.js";
import { isAbsoluteRoot, parentRelative, relativeInsideRoot } from "./paths.js";
import type { Ports, VolumePresence } from "./ports.js";

function id(prefix: string) {
  return `${prefix}_${crypto.randomUUID()}`;
}

const KINDS: DriveKind[] = ["computer", "disk", "usb", "phone"];

/** Shared checks for a folder the user wants Memories to use as a place. */
async function checkRoot(ports: Ports, kind: DriveKind, rootPath: string) {
  if (!isAbsoluteRoot(rootPath)) throw badRequest("Choose the full folder location, for example /Users/aisha/Pictures");
  if (kind !== "phone" && !(await ports.fileIO.exists(rootPath, ""))) {
    throw badRequest("That folder doesn’t exist. Check the location and try again.");
  }
}

export async function registerDrive(
  ports: Ports,
  input: { name: string; kind: DriveKind; rootPath: string; volumeId?: string },
): Promise<Drive> {
  if (typeof input.name !== "string" || !input.name.trim()) throw badRequest("Give this place a name");
  if (!KINDS.includes(input.kind)) throw badRequest("Choose what kind of place this is");
  if (typeof input.rootPath !== "string" || !input.rootPath.trim()) throw badRequest("Choose a folder");
  await checkRoot(ports, input.kind, input.rootPath);
  const presence = input.volumeId
    ? ((await ports.volumes.list()).find((volume) => volume.volumeId === input.volumeId) ??
      (await ports.volumes.identify(input.rootPath)))
    : await ports.volumes.identify(input.rootPath);
  const volumes = await ports.volumes.list();
  const online = volumes.some(
    (volume) =>
      volume.volumeId === presence.volumeId ||
      (input.kind === "phone" && phoneVolumeKey(volume.volumeId) === phoneVolumeKey(presence.volumeId)),
  );
  const rootPath = input.rootPath;
  const existing = (await ports.catalog.listDrives()).find((drive) => drive.rootPath === rootPath);
  const drive: Drive = existing
    ? { ...existing, name: input.name.trim(), kind: input.kind, rootPath, volumeId: presence.volumeId, online }
    : {
        id: id("drv"),
        name: input.name.trim(),
        kind: input.kind,
        rootPath,
        volumeId: presence.volumeId,
        online,
      };
  await ports.catalog.upsertDrive(drive);
  return drive;
}

function phoneVolumeKey(volumeId: string) {
  if (!volumeId.startsWith("mtp:")) return volumeId;
  return volumeId.split(":").slice(0, 3).join(":");
}

/**
 * Is this place usable right now? Its volume must be plugged in and, for folders on a computer or
 * drive, the folder itself must still exist (it may have been moved or renamed). Phones skip the
 * folder check: opening an MTP session on every poll is slow; a missing phone folder fails on browse.
 */
async function presenceOf(ports: Ports, drive: Drive, volumes: VolumePresence[]) {
  const volumePresent = volumes.some(
    (item) =>
      item.volumeId === drive.volumeId ||
      (drive.kind === "phone" && phoneVolumeKey(item.volumeId) === phoneVolumeKey(drive.volumeId)),
  );
  if (!volumePresent) return { online: false, missing: false };
  if (drive.kind === "phone") return { online: true, missing: false };
  const exists = await ports.fileIO.exists(drive.rootPath, "").catch(() => false);
  return { online: exists, missing: !exists };
}

export async function syncDrivePresence(ports: Ports): Promise<Map<string, { online: boolean; missing: boolean }>> {
  const volumes = await ports.volumes.list();
  const out = new Map<string, { online: boolean; missing: boolean }>();
  for (const drive of await ports.catalog.listDrives()) {
    const presence = await presenceOf(ports, drive, volumes);
    if (presence.online !== drive.online) await ports.catalog.setDriveOnline(drive.id, presence.online);
    out.set(drive.id, presence);
  }
  return out;
}

/** Re-check one drive just before using it, instead of trusting the last poll. */
export async function refreshDrive(ports: Ports, driveId: string): Promise<Drive> {
  const drive = await ports.catalog.getDrive(driveId);
  if (!drive) throw notFound("Unknown drive");
  const presence = await presenceOf(ports, drive, await ports.volumes.list());
  if (presence.online !== drive.online) await ports.catalog.setDriveOnline(drive.id, presence.online);
  return { ...drive, ...presence };
}

function offline(drive: Drive, role?: "Source" | "Destination") {
  if (drive.missing) return badRequest(`Can’t find the ${drive.name} folder. It may have been moved or renamed.`, { missing: true });
  return badRequest(role ? `${role} drive is offline` : "Drive is offline");
}

export async function ingestFolder(
  ports: Ports,
  input: { driveId: string; relativePath?: string },
): Promise<{ files: number; replicas: number; removed: number }> {
  const drive = await refreshDrive(ports, input.driveId);
  if (!drive.online) throw offline(drive);
  const sub = relativeInsideRoot(input.relativePath ?? "");
  if (sub && !(await ports.fileIO.exists(drive.rootPath, sub))) throw notFound("Can’t find that folder");

  const stats = await ports.fileIO.walk(drive.rootPath, sub);
  let files = 0;
  let replicas = 0;
  const onDisk = new Set<string>();
  const touched = new Set<string>();

  for (const stat of stats) {
    const relativePath = relativeInsideRoot(stat.relativePath);
    onDisk.add(relativePath);
    let hash: string;
    try {
      hash = await ports.fileIO.hash(drive.rootPath, relativePath);
    } catch {
      continue;
    }
    await ports.catalog.upsertObject({
      hash,
      size: stat.size,
      mime: stat.mime,
    });

    let file = await ports.catalog.getFileByHash(hash);
    if (!file) {
      file = {
        id: id("file"),
        objectHash: hash,
        name: relativePath.slice(relativePath.lastIndexOf("/") + 1) || relativePath,
        kind: stat.kind,
        takenAt: stat.takenAt,
        place: stat.place,
        inbox: true,
      };
      await ports.catalog.upsertFile(file);
      files += 1;
    }

    const existing = await ports.catalog.findReplica(drive.id, relativePath);
    if (!existing || existing.fileId !== file.id) {
      // New path, or the bytes at this path changed: point the path at the right file.
      if (existing) touched.add(existing.fileId);
      await ports.catalog.upsertReplica({
        fileId: file.id,
        driveId: drive.id,
        relativePath,
        status: "ready",
        progress: null,
      });
      replicas += 1;
    }
  }

  // Files that were deleted on disk drop out of this place.
  let removed = 0;
  for (const replica of await ports.catalog.listReplicasOnDrive(drive.id)) {
    const inside = !sub || replica.relativePath === sub || replica.relativePath.startsWith(`${sub}/`);
    if (!inside || onDisk.has(replica.relativePath) || replica.status !== "ready") continue;
    await ports.catalog.deleteReplica(drive.id, replica.relativePath);
    touched.add(replica.fileId);
    removed += 1;
  }
  // …and out of the catalog once no place has a copy left.
  for (const fileId of touched) {
    if (!(await ports.catalog.listReplicas(fileId)).length) await ports.catalog.deleteFile(fileId);
  }

  return { files, replicas, removed };
}

export async function listLibrary(ports: Ports, query?: FileQuery): Promise<LibraryFile[]> {
  const files = await ports.catalog.listFiles(query);
  return files.sort((a, b) => (b.takenAt ?? "").localeCompare(a.takenAt ?? "") || a.name.localeCompare(b.name));
}

export async function listEvents(ports: Ports): Promise<EventCluster[]> {
  const files = (await ports.catalog.listFiles()).filter(
    (file) => file.kind === "photo" || file.kind === "video",
  );
  const groups = new Map<string, EventCluster>();
  for (const file of files) {
    const day = dayFromTakenAt(file.takenAt);
    if (!day) continue;
    const key = `${day}::${file.place ?? ""}`;
    const cluster = groups.get(key) ?? { day, place: file.place, fileIds: [] };
    cluster.fileIds.push(file.id);
    groups.set(key, cluster);
  }
  return [...groups.values()].sort((a, b) => b.day.localeCompare(a.day) || (a.place ?? "").localeCompare(b.place ?? ""));
}

export function pruneBackupPaths(paths: string[]): string[] {
  const unique = [...new Set(paths.map((path) => relativeInsideRoot(path)))];
  unique.sort((a, b) => a.length - b.length || a.localeCompare(b));
  const kept: string[] = [];
  for (const path of unique) {
    if (kept.some((parent) => parent === "" || path === parent || path.startsWith(`${parent}/`))) continue;
    kept.push(path);
  }
  return kept;
}

export async function saveBackupJob(
  ports: Ports,
  input: { sourceDriveId: string; destDriveId: string; sourceRelativePaths: string[] },
) {
  if (input.sourceDriveId === input.destDriveId) {
    throw badRequest("Source and destination must be different drives");
  }
  const source = await ports.catalog.getDrive(input.sourceDriveId);
  const dest = await ports.catalog.getDrive(input.destDriveId);
  if (!source || !dest) throw notFound("Unknown drive");
  if (!Array.isArray(input.sourceRelativePaths) || input.sourceRelativePaths.some((path) => typeof path !== "string")) {
    throw badRequest("Choose a folder to copy");
  }
  const sourceRelativePaths = pruneBackupPaths(input.sourceRelativePaths);
  if (!sourceRelativePaths.length) throw badRequest("Choose a folder to copy");
  const job = {
    id: id("job"),
    sourceDriveId: input.sourceDriveId,
    sourceRelativePaths,
    destDriveId: input.destDriveId,
    lastRunAt: null,
  };
  await ports.catalog.upsertBackupJob(job);
  return job;
}

export async function runBackupJob(ports: Ports, jobId: string) {
  const job = await ports.catalog.getBackupJob(jobId);
  if (!job) throw notFound("Unknown backup job");
  const source = await refreshDrive(ports, job.sourceDriveId);
  const dest = await refreshDrive(ports, job.destDriveId);
  if (!source.online) throw offline(source, "Source");
  if (!dest.online) throw offline(dest, "Destination");

  const folders = job.sourceRelativePaths.length > 0 ? job.sourceRelativePaths : [""];
  // A chosen folder that has gone missing fails the whole run, before anything is copied.
  for (const folder of folders) {
    if (folder && !(await ports.fileIO.exists(source.rootPath, folder))) {
      throw notFound(`Can’t find “${folder}” on ${source.name}. It may have been moved or renamed.`, { folder });
    }
  }

  const seen = new Set<string>();
  let copied = 0;
  let skipped = 0;
  const conflicts: string[] = [];

  for (const folder of folders) {
    await ingestFolder(ports, { driveId: source.id, relativePath: folder });
    const stats = await ports.fileIO.walk(source.rootPath, folder);
    for (const stat of stats) {
      const fromRelative = relativeInsideRoot(stat.relativePath);
      if (seen.has(fromRelative)) continue;
      seen.add(fromRelative);

      let hash: string;
      try {
        hash = await ports.fileIO.hash(source.rootPath, fromRelative);
      } catch {
        continue;
      }
      const file = await ports.catalog.getFileByHash(hash);
      if (!file) continue;

      const destReplicas = (await ports.catalog.listReplicas(file.id)).filter(
        (replica) => replica.driveId === dest.id && replica.status === "ready",
      );
      if (destReplicas.length > 0) {
        skipped += 1;
        continue;
      }

      const toRelative = fromRelative;
      const clash = await destinationClash(ports, dest.rootPath, toRelative, hash);
      if (clash === "same") {
        await ports.catalog.upsertReplica({ fileId: file.id, driveId: dest.id, relativePath: toRelative, status: "ready", progress: null });
        skipped += 1;
        continue;
      }
      if (clash === "different") {
        conflicts.push(toRelative);
        skipped += 1;
        continue;
      }
      const parent = parentRelative(toRelative);
      if (parent) await ports.fileIO.mkdir(dest.rootPath, parent);
      await ports.fileIO.copy({
        fromRoot: source.rootPath,
        fromRelative,
        toRoot: dest.rootPath,
        toRelative,
      });
      await ports.catalog.upsertReplica({
        fileId: file.id,
        driveId: dest.id,
        relativePath: toRelative,
        status: "ready",
        progress: null,
      });
      copied += 1;
    }
  }

  await ports.catalog.upsertBackupJob({
    ...job,
    lastRunAt: new Date().toISOString(),
  });

  return { copied, skipped, conflicts };
}

/** Is something already at the destination path? Never overwrite a different file. */
async function destinationClash(ports: Ports, rootPath: string, relativePath: string, hash: string) {
  if (!(await ports.fileIO.exists(rootPath, relativePath))) return "free" as const;
  try {
    return (await ports.fileIO.hash(rootPath, relativePath)) === hash ? ("same" as const) : ("different" as const);
  } catch {
    return "different" as const;
  }
}

export async function listDrives(ports: Ports): Promise<Drive[]> {
  const presence = await syncDrivePresence(ports);
  return (await ports.catalog.listDrives()).map((drive) => ({ ...drive, missing: presence.get(drive.id)?.missing ?? false }));
}

/** Point a place whose folder moved at its new location, keeping its id, history and backups. */
export async function locateDrive(ports: Ports, driveId: string, rootPath: string): Promise<Drive> {
  const drive = await ports.catalog.getDrive(driveId);
  if (!drive) throw notFound("Unknown drive");
  if (drive.kind === "phone") throw badRequest("Phone folders can’t be relocated. Add the folder again instead.");
  if (typeof rootPath !== "string" || !rootPath.trim()) throw badRequest("Choose a folder");
  await checkRoot(ports, drive.kind, rootPath);
  const other = (await ports.catalog.listDrives()).find((row) => row.rootPath === rootPath && row.id !== drive.id);
  if (other) throw conflict(`That folder is already added as ${other.name}`);
  const presence = await ports.volumes.identify(rootPath);
  const next: Drive = { ...drive, rootPath, volumeId: presence.volumeId, online: true };
  await ports.catalog.upsertDrive(next);
  await ingestFolder(ports, { driveId: drive.id });
  return { ...next, missing: false };
}

export type FileDetail = {
  file: LibraryFile;
  object: ContentObject | null;
  replicas: Array<{ replica: Replica; drive: Drive }>;
};

export async function getFileDetail(ports: Ports, fileId: string): Promise<FileDetail | null> {
  const file = await ports.catalog.getFile(fileId);
  if (!file) return null;
  const object = await ports.catalog.getObject(file.objectHash);
  const replicas = await ports.catalog.listReplicas(fileId);
  const drives = await ports.catalog.listDrives();
  const byId = new Map(drives.map((drive) => [drive.id, drive]));
  return {
    file,
    object: object ?? null,
    replicas: replicas.flatMap((replica) => {
      const drive = byId.get(replica.driveId);
      return drive ? [{ replica, drive }] : [];
    }),
  };
}

/** A copy of the file we can read right now: on a connected place and still on disk. */
async function readySource(ports: Ports, fileId: string) {
  const detail = await getFileDetail(ports, fileId);
  if (!detail) throw notFound("Unknown file");
  const volumes = await ports.volumes.list();
  for (const row of detail.replicas) {
    if (row.replica.status !== "ready") continue;
    const presence = await presenceOf(ports, row.drive, volumes);
    if (!presence.online) continue;
    if (!(await ports.fileIO.exists(row.drive.rootPath, row.replica.relativePath))) continue;
    return { ...row, drive: { ...row.drive, ...presence } };
  }
  throw badRequest("No connected copy");
}

function leaf(path: string) {
  return path.slice(path.lastIndexOf("/") + 1);
}

export async function copyFileToDrive(
  ports: Ports,
  input: { fileId: string; destDriveId: string; destRelativePath?: string },
): Promise<Replica> {
  const dest = await refreshDrive(ports, input.destDriveId);
  if (!dest.online) throw offline(dest, "Destination");
  const source = await readySource(ports, input.fileId);
  if (source.drive.id === dest.id) throw badRequest("Copy needs a different drive");
  const toRelative = relativeInsideRoot(input.destRelativePath || source.replica.relativePath);
  const existing = (await ports.catalog.listReplicas(input.fileId)).find(
    (replica) => replica.driveId === dest.id && replica.status === "ready",
  );
  if (existing) return existing;

  const file = await ports.catalog.getFile(input.fileId);
  const replica: Replica = {
    fileId: input.fileId,
    driveId: dest.id,
    relativePath: toRelative,
    status: "ready",
    progress: null,
  };
  const clash = await destinationClash(ports, dest.rootPath, toRelative, file?.objectHash ?? "");
  if (clash === "same") {
    await ports.catalog.upsertReplica(replica);
    return replica;
  }
  if (clash === "different") {
    throw conflict(`Skipped: ${dest.name} already has a different file called “${leaf(toRelative)}”. Nothing was overwritten.`, {
      skipped: true,
      relativePath: toRelative,
    });
  }

  const parent = parentRelative(toRelative);
  if (parent) await ports.fileIO.mkdir(dest.rootPath, parent);
  await ports.fileIO.copy({
    fromRoot: source.drive.rootPath,
    fromRelative: source.replica.relativePath,
    toRoot: dest.rootPath,
    toRelative,
  });
  await ports.catalog.upsertReplica(replica);
  return replica;
}

export async function relocateFile(
  ports: Ports,
  input: { fileId: string; destDriveId: string; destRelativePath: string },
): Promise<Replica> {
  const dest = await refreshDrive(ports, input.destDriveId);
  if (!dest.online) throw offline(dest, "Destination");
  if (typeof input.destRelativePath !== "string") throw badRequest("Destination path required");
  const destPath = relativeInsideRoot(input.destRelativePath);
  if (!destPath) throw badRequest("Destination path required");
  const source = await readySource(ports, input.fileId);
  if (source.drive.id === dest.id && source.replica.relativePath === destPath) return source.replica;

  if (source.drive.id === dest.id) {
    if (await ports.fileIO.exists(dest.rootPath, destPath)) {
      throw conflict(`Skipped: there is already a file called “${leaf(destPath)}” there. Nothing was overwritten.`, {
        skipped: true,
        relativePath: destPath,
      });
    }
    const parent = parentRelative(destPath);
    if (parent) await ports.fileIO.mkdir(dest.rootPath, parent);
    await ports.fileIO.copy({
      fromRoot: source.drive.rootPath,
      fromRelative: source.replica.relativePath,
      toRoot: dest.rootPath,
      toRelative: destPath,
    });
    const replica: Replica = {
      fileId: input.fileId,
      driveId: dest.id,
      relativePath: destPath,
      status: "ready",
      progress: null,
    };
    await ports.catalog.upsertReplica(replica);
    await ports.fileIO.remove(source.drive.rootPath, source.replica.relativePath);
    await ports.catalog.deleteReplica(source.drive.id, source.replica.relativePath);
    return replica;
  }

  const copied = await copyFileToDrive(ports, {
    fileId: input.fileId,
    destDriveId: dest.id,
    destRelativePath: destPath,
  });
  await ports.fileIO.remove(source.drive.rootPath, source.replica.relativePath);
  await ports.catalog.deleteReplica(source.drive.id, source.replica.relativePath);
  return copied;
}

export async function placeFile(ports: Ports, fileId: string): Promise<LibraryFile> {
  const file = await ports.catalog.getFile(fileId);
  if (!file) throw notFound("Unknown file");
  const next = { ...file, inbox: false };
  await ports.catalog.upsertFile(next);
  return next;
}

export async function createVirtualFolder(
  ports: Ports,
  input: { name: string; parentId?: string | null },
): Promise<VirtualFolder> {
  if (typeof input.name !== "string" || !input.name.trim()) throw badRequest("Give the folder a name");
  if (input.parentId && !(await ports.catalog.listVirtualFolders()).some((folder) => folder.id === input.parentId)) {
    throw notFound("Unknown folder");
  }
  const folder: VirtualFolder = {
    id: id("fld"),
    name: input.name.trim(),
    parentId: input.parentId ?? null,
  };
  await ports.catalog.upsertVirtualFolder(folder);
  return folder;
}

export async function moveToFolder(ports: Ports, fileId: string, folderId: string | null): Promise<void> {
  if (!(await ports.catalog.getFile(fileId))) throw notFound("Unknown file");
  if (folderId && !(await ports.catalog.listVirtualFolders()).some((folder) => folder.id === folderId)) {
    throw notFound("Unknown folder");
  }
  await ports.catalog.setFileFolder(fileId, folderId);
}

export async function listDriveFolders(ports: Ports, driveId: string): Promise<string[]> {
  const drive = await ports.catalog.getDrive(driveId);
  if (!drive) throw notFound("Unknown drive");
  if (!drive.online) return [];
  const entries = await ports.fileIO.list(drive.rootPath, "");
  return entries.filter((entry) => entry.directory).map((entry) => entry.name);
}

export async function listDriveEntries(ports: Ports, driveId: string, relativePath = "") {
  const rel = relativeInsideRoot(relativePath);
  const drive = await refreshDrive(ports, driveId);
  if (!drive.online) throw offline(drive);
  return ports.fileIO.list(drive.rootPath, rel);
}

const PHONE_MOUNT = /^(mtp|adb):\/\//;

/**
 * Browse a volume before it is a place. Only phones: the system disk and other drives are chosen
 * through the folder picker, so the API never lists the computer outside places the user picked.
 */
export async function listVolumeEntries(ports: Ports, mountPath: string, relativePath = "") {
  const rel = relativeInsideRoot(relativePath);
  const volumes = await ports.volumes.list();
  const volume = volumes.find((item) => item.mountPath === mountPath);
  if (!volume) throw notFound("Unknown volume");
  if (!PHONE_MOUNT.test(volume.mountPath)) {
    throw new MemoriesError("Only phones can be browsed before they are added. Use Choose folder… instead.", 403);
  }
  return ports.fileIO.list(volume.mountPath, rel);
}

/**
 * Bytes of a library file from any connected copy. A copy that was deleted on disk is skipped and the
 * next one is tried. Null when no copy is on a connected place.
 */
export async function readOnlineBytes(
  ports: Ports,
  fileId: string,
): Promise<{ bytes: Uint8Array; mime: string; name: string } | null> {
  const detail = await getFileDetail(ports, fileId);
  if (!detail) throw notFound("Unknown file");
  const candidates = detail.replicas.filter((row) => row.drive.online && row.replica.status === "ready");
  if (!candidates.length) return null;
  for (const row of candidates) {
    try {
      const bytes = await ports.fileIO.read(row.drive.rootPath, row.replica.relativePath);
      return { bytes, mime: detail.object?.mime ?? "application/octet-stream", name: detail.file.name };
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
  }
  throw notFound("This file is no longer in any connected place");
}

export async function readDriveBytes(
  ports: Ports,
  driveId: string,
  relativePath: string,
): Promise<{ bytes: Uint8Array; mime: string; name: string }> {
  const rel = relativeInsideRoot(relativePath);
  const drive = await ports.catalog.getDrive(driveId);
  if (!drive) throw notFound("Unknown drive");
  if (!drive.online) throw offline(drive);
  if (!rel) throw notFound("Unknown file");
  const bytes = await ports.fileIO.read(drive.rootPath, rel);
  const slash = rel.lastIndexOf("/");
  const name = slash >= 0 ? rel.slice(slash + 1) : rel;
  return { bytes, mime: mimeFromName(name), name };
}
