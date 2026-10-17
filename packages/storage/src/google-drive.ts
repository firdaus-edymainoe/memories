import { type AccessTokenSource, DriveHttp, type DriveItem, DriveObjectStorage, lowerKeys } from "./drive-storage.js";
import {
  type DownloadOptions,
  ObjectExistsError,
  ObjectNotFoundError,
  type PresignedRequest,
  type UploadIntent,
} from "./object-storage.js";

const API = "https://www.googleapis.com/drive/v3";
const UPLOAD = "https://www.googleapis.com/upload/drive/v3";
export const GOOGLE_FOLDER = "application/vnd.google-apps.folder";
const FIELDS = "id,name,mimeType,size,modifiedTime,appProperties";

type GoogleFile = {
  id: string;
  name: string;
  mimeType: string;
  size?: string;
  modifiedTime?: string;
  appProperties?: Record<string, string>;
};

/** Text inside a Drive search query: `'` and `\` are escaped. */
export function quoteGoogle(value: string) {
  return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

export type GoogleDriveStorageOptions = {
  tokens: AccessTokenSource;
  /** The app's folder in the person's drive (made when they connected it). */
  rootFolderId: string;
  fetch?: typeof fetch;
};

/**
 * Someone's own Google Drive as `ObjectStorage`. Files live in a "Memories" folder the app made,
 * and the app only has the `drive.file` scope: it sees what it created and nothing else.
 *
 * - Metadata (the SHA-256) is kept in the file's private `appProperties`.
 * - Uploads use a resumable session; its URL needs no token, so the app sends bytes straight to
 *   Google. Downloads have no pre-signed form on Drive, so the signed GET carries a short-lived
 *   access token for this drive only.
 * - Delete moves the file to the person's trash, where they can still get it back.
 */
export class GoogleDriveStorage extends DriveObjectStorage {
  readonly provider = "google-drive";
  private readonly http: DriveHttp;
  private readonly tokens: AccessTokenSource;
  private readonly root: string;
  /** Folder ids by path, so walking to a file is one lookup per new folder, not per call. */
  private readonly folders = new Map<string, string>();

  constructor(options: GoogleDriveStorageOptions) {
    super();
    this.tokens = options.tokens;
    this.root = options.rootFolderId;
    this.http = new DriveHttp(options.tokens, options.fetch, "Google Drive");
  }

  private toItem(file: GoogleFile): DriveItem {
    const folder = file.mimeType === GOOGLE_FOLDER;
    return {
      id: file.id,
      name: file.name,
      folder,
      size: Number(file.size ?? 0),
      lastModified: file.modifiedTime ?? new Date(0).toISOString(),
      contentType: folder ? null : file.mimeType,
      metadata: lowerKeys(file.appProperties),
    };
  }

  private async search(query: string, pageSize = 1000): Promise<GoogleFile[]> {
    const found: GoogleFile[] = [];
    let pageToken: string | undefined;
    do {
      const params = new URLSearchParams({ q: query, fields: `nextPageToken,files(${FIELDS})`, pageSize: String(pageSize), spaces: "drive" });
      if (pageToken) params.set("pageToken", pageToken);
      const page = (await this.http.json<{ files?: GoogleFile[]; nextPageToken?: string }>(`${API}/files?${params}`))!;
      found.push(...(page.files ?? []));
      pageToken = page.nextPageToken;
    } while (pageToken);
    return found;
  }

  private async childNamed(parentId: string, name: string, folder?: boolean) {
    const kind = folder === undefined ? "" : folder ? ` and mimeType = '${GOOGLE_FOLDER}'` : ` and mimeType != '${GOOGLE_FOLDER}'`;
    const files = await this.search(`${quoteGoogle(parentId)} in parents and name = ${quoteGoogle(name)} and trashed = false${kind}`, 10);
    return files[0] ?? null;
  }

  /** The id of the folder at `path`; with `create`, makes the missing folders on the way. */
  private async folderId(path: string[], create: boolean): Promise<string | null> {
    let id = this.root;
    for (let depth = 1; depth <= path.length; depth++) {
      const key = path.slice(0, depth).join("/");
      const known = this.folders.get(key);
      if (known) {
        id = known;
        continue;
      }
      const name = path[depth - 1]!;
      const found = await this.childNamed(id, name, true);
      if (found) id = found.id;
      else if (!create) return null;
      else {
        const made = (await this.http.json<GoogleFile>(`${API}/files?fields=id`, {
          method: "POST",
          json: { name, mimeType: GOOGLE_FOLDER, parents: [id] },
        }))!;
        id = made.id;
      }
      this.folders.set(key, id);
    }
    return id;
  }

  protected async item(path: string[]) {
    const parent = await this.folderId(path.slice(0, -1), false);
    if (!parent) return null;
    const file = await this.childNamed(parent, path[path.length - 1]!);
    return file ? this.toItem(file) : null;
  }

  protected async children(path: string[]) {
    const id = await this.folderId(path, false);
    if (!id) return [];
    return (await this.search(`${quoteGoogle(id)} in parents and trashed = false`)).map((file) => this.toItem(file));
  }

  private async file(key: string) {
    const path = this.segments(key);
    const parent = await this.folderId(path.slice(0, -1), false);
    const file = parent ? await this.childNamed(parent, path[path.length - 1]!, false) : null;
    return file;
  }

  async copy(fromKey: string, toKey: string) {
    const source = await this.file(fromKey);
    if (!source) throw new ObjectNotFoundError(fromKey);
    if (await this.head(toKey)) throw new ObjectExistsError(toKey);
    const path = this.segments(toKey);
    const parent = (await this.folderId(path.slice(0, -1), true))!;
    await this.http.json(`${API}/files/${encodeURIComponent(source.id)}/copy?fields=id`, {
      method: "POST",
      json: { name: path[path.length - 1], parents: [parent], appProperties: source.appProperties ?? {} },
    });
  }

  async delete(key: string) {
    const file = await this.file(key);
    if (!file) return;
    await this.http.json(`${API}/files/${encodeURIComponent(file.id)}?fields=id`, { method: "PATCH", json: { trashed: true } }, [404]);
  }

  protected async signUpload(key: string, intent: UploadIntent, expiresInSeconds: number): Promise<PresignedRequest> {
    const path = this.segments(key);
    const parent = (await this.folderId(path.slice(0, -1), true))!;
    const response = await this.http.send(`${UPLOAD}/files?uploadType=resumable&fields=id`, {
      method: "POST",
      headers: {
        "content-type": "application/json; charset=UTF-8",
        "x-upload-content-type": intent.contentType,
        "x-upload-content-length": String(intent.size),
      },
      body: JSON.stringify({
        name: path[path.length - 1],
        parents: [parent],
        mimeType: intent.contentType,
        appProperties: lowerKeys(intent.metadata),
      }),
    });
    await this.http.check(response);
    const url = response.headers.get("location");
    if (!url) throw new Error("Google Drive did not start an upload");
    return {
      method: "PUT",
      url,
      headers: { "content-type": intent.contentType, "content-length": String(intent.size) },
      expiresAt: new Date(Date.now() + expiresInSeconds * 1000).toISOString(),
    };
  }

  protected async signDownload(key: string, _options: DownloadOptions, expiresInSeconds: number): Promise<PresignedRequest> {
    const file = await this.file(key);
    if (!file) throw new ObjectNotFoundError(key);
    const token = await this.tokens.token();
    const expiresAt = Math.min(Date.now() + expiresInSeconds * 1000, token.expiresAt.getTime());
    return {
      method: "GET",
      url: `${API}/files/${encodeURIComponent(file.id)}?alt=media`,
      headers: { authorization: `Bearer ${token.value}` },
      expiresAt: new Date(expiresAt).toISOString(),
    };
  }
}
