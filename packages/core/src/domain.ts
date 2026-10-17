/** `cloud` is the person's cloud storage, offered only when they have signed in. */
export type DriveKind = "computer" | "disk" | "usb" | "phone" | "cloud";
export type FileKind = "photo" | "video" | "document";
export type ReplicaStatus = "ready" | "copying";

export type Drive = {
  id: string;
  name: string;
  kind: DriveKind;
  /** Folder the user registered. All work toward this drive stays inside it. */
  rootPath: string;
  /** Physical volume id — presence only (replug). */
  volumeId: string;
  online: boolean;
};

export type ContentObject = {
  hash: string;
  size: number;
  mime: string;
};

export type LibraryFile = {
  id: string;
  objectHash: string;
  name: string;
  kind: FileKind;
  takenAt: string | null;
  place: string | null;
  inbox: boolean;
  /** When it was moved to the Trash. Trashed files are hidden until restored or deleted. */
  trashedAt?: string | null;
};

/** One content of a library file over time. Version 1 is what was first found. */
export type FileVersion = {
  fileId: string;
  version: number;
  objectHash: string;
  size: number;
  createdAt: string;
};

export type Replica = {
  fileId: string;
  driveId: string;
  relativePath: string;
  status: ReplicaStatus;
  progress: number | null;
  /** Size and modification time when last seen, so unchanged files are not hashed again. */
  size?: number | null;
  modifiedAt?: string | null;
  /** Which content this copy holds. Empty on older records: the file's content when it was made. */
  objectHash?: string | null;
};

export type VirtualFolder = {
  id: string;
  name: string;
  parentId: string | null;
};

export type BackupJob = {
  id: string;
  sourceDriveId: string;
  /** Folders inside the source drive root. `""` is the drive root. */
  sourceRelativePaths: string[];
  destDriveId: string;
  lastRunAt: string | null;
  /** Run on its own whenever both places are connected. */
  auto?: boolean;
};

export type BackupRunStatus = "running" | "done" | "failed";

/** One run of a backup, kept as history. */
export type BackupRun = {
  id: string;
  jobId: string;
  trigger: "manual" | "auto";
  status: BackupRunStatus;
  startedAt: string;
  finishedAt: string | null;
  copied: number;
  skipped: number;
  failed: number;
  /** Why the run stopped, or the first file that could not be copied. */
  error: string | null;
};

/** A delete that waits for its drive to be plugged in. */
export type PendingDeletion = {
  driveId: string;
  relativePath: string;
  /** Only delete if the file there still has this content (it may have been replaced since). */
  objectHash: string | null;
};

export type EventCluster = {
  day: string;
  place: string | null;
  fileIds: string[];
};

export type FileQuery = {
  kind?: FileKind;
  inbox?: boolean;
  /** `true` lists only the Trash. By default trashed files are left out. */
  trashed?: boolean;
};
