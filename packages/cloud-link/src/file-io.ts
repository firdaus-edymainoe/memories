import {
  type ByteRange,
  type CloudUser,
  type ConnectedDrive,
  type CopyArgs,
  DestinationExistsError,
  type DirEntry,
  type FileIO,
  type FileStat,
  kindFromName,
  mimeFromName,
  relativeInsideRoot,
  type VolumePresence,
  type Volumes,
} from "@memories/core";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { type CloudApi, CloudApiError, type CloudStorageClient } from "./api.js";

const SCHEME = "cloud://";
const DRIVES = "/drives/";

/**
 * The root path of a cloud place: `cloud://<userId>` is the person's Memories Cloud, and
 * `cloud://<userId>/drives/<driveId>` is one of the drives they connected.
 */
export function cloudRoot(userId: string, driveId: string | null = null) {
  return driveId === null ? `${SCHEME}${userId}` : `${SCHEME}${userId}${DRIVES}${driveId}`;
}

export function cloudVolumeId(userId: string, driveId: string | null = null) {
  return driveId === null ? `cloud:${userId}` : `cloud:${userId}${DRIVES}${driveId}`;
}

export function isCloudPath(rootPath: string) {
  return rootPath.startsWith(SCHEME);
}

/** Whose cloud place a root path is, and which space: Memories Cloud (`driveId` null) or a drive. */
export function parseCloudRoot(rootPath: string): { userId: string; driveId: string | null } | null {
  if (!isCloudPath(rootPath)) return null;
  const rest = rootPath.slice(SCHEME.length);
  const cut = rest.indexOf(DRIVES);
  if (cut < 0) return rest && !rest.includes("/") ? { userId: rest, driveId: null } : null;
  const userId = rest.slice(0, cut);
  const driveId = rest.slice(cut + DRIVES.length);
  return userId && driveId && !driveId.includes("/") ? { userId, driveId } : null;
}

/** Who is signed in right now, how to reach the server for them, and the drives they connected. */
export interface CloudConnection {
  current(): { user: CloudUser; api: CloudApi; drives: ConnectedDrive[] } | null;
}

function basename(path: string) {
  return path.slice(path.lastIndexOf("/") + 1);
}

/**
 * Cloud storage as a place, so everything that works with a drive (browse, copy, backups)
 * works with the cloud. Bytes go straight between this computer and the storage provider
 * through signed requests; the server only signs them.
 */
export class CloudFileIO implements FileIO {
  constructor(private readonly connection: CloudConnection) {}

  /** The storage space a cloud place points at, after checking it belongs to who is signed in. */
  private space(rootPath: string): CloudStorageClient {
    const current = this.connection.current();
    if (!current) throw new Error("Sign in to Memories Cloud to use cloud storage");
    const root = parseCloudRoot(rootPath);
    if (!root || root.userId !== current.user.id) throw new Error("This cloud storage belongs to another account");
    if (root.driveId !== null) {
      const drive = current.drives.find((each) => each.id === root.driveId);
      if (!drive) throw new Error("This drive isn't connected to your account anymore");
      if (drive.status === "reconnect") throw new Error(`${drive.label} needs to be connected again in Settings`);
    }
    return current.api.storage(root.driveId);
  }

  private api() {
    return this.connection.current()!.api;
  }

  async walk(rootPath: string, subPath = ""): Promise<FileStat[]> {
    const entries = await this.space(rootPath).list(relativeInsideRoot(subPath), true);
    return entries
      .filter((entry) => !entry.directory)
      .map((entry) => {
        const name = basename(entry.path);
        return {
          relativePath: entry.path,
          size: entry.size,
          mime: mimeFromName(name),
          kind: kindFromName(name),
          takenAt: null,
          place: null,
          ...(entry.modifiedAt ? { modifiedAt: entry.modifiedAt } : {}),
        };
      });
  }

  async list(rootPath: string, subPath = ""): Promise<DirEntry[]> {
    const entries = await this.space(rootPath).list(relativeInsideRoot(subPath));
    return entries
      .map((entry) => {
        const name = basename(entry.path);
        return {
          name,
          relativePath: entry.path,
          directory: entry.directory,
          size: entry.size,
          kind: entry.directory ? null : kindFromName(name),
        };
      })
      .sort((a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name));
  }

  private async stat(rootPath: string, relativePath: string) {
    const stat = await this.space(rootPath).stat(relativeInsideRoot(relativePath));
    if (!stat) throw new Error(`No file at ${relativePath} in cloud storage`);
    return stat;
  }

