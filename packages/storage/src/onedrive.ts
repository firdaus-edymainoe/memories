import {
  type AccessTokenSource,
  decodeMetadata,
  DriveApiError,
  DriveHttp,
  type DriveItem,
  DriveObjectStorage,
  encodeMetadata,
  pause,
} from "./drive-storage.js";
import {
  type DownloadOptions,
  ObjectExistsError,
  ObjectNotFoundError,
  type PresignedRequest,
  type UploadIntent,
} from "./object-storage.js";

export const GRAPH = "https://graph.microsoft.com/v1.0";
const SELECT = "id,name,size,lastModifiedDateTime,file,folder,description,parentReference";
/** Graph takes upload pieces of up to 60 MiB, in multiples of 320 KiB. This is 32 × 320 KiB. */
export const ONEDRIVE_CHUNK_BYTES = 32 * 320 * 1024;

type GraphItem = {
  id: string;
  name: string;
  size?: number;
  lastModifiedDateTime?: string;
  file?: { mimeType?: string };
  folder?: object;
  description?: string;
  parentReference?: { driveId?: string; id?: string };
  "@microsoft.graph.downloadUrl"?: string;
};

export type OneDriveStorageOptions = {
  tokens: AccessTokenSource;
  fetch?: typeof fetch;
  /** How long to wait for a copy to finish on OneDrive's side. */
  copyTimeoutMs?: number;
  /** Upload piece size; a multiple of 320 KiB. */
  chunkBytes?: number;
};

/**
 * Someone's own OneDrive (personal or work) as `ObjectStorage`, through Microsoft Graph. The app
 * only gets `Files.ReadWrite.AppFolder`: everything lives in OneDrive's `Apps/Memories` folder.
 *
 * - Items are addressed by path, so there are no folder ids to keep track of.
 * - Metadata (the SHA-256) is kept in the item's description. OneDrive for work accounts does not
 *   keep descriptions; the app then hashes the file itself when it needs to.
 * - Uploads use an upload session, a URL that needs no token, sent in pieces (`chunked`).
 *   Downloads use Graph's pre-authenticated download URL. Neither carries a token.
 * - `@microsoft.graph.conflictBehavior: fail` makes OneDrive refuse to overwrite.
 */
export class OneDriveStorage extends DriveObjectStorage {
  readonly provider = "onedrive";
  private readonly http: DriveHttp;
  private readonly tokens: AccessTokenSource;
  private readonly fetchImpl: typeof fetch;
  private readonly copyTimeoutMs: number;
  private readonly chunkBytes: number;

  constructor(options: OneDriveStorageOptions) {
    super();
    this.tokens = options.tokens;
    this.fetchImpl = options.fetch ?? fetch;
    this.http = new DriveHttp(options.tokens, this.fetchImpl, "OneDrive");
    this.copyTimeoutMs = options.copyTimeoutMs ?? 60_000;
    this.chunkBytes = options.chunkBytes ?? ONEDRIVE_CHUNK_BYTES;
  }

  /** The Graph address of the item at `path` inside the app folder. */
  private address(path: string[]) {
    const root = `${GRAPH}/me/drive/special/approot`;
    return path.length ? `${root}:/${path.map(encodeURIComponent).join("/")}:` : root;
  }

  private toItem(item: GraphItem): DriveItem {
    const folder = Boolean(item.folder);
    return {
      id: item.id,
      name: item.name,
      folder,
      size: item.size ?? 0,
      lastModified: item.lastModifiedDateTime ?? new Date(0).toISOString(),
      contentType: folder ? null : (item.file?.mimeType ?? null),
      metadata: decodeMetadata(item.description),
    };
  }

  private raw(path: string[]) {
    return this.http.json<GraphItem>(`${this.address(path)}?$select=${SELECT}`, {}, [404]);
  }

  protected async item(path: string[]) {
    const item = await this.raw(path);
    return item ? this.toItem(item) : null;
  }

  protected async children(path: string[]) {
    const items: DriveItem[] = [];
    let next: string | undefined = `${this.address(path)}/children?$select=${SELECT}&$top=200`;
    while (next) {
      const page: { value?: GraphItem[]; "@odata.nextLink"?: string } | null = await this.http.json(next, {}, [404]);
      if (!page) break;
      items.push(...(page.value ?? []).map((item) => this.toItem(item)));
      next = page["@odata.nextLink"];
    }
    return items;
  }

  /** Makes every folder in `path` that is missing and returns the last one. */
  private async ensureFolder(path: string[]): Promise<GraphItem> {
    let current = (await this.raw([]))!;
    for (let depth = 1; depth <= path.length; depth++) {
      const here = path.slice(0, depth);
      const found = await this.raw(here);
      if (found) {
        if (!found.folder) throw new ObjectExistsError(here.join("/"));
        current = found;
        continue;
      }
      const made = await this.http.json<GraphItem>(
        `${GRAPH}/me/drive/items/${encodeURIComponent(current.id)}/children?$select=${SELECT}`,
        { method: "POST", json: { name: here[depth - 1], folder: {}, "@microsoft.graph.conflictBehavior": "fail" } },
        [409],
      );
      // 409: made by someone else in the meantime, which is just as good.
      current = made ?? (await this.raw(here))!;
    }
    return current;
  }

