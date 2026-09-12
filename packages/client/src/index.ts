import type {
  BackupJob,
  DirEntry,
  Drive,
  DriveKind,
  EventCluster,
  FileDetail,
  FileKind,
  LibraryFile,
  VirtualFolder,
  VolumePresence,
} from "@memories/core";

async function parse<T>(response: Response | Promise<Response>): Promise<T> {
  const res = await response;
  const body = (await res.json()) as T & { error?: string };
  if (!res.ok) throw new Error(body.error || res.statusText);
  return body;
}

export class MemoriesClient {
  constructor(private readonly baseUrl: string) {}

  mediaUrl(fileId: string) {
    return `${this.baseUrl}/files/${fileId}/media`;
  }

  driveMediaUrl(driveId: string, relativePath: string) {
    const params = new URLSearchParams();
    params.set("path", relativePath);
    return `${this.baseUrl}/drives/${driveId}/media?${params.toString()}`;
  }

  pickFolder() {
    return parse<{ rootPath: string | null }>(fetch(`${this.baseUrl}/pick-folder`, { method: "POST" })).then(
      (b) => b.rootPath,
    );
  }

  health() {
    return parse<{ ok: boolean }>(fetch(`${this.baseUrl}/health`));
  }

  volumes() {
    return parse<{ volumes: VolumePresence[] }>(fetch(`${this.baseUrl}/volumes`)).then((b) => b.volumes);
  }

  drives() {
    return parse<{ drives: Drive[] }>(fetch(`${this.baseUrl}/drives`)).then((b) => b.drives);
  }

  registerDrive(input: { name: string; kind: DriveKind; rootPath: string; volumeId?: string }) {
    return parse<{ drive: Drive }>(
      fetch(`${this.baseUrl}/drives`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      }),
    ).then((b) => b.drive);
  }

  driveFolders(driveId: string) {
    return parse<{ folders: string[] }>(fetch(`${this.baseUrl}/drives/${driveId}/folders`)).then((b) => b.folders);
  }

  driveEntries(driveId: string, relativePath = "") {
    const params = new URLSearchParams();
    if (relativePath) params.set("path", relativePath);
    const q = params.toString();
    return parse<{ entries: DirEntry[] }>(
      fetch(`${this.baseUrl}/drives/${driveId}/entries${q ? `?${q}` : ""}`),
    ).then((b) => b.entries);
  }

  files(query: { kind?: FileKind; inbox?: boolean } = {}) {
    const params = new URLSearchParams();
    if (query.kind) params.set("kind", query.kind);
    if (query.inbox !== undefined) params.set("inbox", String(query.inbox));
    const q = params.toString();
    return parse<{ files: LibraryFile[] }>(fetch(`${this.baseUrl}/files${q ? `?${q}` : ""}`)).then((b) => b.files);
  }

  file(id: string) {
    return parse<FileDetail>(fetch(`${this.baseUrl}/files/${id}`));
  }

  placeFile(id: string) {
    return parse<{ file: LibraryFile }>(fetch(`${this.baseUrl}/files/${id}/place`, { method: "POST" })).then((b) => b.file);
  }

  events() {
    return parse<{ events: EventCluster[] }>(fetch(`${this.baseUrl}/events`)).then((b) => b.events);
  }

  ingest(driveId: string, relativePath?: string) {
    return parse<{ files: number; replicas: number }>(
      fetch(`${this.baseUrl}/ingest`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ driveId, relativePath }),
      }),
    );
  }

  folders() {
    return parse<{ folders: VirtualFolder[] }>(fetch(`${this.baseUrl}/folders`)).then((b) => b.folders);
  }

  createFolder(name: string, parentId?: string | null) {
    return parse<{ folder: VirtualFolder }>(
      fetch(`${this.baseUrl}/folders`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, parentId }),
      }),
    ).then((b) => b.folder);
  }

  backups() {
    return parse<{ jobs: BackupJob[] }>(fetch(`${this.baseUrl}/backups`)).then((b) => b.jobs);
  }

  saveBackup(input: { sourceDriveId: string; destDriveId: string; sourceRelativePaths: string[] }) {
    return parse<{ job: BackupJob }>(
      fetch(`${this.baseUrl}/backups`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      }),
    ).then((b) => b.job);
  }

  runBackup(id: string) {
    return parse<{ copied: number; skipped: number }>(fetch(`${this.baseUrl}/backups/${id}/run`, { method: "POST" }));
  }

  sync() {
    return parse<{ ok: boolean }>(fetch(`${this.baseUrl}/sync`, { method: "POST" }));
  }
}