  /**
   * The SHA-256 recorded at upload. Files without one (put there outside Memories, or on a
   * drive that drops metadata) are read and hashed here.
   */
  async hash(rootPath: string, relativePath: string) {
    const stat = await this.stat(rootPath, relativePath);
    if (stat.sha256) return stat.sha256;
    const hash = createHash("sha256");
    const reader = (await this.stream(rootPath, relativePath)).getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      hash.update(value);
    }
    return hash.digest("hex");
  }

  async size(rootPath: string, relativePath: string) {
    return (await this.stat(rootPath, relativePath)).size;
  }

  async exists(rootPath: string, relativePath: string) {
    return (await this.space(rootPath).stat(relativeInsideRoot(relativePath))) !== null;
  }

  private async download(rootPath: string, relativePath: string, range?: ByteRange) {
    const signed = await this.space(rootPath).prepareDownload(relativeInsideRoot(relativePath));
    return this.api().sendSigned(signed, range ? { range } : {});
  }

  async read(rootPath: string, relativePath: string) {
    return new Uint8Array(await (await this.download(rootPath, relativePath)).arrayBuffer());
  }

  async stream(rootPath: string, relativePath: string, range?: ByteRange) {
    const response = await this.download(rootPath, relativePath, range);
    if (!response.body) throw new Error("Cloud storage sent an empty response");
    return response.body;
  }

  /** Writes a cloud file into a local path (used to copy from the cloud onto a drive). */
  async downloadTo(rootPath: string, relativePath: string, localPath: string) {
    const body = await this.stream(rootPath, relativePath);
    await pipeline(Readable.fromWeb(body as import("node:stream/web").ReadableStream), createWriteStream(localPath, { flags: "wx" }));
  }

  /** Folders are only prefixes in object storage: nothing to create. */
  async mkdir(rootPath: string) {
    this.space(rootPath);
  }

  /** Within one space the provider copies; between two spaces the bytes pass through here. */
  async copy(args: CopyArgs) {
    const to = this.space(args.toRoot);
    this.space(args.fromRoot);
    if (args.fromRoot !== args.toRoot) {
      const relative = relativeInsideRoot(args.fromRelative);
      const sha256 = await this.hash(args.fromRoot, relative);
      const size = await this.size(args.fromRoot, relative);
      await this.upload({ toRoot: args.toRoot, toRelative: args.toRelative, size, sha256, body: await this.stream(args.fromRoot, relative) });
      args.onProgress?.(1);
      return;
    }
    try {
      await to.copy(relativeInsideRoot(args.fromRelative), relativeInsideRoot(args.toRelative));
    } catch (error) {
      if (error instanceof CloudApiError && error.status === 409) throw new DestinationExistsError(relativeInsideRoot(args.toRelative));
      throw error;
    }
    args.onProgress?.(1);
  }

  /**
   * Uploads new content. Never overwrites: throws `DestinationExistsError` if the path is taken.
   * An object only appears once the provider has received every byte, so a failed upload
   * leaves nothing behind.
   */
  async upload(input: {
    toRoot: string;
    toRelative: string;
    size: number;
    sha256: string;
    body: ReadableStream<Uint8Array> | Uint8Array;
  }) {
    const space = this.space(input.toRoot);
    const path = relativeInsideRoot(input.toRelative);
    let signed;
    try {
      signed = await space.prepareUpload({ path, size: input.size, sha256: input.sha256, contentType: mimeFromName(basename(path)) });
    } catch (error) {
      if (error instanceof CloudApiError && error.status === 409) throw new DestinationExistsError(path);
      throw error;
    }
    try {
      await this.api().uploadSigned(signed, input.body, input.size);
    } catch (error) {
      if (error instanceof CloudApiError && (error.status === 412 || error.status === 409)) throw new DestinationExistsError(path);
      throw error;
    }
  }

  async remove(rootPath: string, relativePath: string) {
    await this.space(rootPath).remove(relativeInsideRoot(relativePath));
  }
}

/**
 * Cloud places are "plugged in" while their account is signed in: Memories Cloud, and each
 * connected drive that still lets us in.
 */
export class CloudVolumes implements Volumes {
  constructor(private readonly connection: CloudConnection) {}

  async list(): Promise<VolumePresence[]> {
    const current = this.connection.current();
    if (!current) return [];
    const userId = current.user.id;
    return [
      { volumeId: cloudVolumeId(userId), mountPath: cloudRoot(userId), label: "Memories Cloud" },
      ...current.drives
        .filter((drive) => drive.status === "connected")
        .map((drive) => ({ volumeId: cloudVolumeId(userId, drive.id), mountPath: cloudRoot(userId, drive.id), label: drive.label })),
    ];
  }