  async copy(fromKey: string, toKey: string) {
    const source = await this.raw(this.segments(fromKey));
    if (!source || source.folder) throw new ObjectNotFoundError(fromKey);
    if (await this.head(toKey)) throw new ObjectExistsError(toKey);
    const path = this.segments(toKey);
    const parent = await this.ensureFolder(path.slice(0, -1));
    const response = await this.http.send(
      `${GRAPH}/me/drive/items/${encodeURIComponent(source.id)}/copy?@microsoft.graph.conflictBehavior=fail`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ parentReference: { driveId: parent.parentReference?.driveId ?? source.parentReference?.driveId, id: parent.id }, name: path[path.length - 1] }),
      },
    );
    if (response.status === 409) throw new ObjectExistsError(toKey);
    await this.http.check(response);
    const monitor = response.headers.get("location");
    if (monitor) await this.waitForCopy(monitor, toKey);
  }

  /** Copies run in the background on OneDrive. The monitor URL needs no token. */
  private async waitForCopy(monitor: string, toKey: string) {
    const deadline = Date.now() + this.copyTimeoutMs;
    let wait = 250;
    while (Date.now() < deadline) {
      let status: { status?: string; error?: { code?: string; message?: string } };
      try {
        const response = await this.fetchImpl(monitor);
        if (response.status === 303 || response.redirected) return;
        status = (await response.json()) as typeof status;
      } catch {
        throw new DriveApiError("Can't reach OneDrive. Check your internet connection.", 0);
      }
      if (status.status === "completed") return;
      if (status.status === "failed") {
        if (status.error?.code === "nameAlreadyExists") throw new ObjectExistsError(toKey);
        throw new DriveApiError(status.error?.message ?? "OneDrive could not copy the file", 502);
      }
      await pause(wait);
      wait = Math.min(wait * 2, 4000);
    }
    throw new DriveApiError("OneDrive is still copying the file. Try again in a moment.", 504);
  }

  async delete(key: string) {
    const item = await this.raw(this.segments(key));
    if (!item || item.folder) return;
    await this.http.json(`${GRAPH}/me/drive/items/${encodeURIComponent(item.id)}`, { method: "DELETE" }, [404]);
  }

  protected async signUpload(key: string, intent: UploadIntent, _expiresInSeconds: number): Promise<PresignedRequest> {
    const path = this.segments(key);
    const parent = await this.ensureFolder(path.slice(0, -1));
    const description = encodeMetadata(intent.metadata ?? {});
    const name = encodeURIComponent(path[path.length - 1]!);
    if (intent.size === 0) return this.signEmptyUpload(parent.id, name);
    const at = `${GRAPH}/me/drive/items/${encodeURIComponent(parent.id)}:/${name}:/createUploadSession`;
    const session = await this.http.json<{ uploadUrl: string; expirationDateTime?: string }>(
      at,
      {
        method: "POST",
        json: {
          item: {
            "@microsoft.graph.conflictBehavior": "fail",
            name: path[path.length - 1],
            ...(description ? { description } : {}),
          },
        },
      },
      [409],
    );
    // 409: the name was taken between our check and now.
    if (!session) throw new ObjectExistsError(key);
    return {
      method: "PUT",
      url: session.uploadUrl,
      headers: {},
      expiresAt: session.expirationDateTime ?? new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      chunked: { maxBytes: this.chunkBytes },
    };
  }

  /** Upload sessions can't take an empty file, so that one goes to `content` with a token. */
  private async signEmptyUpload(parentId: string, name: string): Promise<PresignedRequest> {
    const token = await this.tokens.token();
    return {
      method: "PUT",
      url: `${GRAPH}/me/drive/items/${encodeURIComponent(parentId)}:/${name}:/content?@microsoft.graph.conflictBehavior=fail`,
      headers: { authorization: `Bearer ${token.value}`, "content-length": "0" },
      expiresAt: token.expiresAt.toISOString(),
    };
  }

  protected async signDownload(key: string, _options: DownloadOptions, _expiresInSeconds: number): Promise<PresignedRequest> {
    const item = await this.http.json<GraphItem>(`${this.address(this.segments(key))}?$select=id,@microsoft.graph.downloadUrl`, {}, [404]);
    const url = item?.["@microsoft.graph.downloadUrl"];
    if (!url) throw new ObjectNotFoundError(key);
    // Graph's download URLs last about an hour; ask again well before that.
    return { method: "GET", url, headers: {}, expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString() };
  }
}
