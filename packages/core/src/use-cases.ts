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
import { dayFromTakenAt, mimeFromName } from "./kind.js";
import { parentRelative, relativeInsideRoot } from "./paths.js";
import type { Ports } from "./ports.js";

function id(prefix: string) {
  return `${prefix}_${crypto.randomUUID()}`;
}

export async function registerDrive(
  ports: Ports,
  input: { name: string; kind: DriveKind; rootPath: string; volumeId?: string },
): Promise<Drive> {
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
    ? { ...existing, name: input.name, kind: input.kind, rootPath, volumeId: presence.volumeId, online }
    : {
        id: id("drv"),
        name: input.name,
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

export async function syncDrivePresence(ports: Ports): Promise<void> {
  const volumes = await ports.volumes.list();
  const present = new Set(volumes.map((volume) => volume.volumeId));
  for (const drive of await ports.catalog.listDrives()) {
    const volume = volumes.find(
      (item) =>
        item.volumeId === drive.volumeId ||
        (drive.kind === "phone" && phoneVolumeKey(item.volumeId) === phoneVolumeKey(drive.volumeId)),
    );
    const online = Boolean(volume) || present.has(drive.volumeId);
    await ports.catalog.setDriveOnline(drive.id, online);
  }
}

export async function ingestFolder(
  ports: Ports,
  input: { driveId: string; relativePath?: string },
): Promise<{ files: number; replicas: number }> {
  const drive = await ports.catalog.getDrive(input.driveId);
  if (!drive) throw new Error("Unknown drive");
  if (!drive.online) throw new Error("Drive is offline");

  const stats = await ports.fileIO.walk(drive.rootPath, input.relativePath ?? "");
  let files = 0;
  let replicas = 0;

  for (const stat of stats) {
    const relativePath = relativeInsideRoot(stat.relativePath);
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
    if (!existing) {
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

  return { files, replicas };
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
    throw new Error("Source and destination must be different drives");
  }
  const source = await ports.catalog.getDrive(input.sourceDriveId);
  const dest = await ports.catalog.getDrive(input.destDriveId);
  if (!source || !dest) throw new Error("Unknown drive");
  const sourceRelativePaths = pruneBackupPaths(input.sourceRelativePaths);
  if (!sourceRelativePaths.length) throw new Error("Choose a folder to copy");
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
  if (!job) throw new Error("Unknown backup job");
  const source = await ports.catalog.getDrive(job.sourceDriveId);
  const dest = await ports.catalog.getDrive(job.destDriveId);
  if (!source || !dest) throw new Error("Unknown drive");
  if (!source.online) throw new Error("Source drive is offline");
  if (!dest.online) throw new Error("Destination drive is offline");

  const folders = job.sourceRelativePaths.length > 0 ? job.sourceRelativePaths : [""];
  const seen = new Set<string>();
  let copied = 0;
  let skipped = 0;

  for (const folder of folders) {
    await ingestFolder(ports, { driveId: source.id, relativePath: folder });
    const stats = await ports.fileIO.walk(source.rootPath, folder);
    for (const stat of stats) {
      const fromRelative = relativeInsideRoot(stat.relativePath);
      if (seen.has(fromRelative)) continue;
      seen.add(fromRelative);

      const hash = await ports.fileIO.hash(source.rootPath, fromRelative);
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

  return { copied, skipped };
}

export async function listDrives(ports: Ports): Promise<Drive[]> {
  await syncDrivePresence(ports);
  return ports.catalog.listDrives();
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

async function readySource(ports: Ports, fileId: string) {
  const detail = await getFileDetail(ports, fileId);
  if (!detail) throw new Error("Unknown file");
  const ready = detail.replicas.find((row) => row.drive.online && row.replica.status === "ready");
  if (!ready) throw new Error("No connected copy");
  return ready;
}

export async function copyFileToDrive(
  ports: Ports,
  input: { fileId: string; destDriveId: string; destRelativePath?: string },
): Promise<Replica> {
  const dest = await ports.catalog.getDrive(input.destDriveId);
  if (!dest) throw new Error("Unknown drive");
  if (!dest.online) throw new Error("Destination drive is offline");
  const source = await readySource(ports, input.fileId);
  if (source.drive.id === dest.id) throw new Error("Copy needs a different drive");
  const toRelative = relativeInsideRoot(input.destRelativePath || source.replica.relativePath);
  const existing = (await ports.catalog.listReplicas(input.fileId)).find(
    (replica) => replica.driveId === dest.id && replica.status === "ready",
  );
  if (existing) return existing;

  const parent = parentRelative(toRelative);
  if (parent) await ports.fileIO.mkdir(dest.rootPath, parent);
  await ports.fileIO.copy({
    fromRoot: source.drive.rootPath,
    fromRelative: source.replica.relativePath,
    toRoot: dest.rootPath,
    toRelative,
  });
  const replica: Replica = {
    fileId: input.fileId,
    driveId: dest.id,
    relativePath: toRelative,
    status: "ready",
    progress: null,
  };
  await ports.catalog.upsertReplica(replica);
  return replica;
}

export async function relocateFile(
  ports: Ports,
  input: { fileId: string; destDriveId: string; destRelativePath: string },
): Promise<Replica> {
  const dest = await ports.catalog.getDrive(input.destDriveId);
  if (!dest) throw new Error("Unknown drive");
  if (!dest.online) throw new Error("Destination drive is offline");
  const destPath = relativeInsideRoot(input.destRelativePath);
  if (!destPath) throw new Error("Destination path required");
  const source = await readySource(ports, input.fileId);
  if (source.drive.id === dest.id && source.replica.relativePath === destPath) return source.replica;

  if (source.drive.id === dest.id) {
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
  if (!file) throw new Error("Unknown file");
  const next = { ...file, inbox: false };
  await ports.catalog.upsertFile(next);
  return next;
}

export async function createVirtualFolder(
  ports: Ports,
  input: { name: string; parentId?: string | null },
): Promise<VirtualFolder> {
  const folder: VirtualFolder = {
    id: id("fld"),
    name: input.name,
    parentId: input.parentId ?? null,
  };
  await ports.catalog.upsertVirtualFolder(folder);
  return folder;
}

export async function moveToFolder(ports: Ports, fileId: string, folderId: string | null): Promise<void> {
  if (!(await ports.catalog.getFile(fileId))) throw new Error("Unknown file");
  if (folderId && !(await ports.catalog.listVirtualFolders()).some((folder) => folder.id === folderId)) {
    throw new Error("Unknown folder");
  }
  await ports.catalog.setFileFolder(fileId, folderId);
}

export async function listDriveFolders(ports: Ports, driveId: string): Promise<string[]> {
  const drive = await ports.catalog.getDrive(driveId);
  if (!drive) throw new Error("Unknown drive");
  if (!drive.online) return [];
  const entries = await ports.fileIO.list(drive.rootPath, "");
  return entries.filter((entry) => entry.directory).map((entry) => entry.name);
}

export async function listDriveEntries(ports: Ports, driveId: string, relativePath = "") {
  const drive = await ports.catalog.getDrive(driveId);
  if (!drive) throw new Error("Unknown drive");
  if (!drive.online) throw new Error("Drive is offline");
  const rel = relativeInsideRoot(relativePath);
  return ports.fileIO.list(drive.rootPath, rel);
}

export async function listVolumeEntries(ports: Ports, mountPath: string, relativePath = "") {
  const volumes = await ports.volumes.list();
  const volume = volumes.find((item) => item.mountPath === mountPath);
  if (!volume) throw new Error("Unknown volume");
  const rel = relativeInsideRoot(relativePath);
  return ports.fileIO.list(volume.mountPath, rel);
}

export async function readOnlineBytes(
  ports: Ports,
  fileId: string,
): Promise<{ bytes: Uint8Array; mime: string; name: string } | null> {
  const detail = await getFileDetail(ports, fileId);
  if (!detail) return null;
  const ready = detail.replicas.find((row) => row.drive.online && row.replica.status === "ready");
  if (!ready) return null;
  const bytes = await ports.fileIO.read(ready.drive.rootPath, ready.replica.relativePath);
  return { bytes, mime: detail.object?.mime ?? "application/octet-stream", name: detail.file.name };
}

export async function readDriveBytes(
  ports: Ports,
  driveId: string,
  relativePath: string,
): Promise<{ bytes: Uint8Array; mime: string; name: string }> {
  const drive = await ports.catalog.getDrive(driveId);
  if (!drive) throw new Error("Unknown drive");
  if (!drive.online) throw new Error("Drive is offline");
  const rel = relativeInsideRoot(relativePath);
  if (!rel) throw new Error("Unknown file");
  const bytes = await ports.fileIO.read(drive.rootPath, rel);
  const slash = rel.lastIndexOf("/");
  const name = slash >= 0 ? rel.slice(slash + 1) : rel;
  return { bytes, mime: mimeFromName(name), name };
}
