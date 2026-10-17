import { type ObjectStorage, type PresignedRequest, isValidKey } from "@memories/storage";

/** One entry in a person's cloud storage. Paths are relative to their space, `/`-separated. */
export type CloudEntry = {
  path: string;
  directory: boolean;
  size: number;
  modifiedAt: string | null;
};

export type CloudFileStat = {
  path: string;
  size: number;
  modifiedAt: string;
  contentType: string | null;
  /** SHA-256 (hex) of the content, recorded when it was uploaded. */
  sha256: string | null;
};

/** The request named a bad path or hash. Nothing was changed. */
export class CloudInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CloudInputError";
  }
}

const badPath = (path: string) => new CloudInputError(`Not a valid path: ${JSON.stringify(path)}`);

const SHA256 = /^[0-9a-f]{64}$/;

function filePath(path: string) {
  if (!isValidKey(path) || path.endsWith("/")) throw badPath(path);
  return path;
}

function folderPrefix(path: string) {
  const trimmed = path.replace(/^\/+|\/+$/g, "");
  if (!trimmed) return "";
  if (!isValidKey(trimmed)) throw badPath(path);
  return `${trimmed}/`;
}

/**
 * One storage space a person's files live in: their part of Memories Cloud, or one of the drives
 * they connected. Built on `ObjectStorage`, so it works the same on every provider.
 */
export class CloudSpace {
  constructor(private readonly storage: ObjectStorage) {}

  get provider() {
    return this.storage.provider;
  }

  /** One folder's contents, or with `recursive` every file below it. */
  async list(folder: string, options: { recursive?: boolean } = {}): Promise<CloudEntry[]> {
    const prefix = folderPrefix(folder);
    const listing = await this.storage.list(prefix, options.recursive ? {} : { delimiter: "/" });
    const folders: CloudEntry[] = listing.prefixes.map((value) => ({
      path: value.replace(/\/$/, ""),
      directory: true,
      size: 0,
      modifiedAt: null,
    }));
    const files: CloudEntry[] = listing.objects
      .filter((object) => !object.key.endsWith("/"))
      .map((object) => ({ path: object.key, directory: false, size: object.size, modifiedAt: object.lastModified }));
    return [...folders, ...files];
  }

  async stat(path: string): Promise<CloudFileStat | null> {
    const object = await this.storage.head(filePath(path));
    if (!object) return null;
    return {
      path,
      size: object.size,
      modifiedAt: object.lastModified,
      contentType: object.contentType,
      sha256: object.metadata.sha256 ?? null,
    };
  }

  /** A signed upload for a new file. Throws `ObjectExistsError` if the path is taken. */
  prepareUpload(input: { path: string; size: number; sha256: string; contentType: string }): Promise<PresignedRequest> {
    if (!SHA256.test(input.sha256)) throw new CloudInputError("sha256 must be 64 lower-case hex characters");
    return this.storage.presignUpload(filePath(input.path), {
      size: input.size,
      contentType: input.contentType || "application/octet-stream",
      metadata: { sha256: input.sha256 },
    });
  }

  prepareDownload(path: string, fileName?: string): Promise<PresignedRequest> {
    return this.storage.presignDownload(filePath(path), fileName ? { fileName } : {});
  }

  copy(from: string, to: string) {
    return this.storage.copy(filePath(from), filePath(to));
  }

  remove(path: string) {
    return this.storage.delete(filePath(path));
  }

  /** Deletes every file in this space. */
  async removeAll() {
    for (const object of (await this.storage.list("")).objects) await this.storage.delete(object.key);
  }
}

/**
 * Memories Cloud: the storage this server runs (Backblaze B2 or another provider). Everyone gets
 * their own prefix; nothing here can reach another person's files.
 */
export class CloudFiles {
  constructor(private readonly storage: ObjectStorage) {}

  get provider() {
    return this.storage.provider;
  }

  space(userId: string) {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(userId)) throw new Error("Unexpected user id");
    return new CloudSpace(this.storage.scoped(`users/${userId}/files/`));
  }

  /** Deletes everything a person stored (their account is gone). */
  removeAll(userId: string) {
    return this.space(userId).removeAll();
  }
}
