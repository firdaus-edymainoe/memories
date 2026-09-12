import type {
  BackupJob,
  ContentObject,
  Drive,
  FileQuery,
  LibraryFile,
  Replica,
  VirtualFolder,
} from "./domain.js";
import { kindFromName, mimeFromName } from "./kind.js";
import { relativeInsideRoot } from "./paths.js";
import type { CatalogPort, CopyArgs, DirEntry, FileIO, FileStat, VolumePresence, Volumes } from "./ports.js";

export class MemoryCatalog implements CatalogPort {
  drives = new Map<string, Drive>();
  objects = new Map<string, ContentObject>();
  files = new Map<string, LibraryFile>();
  replicas: Replica[] = [];
  folders = new Map<string, VirtualFolder>();
  fileFolders = new Map<string, string>();
  jobs = new Map<string, BackupJob>();

  async listDrives() {
    return [...this.drives.values()];
  }

  async getDrive(id: string) {
    return this.drives.get(id) ?? null;
  }

  async upsertDrive(drive: Drive) {
    this.drives.set(drive.id, { ...drive });
  }

  async setDriveOnline(id: string, online: boolean) {
    const drive = this.drives.get(id);
    if (drive) this.drives.set(id, { ...drive, online });
  }

  async getObject(hash: string) {
    return this.objects.get(hash) ?? null;
  }

  async upsertObject(object: ContentObject) {
    this.objects.set(object.hash, { ...object });
  }

  async listFiles(query?: FileQuery) {
    return [...this.files.values()].filter((file) => {
      if (query?.kind && file.kind !== query.kind) return false;
      if (query?.inbox !== undefined && file.inbox !== query.inbox) return false;
      return true;
    });
  }

  async getFile(id: string) {
    return this.files.get(id) ?? null;
  }

  async getFileByHash(hash: string) {
    return [...this.files.values()].find((file) => file.objectHash === hash) ?? null;
  }

  async upsertFile(file: LibraryFile) {
    this.files.set(file.id, { ...file });
  }

  async listReplicas(fileId: string) {
    return this.replicas.filter((replica) => replica.fileId === fileId);
  }

  async listReplicasOnDrive(driveId: string) {
    return this.replicas.filter((replica) => replica.driveId === driveId);
  }

  async findReplica(driveId: string, relativePath: string) {
    return (
      this.replicas.find(
        (replica) => replica.driveId === driveId && replica.relativePath === relativePath,
      ) ?? null
    );
  }

  async upsertReplica(replica: Replica) {
    const byFile = this.replicas.findIndex((row) => row.driveId === replica.driveId && row.fileId === replica.fileId);
    if (byFile >= 0) {
      this.replicas[byFile] = { ...replica };
      return;
    }
    const index = this.replicas.findIndex(
      (row) => row.driveId === replica.driveId && row.relativePath === replica.relativePath,
    );
    if (index >= 0) this.replicas[index] = { ...replica };
    else this.replicas.push({ ...replica });
  }

  async listVirtualFolders() {
    return [...this.folders.values()];
  }

  async upsertVirtualFolder(folder: VirtualFolder) {
    this.folders.set(folder.id, { ...folder });
  }

  async listFileIdsInFolder(folderId: string) {
    return [...this.fileFolders.entries()]
      .filter(([, id]) => id === folderId)
      .map(([fileId]) => fileId);
  }

  async setFileFolder(fileId: string, folderId: string | null) {
    if (folderId === null) this.fileFolders.delete(fileId);
    else this.fileFolders.set(fileId, folderId);
  }

  async listBackupJobs() {
    return [...this.jobs.values()];
  }

  async getBackupJob(id: string) {
    return this.jobs.get(id) ?? null;
  }

  async upsertBackupJob(job: BackupJob) {
    this.jobs.set(job.id, { ...job });
  }
}

type StoredBlob = {
  bytes: Uint8Array;
  mime: string;
  takenAt: string | null;
  place: string | null;
};

function key(rootPath: string, relativePath: string) {
  return `${rootPath}::${relativeInsideRoot(relativePath)}`;
}

