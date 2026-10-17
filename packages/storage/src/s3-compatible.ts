import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import {
  type DownloadOptions,
  ObjectExistsError,
  type ObjectListing,
  ObjectStorage,
  type PresignedRequest,
  type StoredObject,
  type UploadIntent,
} from "./object-storage.js";

export type S3CompatibleConfig = {
  /** Shown in logs and status, e.g. `backblaze-b2`. */
  provider: string;
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Leave out for AWS itself; set for every other provider. */
  endpoint?: string;
  /** `bucket` in the path instead of the host name (MinIO and most self-hosted servers). */
  forcePathStyle?: boolean;
  /**
   * The provider honours `If-None-Match: *` on writes, so a race between two uploads to the same
   * key cannot overwrite. Without it we still check before signing.
   */
  conditionalWrites?: boolean;
};

function isNotFound(error: unknown) {
  if (!(error instanceof S3ServiceException)) return false;
  return error.$metadata.httpStatusCode === 404 || error.name === "NotFound" || error.name === "NoSuchKey";
}

function isPreconditionFailed(error: unknown) {
  return error instanceof S3ServiceException && error.$metadata.httpStatusCode === 412;
}

function lowerKeys(record: Record<string, string> | undefined) {
  return Object.fromEntries(Object.entries(record ?? {}).map(([key, value]) => [key.toLowerCase(), value]));
}

/** RFC 6266 `attachment` header that survives non-ASCII names. */
function attachment(fileName: string) {
  const ascii = fileName.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

/**
 * Any storage that speaks the S3 API: Backblaze B2, AWS S3, Cloudflare R2, Wasabi, MinIO. The
 * provider is only configuration (see `providers.ts`); nothing here is specific to one of them.
 */
export class S3CompatibleStorage extends ObjectStorage {
  readonly provider: string;
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly conditionalWrites: boolean;

  constructor(config: S3CompatibleConfig, client?: S3Client) {
    super();
    this.provider = config.provider;
    this.bucket = config.bucket;
    this.conditionalWrites = config.conditionalWrites ?? false;
    this.client =
      client ??
      new S3Client({
        region: config.region,
        credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
        forcePathStyle: config.forcePathStyle ?? false,
        ...(config.endpoint ? { endpoint: config.endpoint } : {}),
      });
  }

  async head(key: string): Promise<StoredObject | null> {
    try {
      const result = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: this.checkKey(key) }));
      return {
        key,
        size: result.ContentLength ?? 0,
        lastModified: (result.LastModified ?? new Date(0)).toISOString(),
        contentType: result.ContentType ?? null,
        metadata: lowerKeys(result.Metadata),
      };
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  async list(prefix: string, options: { delimiter?: string } = {}): Promise<ObjectListing> {
    const listing: ObjectListing = { objects: [], prefixes: [] };
    let token: string | undefined;
    do {
      const page = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: prefix,
          ...(options.delimiter ? { Delimiter: options.delimiter } : {}),
          ...(token ? { ContinuationToken: token } : {}),
        }),
      );
      for (const item of page.Contents ?? []) {
        if (!item.Key) continue;
        listing.objects.push({
          key: item.Key,
          size: item.Size ?? 0,
          lastModified: (item.LastModified ?? new Date(0)).toISOString(),
          contentType: null,
          metadata: {},
        });
      }
      for (const common of page.CommonPrefixes ?? []) if (common.Prefix) listing.prefixes.push(common.Prefix);
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
    return listing;
  }

  async copy(fromKey: string, toKey: string) {
    this.checkKey(fromKey);
    this.checkKey(toKey);
    if (await this.head(toKey)) throw new ObjectExistsError(toKey);
    try {
      await this.client.send(
        new CopyObjectCommand({
          Bucket: this.bucket,
          Key: toKey,
          CopySource: `${this.bucket}/${fromKey.split("/").map(encodeURIComponent).join("/")}`,
          MetadataDirective: "COPY",
          ...(this.conditionalWrites ? { IfNoneMatch: "*" } : {}),
        }),
      );
    } catch (error) {
      if (isPreconditionFailed(error)) throw new ObjectExistsError(toKey);
      throw error;
    }
  }

  async delete(key: string) {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: this.checkKey(key) }));
  }

  protected async signUpload(key: string, intent: UploadIntent, expiresInSeconds: number): Promise<PresignedRequest> {
    const metadata = intent.metadata ?? {};
    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      ContentType: intent.contentType,
      ContentLength: intent.size,
      Metadata: metadata,
      ...(this.conditionalWrites ? { IfNoneMatch: "*" } : {}),
    });
    // Sign the size, type and metadata as headers so the client cannot upload something else.
    const headers: Record<string, string> = {
      "content-type": intent.contentType,
      "content-length": String(intent.size),
      ...Object.fromEntries(Object.entries(metadata).map(([name, value]) => [`x-amz-meta-${name.toLowerCase()}`, value])),
      ...(this.conditionalWrites ? { "if-none-match": "*" } : {}),
    };
    const url = await getSignedUrl(this.client, command, {
      expiresIn: expiresInSeconds,
      signableHeaders: new Set(Object.keys(headers)),
      unhoistableHeaders: new Set(Object.keys(headers).filter((name) => name.startsWith("x-amz-"))),
    });
    return { method: "PUT", url, headers, expiresAt: new Date(Date.now() + expiresInSeconds * 1000).toISOString() };
  }

  protected async signDownload(key: string, options: DownloadOptions, expiresInSeconds: number): Promise<PresignedRequest> {
    const command = new GetObjectCommand({
      Bucket: this.bucket,
      Key: key,
      ...(options.fileName ? { ResponseContentDisposition: attachment(options.fileName) } : {}),
    });
    const url = await getSignedUrl(this.client, command, { expiresIn: expiresInSeconds });
    return { method: "GET", url, headers: {}, expiresAt: new Date(Date.now() + expiresInSeconds * 1000).toISOString() };
  }
}
