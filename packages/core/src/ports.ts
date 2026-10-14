import type {
  BackupJob,
  BackupRun,
  FileVersion,
  PendingDeletion,
  ContentObject,
  Drive,
  FileQuery,
  LibraryFile,
  Replica,
  VirtualFolder,
} from "./domain.js";
import type { FileKind } from "./domain.js";

export type FileStat = {
  relativePath: string;
  size: number;
  mime: string;
  kind: FileKind;
  takenAt: string | null;
  place: string | null;
  /** Last modification time (ISO 8601). Lets unchanged files skip re-hashing. */
  modifiedAt?: string;
};

export type CatalogPort = {
  listDrives(): Promise<Drive[]>;
  getDrive(id: string): Promise<Drive | null>;
  upsertDrive(drive: Drive): Promise<void>;
  setDriveOnline(id: string, online: boolean): Promise<void>;

  getObject(hash: string): Promise<ContentObject | null>;
  upsertObject(object: ContentObject): Promise<void>;

  listFiles(query?: FileQuery): Promise<LibraryFile[]>;
  getFile(id: string): Promise<LibraryFile | null>;
  getFileByHash(hash: string): Promise<LibraryFile | null>;
  upsertFile(file: LibraryFile): Promise<void>;
  /** Removes a file with its copies, versions and folder link from the catalog. */
  deleteFile(id: string): Promise<void>;

  listReplicas(fileId: string): Promise<Replica[]>;
  listReplicasOnDrive(driveId: string): Promise<Replica[]>;
  findReplica(driveId: string, relativePath: string): Promise<Replica | null>;
  upsertReplica(replica: Replica): Promise<void>;
  deleteReplica(driveId: string, relativePath: string): Promise<void>;

  listVirtualFolders(): Promise<VirtualFolder[]>;
  upsertVirtualFolder(folder: VirtualFolder): Promise<void>;
  listFileIdsInFolder(folderId: string): Promise<string[]>;
  setFileFolder(fileId: string, folderId: string | null): Promise<void>;

  listBackupJobs(): Promise<BackupJob[]>;
  getBackupJob(id: string): Promise<BackupJob | null>;
  upsertBackupJob(job: BackupJob): Promise<void>;

  listVersions(fileId: string): Promise<FileVersion[]>;
  addVersion(version: FileVersion): Promise<void>;

  upsertBackupRun(run: BackupRun): Promise<void>;
  /** Newest first. */
  listBackupRuns(limit: number): Promise<BackupRun[]>;

  addPendingDeletion(deletion: PendingDeletion): Promise<void>;
  listPendingDeletions(driveId: string): Promise<PendingDeletion[]>;
  removePendingDeletion(deletion: PendingDeletion): Promise<void>;
};

export type CopyArgs = {
  fromRoot: string;
  fromRelative: string;
  toRoot: string;
  toRelative: string;
  onProgress?: (ratio: number) => void;
};

export type DirEntry = {
  name: string;
  relativePath: string;
  directory: boolean;
  size: number;
  kind: FileKind | null;
};

/**
 * Thrown by `FileIO.copy` when the destination already exists. Copies never overwrite: a backup
 * must not be able to destroy a different file that happens to have the same name.
 */
export class DestinationExistsError extends Error {
  readonly code = "EEXIST";
  constructor(readonly relativePath: string) {
    super(`A file already exists at ${relativePath}`);
    this.name = "DestinationExistsError";
  }
}

export type FileIO = {
  walk(rootPath: string, subPath?: string): Promise<FileStat[]>;
  list(rootPath: string, subPath?: string): Promise<DirEntry[]>;
  hash(rootPath: string, relativePath: string): Promise<string>;
  read(rootPath: string, relativePath: string): Promise<Uint8Array>;
  exists(rootPath: string, relativePath: string): Promise<boolean>;
  mkdir(rootPath: string, relativePath: string): Promise<void>;
  /**
   * Copy one file. Must not overwrite: throw `DestinationExistsError` if `toRelative` exists.
   * Must not leave a partial file at `toRelative` if it fails part-way.
   */
  copy(args: CopyArgs): Promise<void>;
  remove(rootPath: string, relativePath: string): Promise<void>;
  /**
   * Optional: read details from the file's content, e.g. the capture date from a photo's EXIF.
   * Called only for files that are new to the library. Must not throw for unreadable files.
   */
  describe?(rootPath: string, relativePath: string): Promise<FileDetails>;
  /** Optional: byte size without reading the file. */
  size?(rootPath: string, relativePath: string): Promise<number>;
  /**
   * Optional: stream all or part of a file (inclusive byte range) instead of loading it into
   * memory. Lets large videos play and seek. Adapters that cannot do this fall back to `read`.
   */
  stream?(rootPath: string, relativePath: string, range?: ByteRange): Promise<ReadableStream<Uint8Array>>;
};

export type ByteRange = { start: number; end: number };

export type FileDetails = {
  /** When the photo or video was captured (ISO 8601), if the file records it. */
  takenAt?: string | null;
};

export type VolumePresence = {
  volumeId: string;
  mountPath: string;
  label: string;
};

export type Volumes = {
  list(): Promise<VolumePresence[]>;
  identify(rootPath: string): Promise<VolumePresence>;
};

export type Ports = {
  catalog: CatalogPort;
  fileIO: FileIO;
  volumes: Volumes;
};
