import type {
  BackupRun,
  ContentObject,
  FileVersion,
  Drive,
  DriveKind,
  EventCluster,
  FileQuery,
  LibraryFile,
  Replica,
  VirtualFolder,
} from "./domain.js";
import { dayFromTakenAt, mimeFromName } from "./kind.js";
import { parentRelative, relativeInsideRoot, withCollisionSuffix } from "./paths.js";
import { type ByteRange, DestinationExistsError, type Ports } from "./ports.js";

function id(prefix: string) {
  return `${prefix}_${crypto.randomUUID()}`;
}

const MAX_NAME_ATTEMPTS = 1000;

function isExistsError(error: unknown) {
  return error instanceof DestinationExistsError || (error as { code?: string } | null)?.code === "EEXIST";
}

/**
 * Copy a file onto a drive without ever overwriting. If the target path already holds the same
 * content it is reused; otherwise the next free `name (n).ext` is taken (or, with
 * `keepName`, the copy is refused). The written copy is hashed and must match the original.
 */
async function copyVerified(
  ports: Ports,
  input: {
    fromRoot: string;
    fromRelative: string;
    toRoot: string;
    toRelative: string;
    hash: string;
    keepName?: boolean;
  },
): Promise<string> {
  const attempts = input.keepName ? 1 : MAX_NAME_ATTEMPTS;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const candidate = withCollisionSuffix(input.toRelative, attempt);
    if (await ports.fileIO.exists(input.toRoot, candidate)) {
      const existing = await ports.fileIO.hash(input.toRoot, candidate).catch(() => null);
      if (existing === input.hash) return candidate;
      continue;
    }

    const parent = parentRelative(candidate);
    if (parent) await ports.fileIO.mkdir(input.toRoot, parent);
    try {
      await ports.fileIO.copy({
        fromRoot: input.fromRoot,
        fromRelative: input.fromRelative,
        toRoot: input.toRoot,
        toRelative: candidate,
      });
    } catch (error) {
      if (isExistsError(error)) continue;
      throw error;
    }

    const written = await ports.fileIO.hash(input.toRoot, candidate);
    if (written !== input.hash) {
      await ports.fileIO.remove(input.toRoot, candidate).catch(() => undefined);
      throw new Error(`The copy of ${candidate} did not match the original`);
    }
    return candidate;
  }
  throw new DestinationExistsError(relativeInsideRoot(input.toRelative));
}

/** Which content a copy holds. Older records did not say: they hold the file's content. */
export function replicaHash(replica: Replica, file: LibraryFile) {
  return replica.objectHash ?? file.objectHash;
}

export { copyVerified as copyFileVerified };

/**
 * Applies deletes that waited for this drive to be plugged in. A file is only removed if it still
 * has the content that was deleted, in case something new was saved at the same path since.
 */
export async function flushPendingDeletions(ports: Ports, driveId: string): Promise<number> {
  const drive = await ports.catalog.getDrive(driveId);
  if (!drive?.online) return 0;
  let removed = 0;
  for (const pending of await ports.catalog.listPendingDeletions(driveId)) {
    try {
      if (await ports.fileIO.exists(drive.rootPath, pending.relativePath)) {
        const current = pending.objectHash ? await ports.fileIO.hash(drive.rootPath, pending.relativePath) : null;
        if (!pending.objectHash || current === pending.objectHash) {
          await ports.fileIO.remove(drive.rootPath, pending.relativePath);
          removed += 1;
        }
      }
      await ports.catalog.removePendingDeletion(pending);
    } catch {
      // Try again next time the drive is connected.
    }
  }
  return removed;
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
    if (online) await flushPendingDeletions(ports, drive.id);
  }
}

export async function ingestFolder(
  ports: Ports,
  input: { driveId: string; relativePath?: string },
): Promise<{ files: number; replicas: number; updated: number }> {
  const { files, replicas, updated } = await indexFolder(ports, input);
  return { files, replicas, updated };
}

/**
 * Records that a library file now has different content (it was edited where it lives). The
 * first time, the original content is kept as version 1.
 */
