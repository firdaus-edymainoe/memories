import { MemoryObjectStorage } from "./memory.js";
import type { ObjectStorage } from "./object-storage.js";
import { type S3CompatibleConfig, S3CompatibleStorage } from "./s3-compatible.js";

type Credentials = { bucket: string; accessKeyId: string; secretAccessKey: string };

/** Which storage to use. Switching provider is a change here (or in the environment), not in code. */
export type StorageSettings =
  /** Backblaze B2. `region` is the part of the bucket's S3 endpoint such as `us-west-004`. */
  | ({ provider: "backblaze-b2"; region: string } & Credentials)
  | ({ provider: "aws-s3"; region: string } & Credentials)
  | ({ provider: "cloudflare-r2"; accountId: string } & Credentials)
  /** Any other S3-compatible server (MinIO, Wasabi, Ceph, …). */
  | ({
      provider: "s3-compatible";
      endpoint: string;
      region?: string;
      forcePathStyle?: boolean;
      conditionalWrites?: boolean;
    } & Credentials)
  | { provider: "memory" };

export type StorageProvider = StorageSettings["provider"];

/** Turns provider settings into the S3 configuration each provider documents. */
export function s3ConfigFor(settings: Exclude<StorageSettings, { provider: "memory" }>): S3CompatibleConfig {
  const credentials = {
    bucket: settings.bucket,
    accessKeyId: settings.accessKeyId,
    secretAccessKey: settings.secretAccessKey,
  };
  switch (settings.provider) {
    case "backblaze-b2":
      return {
        ...credentials,
        provider: settings.provider,
        region: settings.region,
        endpoint: `https://s3.${settings.region}.backblazeb2.com`,
      };
    case "aws-s3":
      return { ...credentials, provider: settings.provider, region: settings.region, conditionalWrites: true };
    case "cloudflare-r2":
      return {
        ...credentials,
        provider: settings.provider,
        region: "auto",
        endpoint: `https://${settings.accountId}.r2.cloudflarestorage.com`,
        conditionalWrites: true,
      };
    case "s3-compatible":
      return {
        ...credentials,
        provider: settings.provider,
        region: settings.region ?? "us-east-1",
        endpoint: settings.endpoint,
        forcePathStyle: settings.forcePathStyle ?? true,
        conditionalWrites: settings.conditionalWrites ?? false,
      };
  }
}

export function createObjectStorage(settings: StorageSettings): ObjectStorage {
  if (settings.provider === "memory") return new MemoryObjectStorage();
  return new S3CompatibleStorage(s3ConfigFor(settings));
}

function required(env: Record<string, string | undefined>, name: string) {
  const value = env[name];
  if (!value) throw new Error(`${name} is required for this storage provider`);
  return value;
}

/**
 * Reads `STORAGE_PROVIDER` (default `backblaze-b2`) and its settings from the environment:
 * `STORAGE_BUCKET`, `STORAGE_ACCESS_KEY_ID`, `STORAGE_SECRET_ACCESS_KEY`, plus `STORAGE_REGION`,
 * `STORAGE_ENDPOINT` or `STORAGE_ACCOUNT_ID` as the provider needs.
 */
export function storageSettingsFromEnv(env: Record<string, string | undefined>): StorageSettings {
  const provider = (env.STORAGE_PROVIDER ?? "backblaze-b2") as StorageProvider;
  if (provider === "memory") return { provider };
  const credentials = {
    bucket: required(env, "STORAGE_BUCKET"),
    accessKeyId: required(env, "STORAGE_ACCESS_KEY_ID"),
    secretAccessKey: required(env, "STORAGE_SECRET_ACCESS_KEY"),
  };
  switch (provider) {
    case "backblaze-b2":
    case "aws-s3":
      return { provider, region: required(env, "STORAGE_REGION"), ...credentials };
    case "cloudflare-r2":
      return { provider, accountId: required(env, "STORAGE_ACCOUNT_ID"), ...credentials };
    case "s3-compatible":
      return {
        provider,
        endpoint: required(env, "STORAGE_ENDPOINT"),
        ...(env.STORAGE_REGION ? { region: env.STORAGE_REGION } : {}),
        ...(env.STORAGE_FORCE_PATH_STYLE ? { forcePathStyle: env.STORAGE_FORCE_PATH_STYLE === "true" } : {}),
        ...(env.STORAGE_CONDITIONAL_WRITES ? { conditionalWrites: env.STORAGE_CONDITIONAL_WRITES === "true" } : {}),
        ...credentials,
      };
    default:
      throw new Error(`Unknown STORAGE_PROVIDER ${JSON.stringify(provider)}`);
  }
}