function fnv1a(bytes: Uint8Array): string {
  let hash = 0x811c9dc5;
  for (const byte of bytes) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export class MemoryFileIO implements FileIO {
  private blobs = new Map<string, StoredBlob>();
  private dirs = new Set<string>();

  seed(
    rootPath: string,
    relativePath: string,
    content: string | Uint8Array,
    extra?: { takenAt?: string; place?: string; mime?: string },
  ) {
    const rel = relativeInsideRoot(relativePath);
    const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content;
    this.blobs.set(key(rootPath, rel), {
      bytes,
      mime: extra?.mime ?? mimeFromName(rel),
      takenAt: extra?.takenAt ?? null,
      place: extra?.place ?? null,
    });
    this.dirs.add(`${rootPath}::`);
  }

  async walk(rootPath: string, subPath = ""): Promise<FileStat[]> {
    const prefix = relativeInsideRoot(subPath);
    const out: FileStat[] = [];
    for (const [stored, blob] of this.blobs) {
      const [root, rel] = stored.split("::") as [string, string];
      if (root !== rootPath) continue;
      if (prefix && rel !== prefix && !rel.startsWith(`${prefix}/`)) continue;
      const name = rel.slice(rel.lastIndexOf("/") + 1);
      out.push({
        relativePath: rel,
        size: blob.bytes.byteLength,
        mime: blob.mime,
        kind: kindFromName(name),
        takenAt: blob.takenAt,
        place: blob.place,
      });
    }
    return out;
  }

  async list(rootPath: string, subPath = ""): Promise<DirEntry[]> {
    const prefix = relativeInsideRoot(subPath);
    const folders = new Set<string>();
    const files: DirEntry[] = [];
    for (const stored of this.blobs.keys()) {
      const [root, rel] = stored.split("::") as [string, string];
      if (root !== rootPath) continue;
      if (prefix) {
        if (rel === prefix || !rel.startsWith(`${prefix}/`)) continue;
        const rest = rel.slice(prefix.length + 1);
        const slash = rest.indexOf("/");
        if (slash < 0) {
          files.push({
            name: rest,
            relativePath: rel,
            directory: false,
            size: this.blobs.get(stored)!.bytes.byteLength,
            kind: kindFromName(rest),
          });
        } else {
          folders.add(rest.slice(0, slash));
        }
        continue;
      }
      const slash = rel.indexOf("/");
      if (slash < 0) {
        files.push({
          name: rel,
          relativePath: rel,
          directory: false,
          size: this.blobs.get(stored)!.bytes.byteLength,
          kind: kindFromName(rel),
        });
      } else {
        folders.add(rel.slice(0, slash));
      }
    }
    const dirs: DirEntry[] = [...folders].map((name) => ({
      name,
      relativePath: prefix ? `${prefix}/${name}` : name,
      directory: true,
      size: 0,
      kind: null,
    }));
    return [...dirs.sort((a, b) => a.name.localeCompare(b.name)), ...files.sort((a, b) => a.name.localeCompare(b.name))];
  }

  async hash(rootPath: string, relativePath: string) {
    const blob = this.require(rootPath, relativePath);
    return fnv1a(blob.bytes);
  }

  async read(rootPath: string, relativePath: string) {
    return this.require(rootPath, relativePath).bytes;
  }

  async exists(rootPath: string, relativePath: string) {
    return this.blobs.has(key(rootPath, relativePath));
  }

  async mkdir(rootPath: string, relativePath: string) {
    this.dirs.add(key(rootPath, relativePath));
  }

  async copy(args: CopyArgs) {
    const blob = this.require(args.fromRoot, args.fromRelative);
    this.blobs.set(key(args.toRoot, args.toRelative), {
      bytes: new Uint8Array(blob.bytes),
      mime: blob.mime,
      takenAt: blob.takenAt,
      place: blob.place,
    });
    args.onProgress?.(1);
  }

  private require(rootPath: string, relativePath: string): StoredBlob {
    const blob = this.blobs.get(key(rootPath, relativePath));
    if (!blob) throw new Error(`Missing file inside drive root: ${relativePath}`);
    return blob;
  }
}

export class MemoryVolumes implements Volumes {
  present: VolumePresence[] = [];

  connect(volume: VolumePresence) {
    this.present = this.present.filter((row) => row.volumeId !== volume.volumeId);
    this.present.push(volume);
  }

  disconnect(volumeId: string) {
    this.present = this.present.filter((row) => row.volumeId !== volumeId);
  }

  async list() {
    return [...this.present];
  }

  async identify(rootPath: string) {
    const match = this.present.find(
      (volume) =>
        rootPath === volume.mountPath ||
        rootPath.startsWith(`${volume.mountPath}/`) ||
        rootPath.startsWith(`${volume.mountPath}\\`),
    );
    if (match) return match;
    const volume = { volumeId: `mem:${rootPath}`, mountPath: rootPath, label: rootPath };
    this.present.push(volume);
    return volume;
  }
}