async function addFileVersion(
  ports: Ports,
  file: LibraryFile,
  hash: string,
  size: number,
  seenAt: string,
): Promise<LibraryFile> {
  const versions = await ports.catalog.listVersions(file.id);
  if (!versions.length) {
    const original = await ports.catalog.getObject(file.objectHash);
    await ports.catalog.addVersion({
      fileId: file.id,
      version: 1,
      objectHash: file.objectHash,
      size: original?.size ?? 0,
      createdAt: file.takenAt ?? seenAt,
    });
  }
  const latest = Math.max(1, ...versions.map((version) => version.version));
  await ports.catalog.addVersion({ fileId: file.id, version: latest + 1, objectHash: hash, size, createdAt: seenAt });
  const next = { ...file, objectHash: hash };
  await ports.catalog.upsertFile(next);
  return next;
}

/** Catalogues a folder and returns the hash of every file it could read, keyed by path. */
async function indexFolder(
  ports: Ports,
  input: { driveId: string; relativePath?: string },
): Promise<{ files: number; replicas: number; updated: number; hashes: Map<string, string> }> {
  const drive = await ports.catalog.getDrive(input.driveId);
  if (!drive) throw new Error("Unknown drive");
  if (!drive.online) throw new Error("Drive is offline");
  await flushPendingDeletions(ports, drive.id);

  const stats = await ports.fileIO.walk(drive.rootPath, input.relativePath ?? "");
  const hashes = new Map<string, string>();
  let files = 0;
  let replicas = 0;
  let updated = 0;

  for (const stat of stats) {
    const relativePath = relativeInsideRoot(stat.relativePath);
    const existing = await ports.catalog.findReplica(drive.id, relativePath);

    // Unchanged since the last scan (same size and modification time): reuse the known hash
    // instead of reading the whole file again.
    if (
      existing &&
      stat.modifiedAt !== undefined &&
      existing.size === stat.size &&
      existing.modifiedAt === stat.modifiedAt
    ) {
      const known = await ports.catalog.getFile(existing.fileId);
      if (known) {
        hashes.set(relativePath, replicaHash(existing, known));
        continue;
      }
    }

    let hash: string;
    try {
      hash = await ports.fileIO.hash(drive.rootPath, relativePath);
    } catch {
      continue;
    }
    hashes.set(relativePath, hash);
    await ports.catalog.upsertObject({
      hash,
      size: stat.size,
      mime: stat.mime,
    });

    let file = await ports.catalog.getFileByHash(hash);
    if (!file && existing) {
      // The same path now holds different content: it was edited, so it is a new version of the
      // same file rather than a new file.
      const previous = await ports.catalog.getFile(existing.fileId);
      if (previous && replicaHash(existing, previous) !== hash) {
        file = await addFileVersion(ports, previous, hash, stat.size, stat.modifiedAt ?? new Date().toISOString());
        updated += 1;
      }
    }
    if (!file) {
      // Prefer what the file says about itself (EXIF capture date) over the file system date.
      const details = await ports.fileIO.describe?.(drive.rootPath, relativePath).catch(() => null);
      file = {
        id: id("file"),
        objectHash: hash,
        name: relativePath.slice(relativePath.lastIndexOf("/") + 1) || relativePath,
        kind: stat.kind,
        takenAt: details?.takenAt ?? stat.takenAt,
        place: stat.place,
        inbox: true,
      };
      await ports.catalog.upsertFile(file);
      files += 1;
    }

    await ports.catalog.upsertReplica({
      fileId: file.id,
      driveId: drive.id,
      relativePath,
      status: "ready",
      progress: null,
      size: stat.size,
      modifiedAt: stat.modifiedAt ?? null,
      objectHash: hash,
    });
    if (!existing) replicas += 1;
  }

  return { files, replicas, updated, hashes };
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
  input: { sourceDriveId: string; destDriveId: string; sourceRelativePaths: string[]; auto?: boolean },
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
    auto: input.auto ?? false,
  };
  await ports.catalog.upsertBackupJob(job);
  return job;
}

/** Turns automatic backups on or off for a saved backup. */
export async function setBackupAuto(ports: Ports, jobId: string, auto: boolean) {
  const job = await ports.catalog.getBackupJob(jobId);
  if (!job) throw new Error("Unknown backup job");
  const next = { ...job, auto };
  await ports.catalog.upsertBackupJob(next);
  return next;
}

export async function listBackupRuns(ports: Ports, limit = 20): Promise<BackupRun[]> {
  return ports.catalog.listBackupRuns(limit);
}

/** Backups currently running in this process; a job never runs twice at once. */
const runningJobs = new Set<string>();

export function isBackupRunning(jobId: string) {
  return runningJobs.has(jobId);
}