  async identify(rootPath: string): Promise<VolumePresence> {
    const found = (await this.list()).find((volume) => volume.mountPath === rootPath);
    if (!found) throw new Error("Sign in to Memories Cloud and connect this drive to use it");
    return found;
  }
}

/**
 * Sends cloud paths to `CloudFileIO` and everything else to the local adapter, and copies across
 * the two: uploads stream from the drive, downloads land in a temp file the local adapter then
 * copies in (so local copies keep their never-overwrite, never-half-written rules).
 */
export class WithCloudFileIO implements FileIO {
  constructor(
    private readonly local: FileIO,
    private readonly cloud: CloudFileIO,
  ) {}

  private pick(rootPath: string): FileIO {
    return isCloudPath(rootPath) ? this.cloud : this.local;
  }

  walk(rootPath: string, subPath?: string) {
    return this.pick(rootPath).walk(rootPath, subPath);
  }

  list(rootPath: string, subPath?: string) {
    return this.pick(rootPath).list(rootPath, subPath);
  }

  hash(rootPath: string, relativePath: string) {
    return this.pick(rootPath).hash(rootPath, relativePath);
  }

  read(rootPath: string, relativePath: string) {
    return this.pick(rootPath).read(rootPath, relativePath);
  }

  exists(rootPath: string, relativePath: string) {
    return this.pick(rootPath).exists(rootPath, relativePath);
  }

  mkdir(rootPath: string, relativePath: string) {
    return this.pick(rootPath).mkdir(rootPath, relativePath);
  }

  remove(rootPath: string, relativePath: string) {
    return this.pick(rootPath).remove(rootPath, relativePath);
  }

  async describe(rootPath: string, relativePath: string) {
    if (isCloudPath(rootPath) || !this.local.describe) return {};
    return this.local.describe(rootPath, relativePath);
  }

  async size(rootPath: string, relativePath: string) {
    const io = this.pick(rootPath);
    if (io.size) return io.size(rootPath, relativePath);
    return (await io.read(rootPath, relativePath)).byteLength;
  }

  async stream(rootPath: string, relativePath: string, range?: ByteRange) {
    const io = this.pick(rootPath);
    if (io.stream) return io.stream(rootPath, relativePath, range);
    const bytes = await io.read(rootPath, relativePath);
    const part = range ? bytes.subarray(range.start, range.end + 1) : bytes;
    return new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(part);
        controller.close();
      },
    });
  }

  async copy(args: CopyArgs) {
    const fromCloud = isCloudPath(args.fromRoot);
    const toCloud = isCloudPath(args.toRoot);
    if (fromCloud === toCloud) return this.pick(args.fromRoot).copy(args);

    if (toCloud) {
      const sha256 = await this.local.hash(args.fromRoot, args.fromRelative);
      let size: number;
      let body: ReadableStream<Uint8Array> | Uint8Array;
      if (this.local.size && this.local.stream) {
        size = await this.local.size(args.fromRoot, args.fromRelative);
        body = await this.local.stream(args.fromRoot, args.fromRelative);
      } else {
        body = await this.local.read(args.fromRoot, args.fromRelative);
        size = body.byteLength;
      }
      await this.cloud.upload({ toRoot: args.toRoot, toRelative: args.toRelative, size, sha256, body });
      args.onProgress?.(1);
      return;
    }

    if (await this.local.exists(args.toRoot, args.toRelative)) {
      throw new DestinationExistsError(relativeInsideRoot(args.toRelative));
    }
    const temp = await mkdtemp(join(tmpdir(), "memories-cloud-"));
    try {
      await this.cloud.downloadTo(args.fromRoot, args.fromRelative, join(temp, "download"));
      await this.local.copy({ fromRoot: temp, fromRelative: "download", toRoot: args.toRoot, toRelative: args.toRelative });
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
    args.onProgress?.(1);
  }
}

export class WithCloudVolumes implements Volumes {
  constructor(
    private readonly local: Volumes,
    private readonly cloud: CloudVolumes,
  ) {}

  async list() {
    const [local, cloud] = await Promise.all([this.local.list(), this.cloud.list()]);
    return [...local, ...cloud];
  }

  identify(rootPath: string) {
    return isCloudPath(rootPath) ? this.cloud.identify(rootPath) : this.local.identify(rootPath);
  }
}
