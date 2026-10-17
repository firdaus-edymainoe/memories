import { HeadObjectCommand, S3Client, S3ServiceException } from "@aws-sdk/client-s3";
import { describe, expect, it } from "vitest";
import {
  InvalidKeyError,
  MemoryObjectStorage,
  ObjectExistsError,
  ObjectNotFoundError,
  S3CompatibleStorage,
  createObjectStorage,
  isValidKey,
  s3ConfigFor,
  storageSettingsFromEnv,
} from "./index.js";

const bytes = (text: string) => new TextEncoder().encode(text);

describe("keys", () => {
  it("accepts relative paths and rejects escapes", () => {
    expect(isValidKey("users/1/photo.jpg")).toBe(true);
    expect(isValidKey("users/1/")).toBe(true);
    for (const key of ["", "/abs", "a/../b", "a//b", "./a", "a\\b", "a\u0000b"]) expect(isValidKey(key)).toBe(false);
  });
});

describe("MemoryObjectStorage", () => {
  it("never overwrites on upload or copy", async () => {
    const storage = new MemoryObjectStorage();
    await storage.put("a.txt", bytes("one"));
    await expect(storage.presignUpload("a.txt", { size: 3, contentType: "text/plain" })).rejects.toBeInstanceOf(ObjectExistsError);
    await storage.put("b.txt", bytes("two"));
    await expect(storage.copy("a.txt", "b.txt")).rejects.toBeInstanceOf(ObjectExistsError);
    expect(new TextDecoder().decode(storage.bytes("b.txt")!)).toBe("two");
  });

  it("completes signed uploads only with the signed size", async () => {
    const storage = new MemoryObjectStorage();
    await storage.presignUpload("x.bin", { size: 4, contentType: "application/octet-stream", metadata: { SHA256: "abc" } });
    await expect(storage.receive("x.bin", bytes("toolong"))).rejects.toThrow(/size/);
    await storage.receive("x.bin", bytes("four"));
    expect(await storage.head("x.bin")).toMatchObject({ size: 4, metadata: { sha256: "abc" } });
  });

  it("refuses to sign a download for a missing object", async () => {
    await expect(new MemoryObjectStorage().presignDownload("nope")).rejects.toBeInstanceOf(ObjectNotFoundError);
  });

  it("lists one level with a delimiter", async () => {
    const storage = new MemoryObjectStorage();
    await storage.put("p/a.jpg", bytes("a"));
    await storage.put("p/trip/b.jpg", bytes("b"));
    await storage.put("p/trip/c/d.jpg", bytes("d"));
    const listing = await storage.list("p/", { delimiter: "/" });
    expect(listing.objects.map((o) => o.key)).toEqual(["p/a.jpg"]);
    expect(listing.prefixes).toEqual(["p/trip/"]);
    expect((await storage.list("p/")).objects).toHaveLength(3);
  });
});

describe("scoped storage", () => {
  it("keeps every key inside its prefix", async () => {
    const root = new MemoryObjectStorage();
    await root.put("users/other/secret.txt", bytes("no"));
    const mine = root.scoped("users/me/");
    await mine.presignUpload("notes.txt", { size: 2, contentType: "text/plain" });
    await root.receive("users/me/notes.txt", bytes("hi"));

    expect(await mine.head("notes.txt")).toMatchObject({ key: "notes.txt", size: 2 });
    expect((await mine.list("")).objects.map((o) => o.key)).toEqual(["notes.txt"]);
    await expect(mine.head("../other/secret.txt")).rejects.toBeInstanceOf(InvalidKeyError);
    expect(() => root.scoped("no-slash")).toThrow(InvalidKeyError);
  });
});

describe("providers", () => {
  it("points Backblaze B2 at its S3 endpoint", () => {
    expect(
      s3ConfigFor({ provider: "backblaze-b2", region: "us-west-004", bucket: "b", accessKeyId: "k", secretAccessKey: "s" }),
    ).toMatchObject({ endpoint: "https://s3.us-west-004.backblazeb2.com", region: "us-west-004" });
  });

  it("reads settings from the environment, B2 by default", () => {
    const settings = storageSettingsFromEnv({
      STORAGE_BUCKET: "memories",
      STORAGE_ACCESS_KEY_ID: "key",
      STORAGE_SECRET_ACCESS_KEY: "secret",
      STORAGE_REGION: "eu-central-003",
    });
    expect(settings).toEqual({
      provider: "backblaze-b2",
      region: "eu-central-003",
      bucket: "memories",
      accessKeyId: "key",
      secretAccessKey: "secret",
    });
    expect(() => storageSettingsFromEnv({ STORAGE_PROVIDER: "backblaze-b2" })).toThrow(/STORAGE_BUCKET/);
    expect(createObjectStorage({ provider: "memory" }).provider).toBe("memory");
    expect(createObjectStorage(settings).provider).toBe("backblaze-b2");
  });
});

describe("S3CompatibleStorage", () => {
  const config = s3ConfigFor({ provider: "backblaze-b2", region: "us-west-004", bucket: "memories", accessKeyId: "AK", secretAccessKey: "SK" });

  function withHead(found: boolean) {
    const client = new S3Client({
      region: config.region,
      endpoint: config.endpoint!,
      credentials: { accessKeyId: "AK", secretAccessKey: "SK" },
    });
    // Signing happens locally; only requests that would reach the network are faked.
    client.send = (async (command: unknown) => {

        if (command instanceof HeadObjectCommand) {
          if (!found) {
            throw new S3ServiceException({ name: "NotFound", $fault: "client", $metadata: { httpStatusCode: 404 } });
          }
          return { ContentLength: 5, LastModified: new Date("2026-01-01T00:00:00Z"), Metadata: { Sha256: "h" } };
        }
        return {};
    }) as S3Client["send"];
    return { storage: new S3CompatibleStorage(config, client) };
  }

  it("signs uploads with their size, type and metadata", async () => {
    const { storage } = withHead(false);
    const request = await storage.presignUpload("users/1/a.jpg", { size: 10, contentType: "image/jpeg", metadata: { sha256: "abc" } });
    expect(request.method).toBe("PUT");
    expect(request.url).toMatch(/^https:\/\/memories\.s3\.us-west-004\.backblazeb2\.com\/users\/1\/a\.jpg\?/);
    const signed = new URL(request.url).searchParams.get("X-Amz-SignedHeaders")!.split(";");
    expect(signed).toEqual(expect.arrayContaining(["content-length", "content-type", "host", "x-amz-meta-sha256"]));
    expect(request.headers).toMatchObject({ "content-length": "10", "content-type": "image/jpeg", "x-amz-meta-sha256": "abc" });
  });

  it("reports missing objects as null and existing ones with metadata", async () => {
    expect(await withHead(false).storage.head("a")).toBeNull();
    expect(await withHead(true).storage.head("a")).toMatchObject({ size: 5, metadata: { sha256: "h" } });
    await expect(withHead(true).storage.presignUpload("a", { size: 1, contentType: "x/y" })).rejects.toBeInstanceOf(ObjectExistsError);
  });
});
