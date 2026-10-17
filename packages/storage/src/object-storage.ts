/** One stored object, as the provider reports it. */
export type StoredObject = {
  key: string;
  size: number;
  /** ISO 8601. */
  lastModified: string;
  contentType: string | null;
  /** User metadata (`x-amz-meta-*`), keys lower-case. */
  metadata: Record<string, string>;
};

export type ObjectListing = {
  objects: StoredObject[];
  /** "Folders" one level down, when listing with a delimiter. Each ends with the delimiter. */
  prefixes: string[];
};

/**
 * A request the client sends straight to the provider, so file bytes never pass through our
 * server. The client must send every header listed: they are part of the signature.
 */
export type PresignedRequest = {
  method: "GET" | "PUT";
  url: string;
  headers: Record<string, string>;
  expiresAt: string;
};

export type UploadIntent = {
  size: number;
  contentType: string;
  metadata?: Record<string, string>;
};

export type DownloadOptions = {
  /** Suggested file name when the object is saved. */
  fileName?: string;
  expiresInSeconds?: number;
};

export class ObjectExistsError extends Error {
  readonly code = "EEXIST";
  constructor(readonly key: string) {
    super(`An object already exists at ${key}`);
    this.name = "ObjectExistsError";
  }
}

export class ObjectNotFoundError extends Error {
  readonly code = "ENOENT";
  constructor(readonly key: string) {
    super(`No object at ${key}`);
    this.name = "ObjectNotFoundError";
  }
}

export class InvalidKeyError extends Error {
  constructor(readonly key: string) {
    super(`Not a valid object key: ${JSON.stringify(key)}`);
    this.name = "InvalidKeyError";
  }
}

const DEFAULT_EXPIRY_SECONDS = 15 * 60;

/**
 * Where cloud files live. The rest of the app depends on this class only, never on a provider,
 * so Backblaze B2 can be swapped for S3, R2, MinIO or anything else by changing configuration.
 *
 * Writes never overwrite: `presignUpload` and `copy` refuse a key that is already taken, the same
 * rule local copies follow.
 */
export abstract class ObjectStorage {
  /** Short provider name for logs and status, e.g. `backblaze-b2`. */
  abstract readonly provider: string;

  abstract head(key: string): Promise<StoredObject | null>;
  /** Every object under `prefix` (all pages). With a delimiter, only one level down. */
  abstract list(prefix: string, options?: { delimiter?: string }): Promise<ObjectListing>;
  abstract copy(fromKey: string, toKey: string): Promise<void>;
  abstract delete(key: string): Promise<void>;

  protected abstract signUpload(key: string, intent: UploadIntent, expiresInSeconds: number): Promise<PresignedRequest>;
  protected abstract signDownload(key: string, options: DownloadOptions, expiresInSeconds: number): Promise<PresignedRequest>;

  async exists(key: string) {
    return (await this.head(this.checkKey(key))) !== null;
  }

  /** A signed PUT for one new object. Throws `ObjectExistsError` if the key is taken. */
  async presignUpload(key: string, intent: UploadIntent, expiresInSeconds = DEFAULT_EXPIRY_SECONDS) {
    this.checkKey(key);
    if (!Number.isSafeInteger(intent.size) || intent.size < 0) throw new Error("Upload size must be a whole number of bytes");
    if (await this.head(key)) throw new ObjectExistsError(key);
    return this.signUpload(key, intent, expiresInSeconds);
  }

  /** A signed GET. Throws `ObjectNotFoundError` if nothing is there. */
  async presignDownload(key: string, options: DownloadOptions = {}) {
    this.checkKey(key);
    if (!(await this.head(key))) throw new ObjectNotFoundError(key);
    return this.signDownload(key, options, options.expiresInSeconds ?? DEFAULT_EXPIRY_SECONDS);
  }

  /** A view of this storage where every key is inside `prefix` (e.g. one user's space). */
  scoped(prefix: string): ObjectStorage {
    return new ScopedObjectStorage(this, prefix);
  }

  protected checkKey(key: string) {
    if (!isValidKey(key)) throw new InvalidKeyError(key);
    return key;
  }
}

/** Keys are `/`-separated relative paths: no empty, `.` or `..` segments, no control characters. */
export function isValidKey(key: string) {
  if (!key || key.length > 1024 || key.startsWith("/")) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f\\]/.test(key)) return false;
  return key.split("/").every((segment, index, all) => {
    if (segment === "") return index === all.length - 1 && all.length > 1; // a trailing "/" only
    return segment !== "." && segment !== "..";
  });
}

/**
 * Decorator that confines another storage to a prefix. Callers see keys relative to it and
 * cannot reach outside it.
 */
export class ScopedObjectStorage extends ObjectStorage {
  readonly provider: string;
  private readonly prefix: string;

  constructor(
    private readonly inner: ObjectStorage,
    prefix: string,
  ) {
    super();
    if (!prefix.endsWith("/") || !isValidKey(prefix)) throw new InvalidKeyError(prefix);
    this.prefix = prefix;
    this.provider = inner.provider;
  }

  private outer(key: string) {
    return this.prefix + this.checkKey(key);
  }

  private strip(key: string) {
    return key.startsWith(this.prefix) ? key.slice(this.prefix.length) : key;
  }

  async head(key: string) {
    const object = await this.inner.head(this.outer(key));
    return object ? { ...object, key: this.strip(object.key) } : null;
  }

  async list(prefix: string, options?: { delimiter?: string }) {
    if (prefix) this.checkKey(prefix);
    const listing = await this.inner.list(this.prefix + prefix, options);
    return {
      objects: listing.objects.map((object) => ({ ...object, key: this.strip(object.key) })),
      prefixes: listing.prefixes.map((value) => this.strip(value)),
    };
  }

  copy(fromKey: string, toKey: string) {
    return this.inner.copy(this.outer(fromKey), this.outer(toKey));
  }

  delete(key: string) {
    return this.inner.delete(this.outer(key));
  }

  // The inner storage runs its own checks, so these skip the base class's (one request, not two).
  override presignUpload(key: string, intent: UploadIntent, expiresInSeconds?: number) {
    return this.signUpload(key, intent, expiresInSeconds);
  }

  override presignDownload(key: string, options: DownloadOptions = {}) {
    return this.signDownload(key, options);
  }

  protected signUpload(key: string, intent: UploadIntent, expiresInSeconds?: number) {
    return this.inner.presignUpload(this.outer(key), intent, expiresInSeconds);
  }

  protected signDownload(key: string, options: DownloadOptions) {
    return this.inner.presignDownload(this.outer(key), options);
  }
}
