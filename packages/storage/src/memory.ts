import {
  type DownloadOptions,
  ObjectExistsError,
  type ObjectListing,
  ObjectNotFoundError,
  ObjectStorage,
  type PresignedRequest,
  type StoredObject,
  type UploadIntent,
} from "./object-storage.js";

type Entry = StoredObject & { bytes: Uint8Array };

/**
 * Keeps objects in memory. For tests and for running the cloud server without a provider.
 * Signed URLs use the `memory:` scheme; `receive` stands in for the client's upload.
 */
export class MemoryObjectStorage extends ObjectStorage {
  readonly provider = "memory";
  private readonly objects = new Map<string, Entry>();
  private readonly pending = new Map<string, UploadIntent>();

  async head(key: string) {
    const entry = this.objects.get(this.checkKey(key));
    if (!entry) return null;
    const { bytes: _bytes, ...object } = entry;
    return { ...object, metadata: { ...object.metadata } };
  }

  async list(prefix: string, options: { delimiter?: string } = {}): Promise<ObjectListing> {
    const listing: ObjectListing = { objects: [], prefixes: [] };
    const prefixes = new Set<string>();
    for (const key of [...this.objects.keys()].sort()) {
      if (!key.startsWith(prefix)) continue;
      const rest = key.slice(prefix.length);
      const cut = options.delimiter ? rest.indexOf(options.delimiter) : -1;
      if (cut >= 0) prefixes.add(prefix + rest.slice(0, cut + options.delimiter!.length));
      else listing.objects.push((await this.head(key))!);
    }
    listing.prefixes = [...prefixes];
    return listing;
  }

  async copy(fromKey: string, toKey: string) {
    const source = this.objects.get(this.checkKey(fromKey));
    if (!source) throw new ObjectNotFoundError(fromKey);
    if (this.objects.has(this.checkKey(toKey))) throw new ObjectExistsError(toKey);
    this.objects.set(toKey, { ...source, key: toKey, lastModified: new Date().toISOString() });
  }

  async delete(key: string) {
    this.objects.delete(this.checkKey(key));
  }

  /** Writes an object directly (what a client does with a signed upload). */
  async put(key: string, bytes: Uint8Array, options: { contentType?: string; metadata?: Record<string, string> } = {}) {
    if (this.objects.has(this.checkKey(key))) throw new ObjectExistsError(key);
    this.objects.set(key, {
      key,
      bytes: bytes.slice(),
      size: bytes.byteLength,
      lastModified: new Date().toISOString(),
      contentType: options.contentType ?? null,
      metadata: Object.fromEntries(Object.entries(options.metadata ?? {}).map(([k, v]) => [k.toLowerCase(), v])),
    });
  }

  /** Completes a signed upload the way the provider would: same size and metadata, or nothing. */
  async receive(key: string, bytes: Uint8Array) {
    const intent = this.pending.get(key);
    if (!intent) throw new Error(`No signed upload for ${key}`);
    if (bytes.byteLength !== intent.size) throw new Error("Upload size does not match the signed size");
    this.pending.delete(key);
    await this.put(key, bytes, { contentType: intent.contentType, ...(intent.metadata ? { metadata: intent.metadata } : {}) });
  }

  bytes(key: string) {
    return this.objects.get(key)?.bytes.slice() ?? null;
  }

  protected async signUpload(key: string, intent: UploadIntent, expiresInSeconds: number): Promise<PresignedRequest> {
    this.pending.set(key, intent);
    return {
      method: "PUT",
      url: `memory:${encodeURIComponent(key)}`,
      headers: { "content-type": intent.contentType, "content-length": String(intent.size) },
      expiresAt: new Date(Date.now() + expiresInSeconds * 1000).toISOString(),
    };
  }

  protected async signDownload(key: string, _options: DownloadOptions, expiresInSeconds: number): Promise<PresignedRequest> {
    return {
      method: "GET",
      url: `memory:${encodeURIComponent(key)}`,
      headers: {},
      expiresAt: new Date(Date.now() + expiresInSeconds * 1000).toISOString(),
    };
  }
}
