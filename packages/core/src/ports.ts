import type {
  BackupJob,
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

export type FileIO = {
  walk(rootPath: string, subPath?: string): Promise<FileStat[]>;
  list(rootPath: string, subPath?: string): Promise<DirEntry[]>;
  hash(rootPath: string, relativePath: string): Promise<string>;
  read(rootPath: string, relativePath: string): Promise<Uint8Array>;
  exists(rootPath: string, relativePath: string): Promise<boolean>;
  mkdir(rootPath: string, relativePath: string): Promise<void>;
  copy(args: CopyArgs): Promise<void>;
  remove(rootPath: string, relativePath: string): Promise<void>;
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