/**
 * Copies new files from the source folders to the destination and records the run. A file that
 * cannot be copied is counted and the run carries on; only a missing drive stops it.
 */
export async function runBackupJob(
  ports: Ports,
  jobId: string,
  options: { trigger?: "manual" | "auto" } = {},
): Promise<{ copied: number; skipped: number; failed: number }> {
  const job = await ports.catalog.getBackupJob(jobId);
  if (!job) throw new Error("Unknown backup job");
  if (runningJobs.has(jobId)) throw new Error("This backup is already running");
  runningJobs.add(jobId);

  const run: BackupRun = {
    id: id("run"),
    jobId,
    trigger: options.trigger ?? "manual",
    status: "running",
    startedAt: new Date().toISOString(),
    finishedAt: null,
    copied: 0,
    skipped: 0,
    failed: 0,
    error: null,
  };
  await ports.catalog.upsertBackupRun(run);

  try {
    const source = await ports.catalog.getDrive(job.sourceDriveId);
    const dest = await ports.catalog.getDrive(job.destDriveId);
    if (!source || !dest) throw new Error("Unknown drive");
    if (!source.online) throw new Error("Source drive is offline");
    if (!dest.online) throw new Error("Destination drive is offline");
    await flushPendingDeletions(ports, dest.id);

    const folders = job.sourceRelativePaths.length > 0 ? job.sourceRelativePaths : [""];
    const seen = new Set<string>();

    for (const folder of folders) {
      // Indexing already hashed every readable file; reuse those hashes instead of reading again.
      const { hashes } = await indexFolder(ports, { driveId: source.id, relativePath: folder });
      for (const [fromRelative, hash] of hashes) {
        if (seen.has(fromRelative)) continue;
        seen.add(fromRelative);

        const file = await ports.catalog.getFileByHash(hash);
        if (!file) continue;

        // Skip only if the destination already holds this exact content (an older version of
        // the file on the destination does not count).
        const onDest = (await ports.catalog.listReplicas(file.id)).some(
          (replica) => replica.driveId === dest.id && replica.status === "ready" && replicaHash(replica, file) === hash,
        );
        if (onDest) {
          run.skipped += 1;
          continue;
        }

        try {
          const toRelative = await copyVerified(ports, {
            fromRoot: source.rootPath,
            fromRelative,
            toRoot: dest.rootPath,
            toRelative: fromRelative,
            hash,
          });
          await ports.catalog.upsertReplica({
            fileId: file.id,
            driveId: dest.id,
            relativePath: toRelative,
            status: "ready",
            progress: null,
            objectHash: hash,
          });
          run.copied += 1;
        } catch (error) {
          run.failed += 1;
          run.error ??= `${fromRelative}: ${error instanceof Error ? error.message : String(error)}`;
        }
      }
    }

    run.status = "done";
    await ports.catalog.upsertBackupJob({ ...job, lastRunAt: new Date().toISOString() });
    return { copied: run.copied, skipped: run.skipped, failed: run.failed };
  } catch (error) {
    run.status = "failed";
    run.error = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    run.finishedAt = new Date().toISOString();
    await ports.catalog.upsertBackupRun(run);
    runningJobs.delete(jobId);
  }
}

export async function listDrives(ports: Ports): Promise<Drive[]> {
  await syncDrivePresence(ports);
  return ports.catalog.listDrives();
}

export type FileDetail = {
  file: LibraryFile;
  object: ContentObject | null;
  /** Copies of the file as it is now. */
  replicas: Array<{ replica: Replica; drive: Drive }>;
  /** Newest first; empty until the file has been edited at least once. */
  versions: Array<FileVersion & { current: boolean; copies: Array<{ replica: Replica; drive: Drive }> }>;
};

