import type {
  BackupJob,
  BackupRun,
  CloudAdminUser,
  CloudProvider,
  CloudRole,
  CloudStatus,
  CloudUser,
  DeleteResult,
  ExportResult,
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

/** Header carrying the per-launch secret that protects the local API. */
export const TOKEN_HEADER = "x-memories-token";

export class MemoriesClient {
  /**
   * @param token Per-launch secret from the desktop app. Sent on every call, and as a `token`
   * query parameter on media URLs (which the browser loads directly).
   */
  constructor(
    private readonly baseUrl: string,
    private readonly token: string | null = null,
  ) {}

  mediaUrl(fileId: string) {
    return this.withToken(`${this.baseUrl}/files/${fileId}/media`);
  }

  driveMediaUrl(driveId: string, relativePath: string) {
    const params = new URLSearchParams();
    params.set("path", relativePath);
    return this.withToken(`${this.baseUrl}/drives/${driveId}/media?${params.toString()}`);
  }

  /** A small preview for grids; falls back to the original when previews are unavailable. */
  thumbUrl(fileId: string) {
    return this.withToken(`${this.baseUrl}/files/${fileId}/thumb`);
  }

  driveThumbUrl(driveId: string, relativePath: string) {
    const params = new URLSearchParams();
    params.set("path", relativePath);
    return this.withToken(`${this.baseUrl}/drives/${driveId}/thumb?${params.toString()}`);
  }

  /** An older version of a file, read from whichever drive still holds it. */
  versionMediaUrl(fileId: string, objectHash: string) {
    return this.withToken(`${this.baseUrl}/files/${fileId}/versions/${objectHash}/media`);
  }

  private post<T>(path: string, body: unknown = {}) {
    return parse<T>(
      this.fetch(`${this.baseUrl}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
  }

  trash() {
    return parse<{ files: LibraryFile[] }>(this.fetch(`${this.baseUrl}/trash`)).then((b) => b.files);
  }

  moveToTrash(fileIds: string[]) {
    return this.post<{ moved: number }>("/trash", { fileIds }).then((b) => b.moved);
  }

  restoreFromTrash(fileIds: string[]) {
    return this.post<{ restored: number }>("/trash/restore", { fileIds }).then((b) => b.restored);
  }

  deleteForever(fileIds: string[]) {
    return this.post<DeleteResult>("/trash/delete", { fileIds });
  }

  emptyTrash() {
    return this.post<DeleteResult>("/trash/empty");
  }

  exportFiles(input: { fileIds: string[]; rootPath: string; objectHash?: string }) {
    return this.post<ExportResult>("/export", input);
  }

  setBackupAuto(id: string, auto: boolean) {
    return this.post<{ job: BackupJob }>(`/backups/${id}/auto`, { auto }).then((b) => b.job);
  }

  backupRuns(limit = 20) {
    return parse<{ runs: BackupRun[] }>(this.fetch(`${this.baseUrl}/backup-runs?limit=${limit}`)).then((b) => b.runs);
  }

  private withToken(url: string) {
    if (!this.token) return url;
    return `${url}${url.includes("?") ? "&" : "?"}token=${encodeURIComponent(this.token)}`;
  }

  private fetch(url: string, init: RequestInit = {}) {
    if (!this.token) return fetch(url, init);
    const headers = new Headers(init.headers);
    headers.set(TOKEN_HEADER, this.token);
    return fetch(url, { ...init, headers });
  }

  pickFolder() {
    return parse<{ rootPath: string | null }>(this.fetch(`${this.baseUrl}/pick-folder`, { method: "POST" })).then(
      (b) => b.rootPath,
    );
  }

  health() {
    return parse<{ ok: boolean }>(this.fetch(`${this.baseUrl}/health`));
  }

  volumes() {
    return parse<{ volumes: VolumePresence[] }>(this.fetch(`${this.baseUrl}/volumes`)).then((b) => b.volumes);
  }

  volumeEntries(mountPath: string, relativePath = "") {
    const params = new URLSearchParams();
    params.set("mount", mountPath);
    if (relativePath) params.set("path", relativePath);
    return parse<{ entries: DirEntry[] }>(this.fetch(`${this.baseUrl}/volumes/entries?${params.toString()}`)).then(
      (b) => b.entries,
    );
  }

  drives() {
    return parse<{ drives: Drive[] }>(this.fetch(`${this.baseUrl}/drives`)).then((b) => b.drives);
  }

  registerDrive(input: { name: string; kind: DriveKind; rootPath: string; volumeId?: string }) {
    return parse<{ drive: Drive }>(
      this.fetch(`${this.baseUrl}/drives`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      }),
    ).then((b) => b.drive);
  }

  driveFolders(driveId: string) {
    return parse<{ folders: string[] }>(this.fetch(`${this.baseUrl}/drives/${driveId}/folders`)).then((b) => b.folders);
  }

  driveEntries(driveId: string, relativePath = "") {
    const params = new URLSearchParams();
    if (relativePath) params.set("path", relativePath);
    const q = params.toString();
    return parse<{ entries: DirEntry[] }>(
      this.fetch(`${this.baseUrl}/drives/${driveId}/entries${q ? `?${q}` : ""}`),
    ).then((b) => b.entries);
  }

  files(query: { kind?: FileKind; inbox?: boolean } = {}) {
    const params = new URLSearchParams();
    if (query.kind) params.set("kind", query.kind);
    if (query.inbox !== undefined) params.set("inbox", String(query.inbox));
    const q = params.toString();
    return parse<{ files: LibraryFile[] }>(this.fetch(`${this.baseUrl}/files${q ? `?${q}` : ""}`)).then((b) => b.files);
  }

  file(id: string) {
    return parse<FileDetail>(this.fetch(`${this.baseUrl}/files/${id}`));
  }

  placeFile(id: string) {
    return parse<{ file: LibraryFile }>(this.fetch(`${this.baseUrl}/files/${id}/place`, { method: "POST" })).then((b) => b.file);
  }

  copyFile(id: string, input: { destDriveId: string; destRelativePath?: string }) {
    return parse<{ replica: { fileId: string; driveId: string; relativePath: string } }>(
      this.fetch(`${this.baseUrl}/files/${id}/copy`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      }),
    ).then((b) => b.replica);
  }

  relocateFile(id: string, input: { destDriveId: string; destRelativePath: string }) {
    return parse<{ replica: { fileId: string; driveId: string; relativePath: string } }>(
      this.fetch(`${this.baseUrl}/files/${id}/relocate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      }),
    ).then((b) => b.replica);
  }

  moveToFolder(id: string, folderId: string | null) {
    return parse<{ ok: boolean }>(
      this.fetch(`${this.baseUrl}/files/${id}/move`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ folderId }),
      }),
    );
  }

  events() {
    return parse<{ events: EventCluster[] }>(this.fetch(`${this.baseUrl}/events`)).then((b) => b.events);
  }

  ingest(driveId: string, relativePath?: string) {
    return parse<{ files: number; replicas: number }>(
      this.fetch(`${this.baseUrl}/ingest`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ driveId, relativePath }),
      }),
    );
  }

  folders() {
    return parse<{ folders: VirtualFolder[] }>(this.fetch(`${this.baseUrl}/folders`)).then((b) => b.folders);
  }

  createFolder(name: string, parentId?: string | null) {
    return parse<{ folder: VirtualFolder }>(
      this.fetch(`${this.baseUrl}/folders`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, parentId }),
      }),
    ).then((b) => b.folder);
  }

  backups() {
    return parse<{ jobs: BackupJob[] }>(this.fetch(`${this.baseUrl}/backups`)).then((b) => b.jobs);
  }

  saveBackup(input: { sourceDriveId: string; destDriveId: string; sourceRelativePaths: string[] }) {
    return parse<{ job: BackupJob }>(
      this.fetch(`${this.baseUrl}/backups`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      }),
    ).then((b) => b.job);
  }

  runBackup(id: string) {
    return parse<{ copied: number; skipped: number; failed: number }>(
      this.fetch(`${this.baseUrl}/backups/${id}/run`, { method: "POST" }),
    );
  }

  sync() {
    return parse<{ ok: boolean }>(this.fetch(`${this.baseUrl}/sync`, { method: "POST" }));
  }

  // Optional cloud mode. `cloudStatus().available` is false when the app is local only.

  cloudStatus() {
    return parse<{ status: CloudStatus }>(this.fetch(`${this.baseUrl}/cloud/status`)).then((b) => b.status);
  }

  cloudSignUp(input: { name: string; email: string; password: string }) {
    return this.post<{ user: CloudUser }>("/cloud/sign-up", input).then((b) => b.user);
  }

  cloudSignIn(input: { email: string; password: string }) {
    return this.post<{ user: CloudUser }>("/cloud/sign-in", input).then((b) => b.user);
  }

  /** Opens the system browser to sign in; the app hears back when it is done. */
  cloudSignInWith(provider: CloudProvider) {
    return this.post<{ url: string }>("/cloud/sign-in/provider", { provider });
  }

  cloudSignOut() {
    return this.post<{ ok: boolean }>("/cloud/sign-out");
  }

  cloudForgotPassword(email: string) {
    return this.post<{ ok: boolean }>("/cloud/forgot-password", { email });
  }

  cloudResendVerification() {
    return this.post<{ ok: boolean }>("/cloud/verify-email");
  }

  cloudRefresh() {
    return this.post<{ user: CloudUser | null }>("/cloud/refresh").then((b) => b.user);
  }

  cloudSetSync(enabled: boolean) {
    return this.post<{ status: CloudStatus }>("/cloud/sync/enabled", { enabled }).then((b) => b.status);
  }

  cloudSyncNow() {
    return this.post<{ status: CloudStatus }>("/cloud/sync/now").then((b) => b.status);
  }

  /** Adds cloud storage as a place. */
  cloudAddStorage() {
    return this.post<{ drive: Drive }>("/cloud/storage").then((b) => b.drive);
  }

  cloudUsers(search = "") {
    const q = search ? `?${new URLSearchParams({ search })}` : "";
    return parse<{ users: CloudAdminUser[]; total: number }>(this.fetch(`${this.baseUrl}/cloud/admin/users${q}`));
  }

  cloudSetRole(userId: string, role: CloudRole) {
    return this.post<{ ok: boolean }>(`/cloud/admin/users/${encodeURIComponent(userId)}/role`, { role });
  }

  cloudBan(userId: string, reason?: string) {
    return this.post<{ ok: boolean }>(`/cloud/admin/users/${encodeURIComponent(userId)}/ban`, reason ? { reason } : {});
  }

  cloudUnban(userId: string) {
    return this.post<{ ok: boolean }>(`/cloud/admin/users/${encodeURIComponent(userId)}/unban`);
  }

  cloudRemoveUser(userId: string) {
    return this.post<{ ok: boolean }>(`/cloud/admin/users/${encodeURIComponent(userId)}/remove`);
  }
}
