export type DriveKind = "computer" | "disk" | "usb" | "phone";
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
};

export type Replica = {
  fileId: string;
  driveId: string;
  relativePath: string;
  status: ReplicaStatus;
  progress: number | null;
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
};

export type EventCluster = {
  day: string;
  place: string | null;
  fileIds: string[];
};

export type FileQuery = {
  kind?: FileKind;
  inbox?: boolean;
};