export async function getFileDetail(ports: Ports, fileId: string): Promise<FileDetail | null> {
  const file = await ports.catalog.getFile(fileId);
  if (!file) return null;
  const object = await ports.catalog.getObject(file.objectHash);
  const drives = await ports.catalog.listDrives();
  const byId = new Map(drives.map((drive) => [drive.id, drive]));
  const copies = (await ports.catalog.listReplicas(fileId)).flatMap((replica) => {
    const drive = byId.get(replica.driveId);
    return drive ? [{ replica, drive }] : [];
  });
  const versions = await ports.catalog.listVersions(fileId);
  return {
    file,
    object: object ?? null,
    replicas: copies.filter((row) => replicaHash(row.replica, file) === file.objectHash),
    versions: versions.map((version) => ({
      ...version,
      current: version.objectHash === file.objectHash,
      copies: copies.filter((row) => replicaHash(row.replica, file) === version.objectHash),
    })),
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
  const file = await ports.catalog.getFile(input.fileId);
  if (!file) throw new Error("Unknown file");
  const existing = (await ports.catalog.listReplicas(input.fileId)).find(
    (replica) => replica.driveId === dest.id && replica.status === "ready" && replicaHash(replica, file) === file.objectHash,
  );
  if (existing) return existing;

  const written = await copyVerified(ports, {
    fromRoot: source.drive.rootPath,
    fromRelative: source.replica.relativePath,
    toRoot: dest.rootPath,
    toRelative,
    hash: file.objectHash,
  });
  const replica: Replica = {
    fileId: input.fileId,
    driveId: dest.id,
    relativePath: written,
    status: "ready",
    progress: null,
    objectHash: file.objectHash,
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
    const file = await ports.catalog.getFile(input.fileId);
    if (!file) throw new Error("Unknown file");
    // An explicit destination: refuse rather than rename or overwrite.
    await copyVerified(ports, {
      fromRoot: source.drive.rootPath,
      fromRelative: source.replica.relativePath,
      toRoot: dest.rootPath,
      toRelative: destPath,
      hash: file.objectHash,
      keepName: true,
    });
    const replica: Replica = {
      fileId: input.fileId,
      driveId: dest.id,
      relativePath: destPath,
      status: "ready",
      progress: null,
      objectHash: file.objectHash,
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

/** A file that can be read now, from whichever drive is connected. */
export type OpenedFile = {
  name: string;
  mime: string;
  size: number;
  /** Streams the whole file or an inclusive byte range. */
  open(range?: ByteRange): Promise<ReadableStream<Uint8Array>>;
};

function bytesToStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

async function openOnDrive(
  ports: Ports,
  rootPath: string,
  relativePath: string,
  name: string,
  mime: string,
): Promise<OpenedFile> {
  const { fileIO } = ports;
  if (fileIO.stream && fileIO.size) {
    const size = await fileIO.size(rootPath, relativePath);
    const stream = fileIO.stream.bind(fileIO);
    return { name, mime, size, open: (range) => stream(rootPath, relativePath, range) };
  }
  // Adapters without streaming (phones) are read once and sliced.
  const bytes = await fileIO.read(rootPath, relativePath);
  return {
    name,
    mime,
    size: bytes.byteLength,
    open: async (range) => bytesToStream(range ? bytes.subarray(range.start, range.end + 1) : bytes),
  };
}

export async function openOnlineFile(ports: Ports, fileId: string): Promise<OpenedFile | null> {
  const detail = await getFileDetail(ports, fileId);
  if (!detail) return null;
  const ready = detail.replicas.find((row) => row.drive.online && row.replica.status === "ready");
  if (!ready) return null;
  const mime = detail.object?.mime ?? "application/octet-stream";
  return openOnDrive(ports, ready.drive.rootPath, ready.replica.relativePath, detail.file.name, mime);
}

/** Reads one version of a file from whichever drive holds that version and is connected. */
export async function openVersionFile(ports: Ports, fileId: string, objectHash: string): Promise<OpenedFile | null> {
  const detail = await getFileDetail(ports, fileId);
  const version = detail?.versions.find((row) => row.objectHash === objectHash);
  if (!detail || !version) return null;
  const ready = version.copies.find((row) => row.drive.online && row.replica.status === "ready");
  if (!ready) return null;
  const mime = (await ports.catalog.getObject(objectHash))?.mime ?? "application/octet-stream";
  return openOnDrive(ports, ready.drive.rootPath, ready.replica.relativePath, detail.file.name, mime);
}

export async function openDriveFile(ports: Ports, driveId: string, relativePath: string): Promise<OpenedFile> {
  const drive = await ports.catalog.getDrive(driveId);
  if (!drive) throw new Error("Unknown drive");
  if (!drive.online) throw new Error("Drive is offline");
  const rel = relativeInsideRoot(relativePath);
  if (!rel) throw new Error("Unknown file");
  const slash = rel.lastIndexOf("/");
  const name = slash >= 0 ? rel.slice(slash + 1) : rel;
  return openOnDrive(ports, drive.rootPath, rel, name, mimeFromName(name));
}
