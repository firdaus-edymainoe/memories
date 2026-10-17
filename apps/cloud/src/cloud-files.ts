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
 * Each person's cloud storage. Built on `ObjectStorage`, so it works the same on any provider.
 * Everyone gets their own prefix; nothing here can reach another person's files.
 */
export class CloudFiles {
  constructor(private readonly storage: ObjectStorage) {}

  get provider() {
    return this.storage.provider;
  }

  private space(userId: string) {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(userId)) throw new Error("Unexpected user id");
    return this.storage.scoped(`users/${userId}/files/`);
  }

  /** One folder's contents, or with `recursive` every file below it. */
  async list(userId: string, folder: string, options: { recursive?: boolean } = {}): Promise<CloudEntry[]> {
    const prefix = folderPrefix(folder);
    const listing = await this.space(userId).list(prefix, options.recursive ? {} : { delimiter: "/" });
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

  async stat(userId: string, path: string): Promise<CloudFileStat | null> {
    const object = await this.space(userId).head(filePath(path));
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
  prepareUpload(userId: string, input: { path: string; size: number; sha256: string; contentType: string }): Promise<PresignedRequest> {
    if (!SHA256.test(input.sha256)) throw new CloudInputError("sha256 must be 64 lower-case hex characters");
    return this.space(userId).presignUpload(filePath(input.path), {
      size: input.size,
      contentType: input.contentType || "application/octet-stream",
      metadata: { sha256: input.sha256 },
    });
  }

  prepareDownload(userId: string, path: string, fileName?: string): Promise<PresignedRequest> {
    return this.space(userId).presignDownload(filePath(path), fileName ? { fileName } : {});
  }

  copy(userId: string, from: string, to: string) {
    return this.space(userId).copy(filePath(from), filePath(to));
  }

  remove(userId: string, path: string) {
    return this.space(userId).delete(filePath(path));
  }

  /** Deletes everything a person stored (their account is gone). */
  async removeAll(userId: string) {
    const space = this.space(userId);
    for (const object of (await space.list("")).objects) await space.delete(object.key);
  }
}
