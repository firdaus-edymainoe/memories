import { isValidKey, type ObjectListing, ObjectStorage, type StoredObject } from "./object-storage.js";

/** A short-lived OAuth access token for someone's own drive. */
export type AccessToken = { value: string; expiresAt: Date };

/**
 * Hands out access tokens for one connected drive and refreshes them when they run out. The
 * cloud server implements it on top of the refresh token it keeps sealed in the database.
 */
export interface AccessTokenSource {
  token(): Promise<AccessToken>;
  /** The provider refused the last token: the next `token()` must fetch a fresh one. */
  expire(): void;
}

/** The drive's API said no. `status` is the HTTP status, 0 when it could not be reached. */
export class DriveApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly reason: string | null = null,
  ) {
    super(message);
    this.name = "DriveApiError";
  }
}

/** One file or folder in a personal drive, as the adapters see it. */
export type DriveItem = {
  id: string;
  name: string;
  folder: boolean;
  size: number;
  lastModified: string;
  contentType: string | null;
  metadata: Record<string, string>;
};

/**
 * Authorized JSON calls to a drive API. Adds the bearer token, and when the provider rejects it
 * (401) gets a fresh one and tries once more.
 */
export class DriveHttp {
  constructor(
    private readonly tokens: AccessTokenSource,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly name = "the drive",
  ) {}

  async send(url: string, init: RequestInit = {}, retried = false): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${(await this.tokens.token()).value}`);
    let response: Response;
    try {
      response = await this.fetchImpl(url, { ...init, headers });
    } catch {
      throw new DriveApiError(`Can't reach ${this.name}. Check your internet connection.`, 0);
    }
    if (response.status === 401 && !retried) {
      this.tokens.expire();
      return this.send(url, init, true);
    }
    return response;
  }

  /** Sends the request and reads JSON. `allow` lists statuses that come back as `null`. */
  async json<T>(url: string, init: RequestInit & { json?: unknown } = {}, allow: number[] = []): Promise<T | null> {
    const { json, ...rest } = init;
    const headers = new Headers(rest.headers);
    if (json !== undefined) headers.set("content-type", "application/json");
    const response = await this.send(url, { ...rest, headers, ...(json !== undefined ? { body: JSON.stringify(json) } : {}) });
    if (allow.includes(response.status)) return null;
    await this.check(response);
    const text = await response.text();
    return (text ? JSON.parse(text) : {}) as T;
  }

  async check(response: Response) {
    if (response.ok) return;
    let reason: string | null = null;
    let message = `${this.name} refused the request (${response.status})`;
    try {
      const body = (await response.clone().json()) as { error?: { message?: string; code?: string; errors?: Array<{ reason?: string }> } };
      message = body.error?.message || message;
      reason = body.error?.code ?? body.error?.errors?.[0]?.reason ?? null;
    } catch {
      // Not JSON: keep the generic message.
    }
    throw new DriveApiError(message, response.status, reason);
  }
}

/**
 * `ObjectStorage` on top of a drive that has real folders (Google Drive, OneDrive). Object keys
 * are paths below the app's own folder: `a/b/photo.jpg` is the file `photo.jpg` in folder `b`
 * in folder `a`. Folders are made as needed and are never objects themselves.
 *
 * Subclasses only say how to find an item and list a folder; listing by prefix, with or without
 * a delimiter, is the same for every drive.
 */
export abstract class DriveObjectStorage extends ObjectStorage {
  /** The item at `path` (folder names, then the item's name), or null. */
  protected abstract item(path: string[]): Promise<DriveItem | null>;
  /** What is directly inside the folder at `path`, or `[]` if there is no such folder. */
  protected abstract children(path: string[]): Promise<DriveItem[]>;

  protected segments(key: string) {
    return this.checkKey(key).split("/");
  }

  protected toObject(key: string, item: DriveItem): StoredObject {
    return { key, size: item.size, lastModified: item.lastModified, contentType: item.contentType, metadata: item.metadata };
  }

  async head(key: string) {
    if (this.checkKey(key).endsWith("/")) return null;
    const item = await this.item(this.segments(key));
    return item && !item.folder ? this.toObject(key, item) : null;
  }

  async list(prefix: string, options: { delimiter?: string } = {}): Promise<ObjectListing> {
    if (options.delimiter && options.delimiter !== "/") throw new Error("Drives only list with the / delimiter");
    if (prefix) this.checkKey(prefix);
    const cut = prefix.lastIndexOf("/");
    const folder = cut >= 0 ? prefix.slice(0, cut).split("/") : [];
    const start = prefix.slice(cut + 1);
    const listing: ObjectListing = { objects: [], prefixes: [] };
    await this.walk(folder, start, Boolean(options.delimiter), listing);
    listing.objects.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    listing.prefixes.sort();
    return listing;
  }

  private async walk(folder: string[], start: string, oneLevel: boolean, listing: ObjectListing) {
    const base = folder.length ? `${folder.join("/")}/` : "";
    for (const child of await this.children(folder)) {
      if (!child.name.startsWith(start) || !isPlainName(child.name)) continue;
      if (!child.folder) listing.objects.push(this.toObject(base + child.name, child));
      else if (oneLevel) listing.prefixes.push(`${base}${child.name}/`);
      else await this.walk([...folder, child.name], "", false, listing);
    }
  }
}

/** Names that can be one segment of a key. A drive can hold names our keys can't express. */
function isPlainName(name: string) {
  return !name.includes("/") && isValidKey(name);
}

const METADATA_PREFIX = "memories:";

/** Metadata kept in a text field the drive offers (OneDrive's description). */
export function encodeMetadata(metadata: Record<string, string>) {
  return Object.keys(metadata).length ? METADATA_PREFIX + JSON.stringify(lowerKeys(metadata)) : undefined;
}

export function decodeMetadata(text: string | null | undefined): Record<string, string> {
  if (!text?.startsWith(METADATA_PREFIX)) return {};
  try {
    const value = JSON.parse(text.slice(METADATA_PREFIX.length)) as unknown;
    if (!value || typeof value !== "object") return {};
    return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  } catch {
    return {};
  }
}

export function lowerKeys(record: Record<string, string> | undefined) {
  return Object.fromEntries(Object.entries(record ?? {}).map(([key, value]) => [key.toLowerCase(), value]));
}

/** Waits `ms` (copy jobs on OneDrive finish in the background). */
export const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
