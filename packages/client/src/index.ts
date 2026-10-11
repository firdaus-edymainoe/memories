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

/** Thrown when the local API can't be reached at all (not started yet, or stopped). */
export class OfflineError extends Error {
  constructor() {
    super("Memories isn’t responding");
    this.name = "OfflineError";
  }
}

/** The API answered with an error. `skipped` is set when a copy was skipped to avoid overwriting. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly skipped = false,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function parse<T>(response: Response | Promise<Response>): Promise<T> {
  let res: Response;
  try {
    res = await response;
  } catch {
    throw new OfflineError();
  }
  let body: (T & { error?: string; skipped?: boolean }) | null = null;
  try {
    body = (await res.json()) as T & { error?: string; skipped?: boolean };
  } catch {
    body = null;
  }
  if (!res.ok) throw new ApiError(body?.error || res.statusText || "Something went wrong", res.status, Boolean(body?.skipped));
  if (body === null) throw new ApiError("Something went wrong", res.status);
  return body;
}

type Bridge = { pickFolder?: () => Promise<string | null> };

export class MemoriesClient {
  constructor(private readonly baseUrl: string) {}

  /** Every change is sent as JSON: the API refuses anything else (CSRF protection). */
  private post(path: string, body: unknown = {}) {
    return fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  mediaUrl(fileId: string) {
    return `${this.baseUrl}/files/${fileId}/media`;
  }

  driveMediaUrl(driveId: string, relativePath: string) {
    const params = new URLSearchParams();
    params.set("path", relativePath);
    return `${this.baseUrl}/drives/${driveId}/media?${params.toString()}`;
  }

  /** The system folder picker: Electron's dialog in the desktop app, else the API's /pick-folder. */
  pickFolder(): Promise<string | null> {
    const bridge = (globalThis as { memoriesChrome?: Bridge }).memoriesChrome;
    if (bridge?.pickFolder) return bridge.pickFolder();
    return parse<{ rootPath: string | null }>(this.post("/pick-folder")).then((b) => b.rootPath);
  }

  health() {
    return parse<{ ok: boolean }>(fetch(`${this.baseUrl}/health`));
  }

  volumes() {
    return parse<{ volumes: VolumePresence[] }>(fetch(`${this.baseUrl}/volumes`)).then((b) => b.volumes);
  }

  volumeEntries(mountPath: string, relativePath = "") {
    const params = new URLSearchParams();
    params.set("mount", mountPath);
    if (relativePath) params.set("path", relativePath);
    return parse<{ entries: DirEntry[] }>(fetch(`${this.baseUrl}/volumes/entries?${params.toString()}`)).then(
      (b) => b.entries,
    );
  }

  drives() {
    return parse<{ drives: Drive[] }>(fetch(`${this.baseUrl}/drives`)).then((b) => b.drives);
  }

  registerDrive(input: { name: string; kind: DriveKind; rootPath: string; volumeId?: string }) {
    return parse<{ drive: Drive }>(
      this.post(`/drives`, input),
    ).then((b) => b.drive);
  }

  locateDrive(driveId: string, rootPath: string) {
    return parse<{ drive: Drive }>(this.post(`/drives/${driveId}/locate`, { rootPath })).then((b) => b.drive);
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
    return parse<{ file: LibraryFile }>(this.post(`/files/${id}/place`)).then((b) => b.file);
  }

  copyFile(id: string, input: { destDriveId: string; destRelativePath?: string }) {
    return parse<{ replica: { fileId: string; driveId: string; relativePath: string } }>(
      this.post(`/files/${id}/copy`, input),
    ).then((b) => b.replica);
  }

  relocateFile(id: string, input: { destDriveId: string; destRelativePath: string }) {
    return parse<{ replica: { fileId: string; driveId: string; relativePath: string } }>(
      this.post(`/files/${id}/relocate`, input),
    ).then((b) => b.replica);
  }

  moveToFolder(id: string, folderId: string | null) {
    return parse<{ ok: boolean }>(
      this.post(`/files/${id}/move`, { folderId }),
    );
  }

  events() {
    return parse<{ events: EventCluster[] }>(fetch(`${this.baseUrl}/events`)).then((b) => b.events);
  }

  ingest(driveId: string, relativePath?: string) {
    return parse<{ files: number; replicas: number }>(
      this.post(`/ingest`, { driveId, relativePath }),
    );
  }

  folders() {
    return parse<{ folders: VirtualFolder[] }>(fetch(`${this.baseUrl}/folders`)).then((b) => b.folders);
  }

  createFolder(name: string, parentId?: string | null) {
    return parse<{ folder: VirtualFolder }>(
      this.post(`/folders`, { name, parentId }),
    ).then((b) => b.folder);
  }

  backups() {
    return parse<{ jobs: BackupJob[] }>(fetch(`${this.baseUrl}/backups`)).then((b) => b.jobs);
  }

  saveBackup(input: { sourceDriveId: string; destDriveId: string; sourceRelativePaths: string[] }) {
    return parse<{ job: BackupJob }>(
      this.post(`/backups`, input),
    ).then((b) => b.job);
  }

  runBackup(id: string) {
    return parse<{ copied: number; skipped: number; conflicts?: string[] }>(this.post(`/backups/${id}/run`));
  }

  sync() {
    return parse<{ ok: boolean }>(this.post(`/sync`));
  }
}
