import {
  type ByteRange,
  DestinationExistsError,
  relativeInsideRoot,
  type CopyArgs,
  type DirEntry,
  type FileIO,
  type FileStat,
  type VolumePresence,
  type Volumes,
} from "@memories/core";
import { randomUUID } from "node:crypto";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import { isPhonePath } from "./mtp-uri.js";
import type { PhoneBridge } from "./phone.js";

function localJoin(rootPath: string, relativePath: string) {
  const rel = relativeInsideRoot(relativePath);
  const rootAbs = resolve(rootPath);
  const abs = rel ? resolve(rootAbs, ...rel.split("/")) : rootAbs;
  const prefix = rootAbs.endsWith(sep) ? rootAbs : rootAbs + sep;
  if (abs !== rootAbs && !abs.startsWith(prefix)) throw new Error("Path escapes drive root");
  return abs;
}

export class SwitchFileIO implements FileIO {
  /** Phones cannot read byte ranges, so the last file read for streaming is kept for seeks. */
  private phoneCache: { key: string; bytes: Uint8Array } | null = null;

  constructor(
    private readonly local: FileIO,
    private readonly phone: PhoneBridge,
  ) {}

  private pick(rootPath: string): FileIO {
    return isPhonePath(rootPath) ? this.phone : this.local;
  }

  walk(rootPath: string, subPath?: string): Promise<FileStat[]> {
    return this.pick(rootPath).walk(rootPath, subPath);
  }

  list(rootPath: string, subPath?: string): Promise<DirEntry[]> {
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

  async describe(rootPath: string, relativePath: string) {
    if (!isPhonePath(rootPath) && this.local.describe) return this.local.describe(rootPath, relativePath);
    return {};
  }

  async size(rootPath: string, relativePath: string) {
    if (!isPhonePath(rootPath) && this.local.size) return this.local.size(rootPath, relativePath);
    return (await this.wholeFile(rootPath, relativePath)).byteLength;
  }

  async stream(rootPath: string, relativePath: string, range?: ByteRange) {
    if (!isPhonePath(rootPath) && this.local.stream) return this.local.stream(rootPath, relativePath, range);
    const bytes = await this.wholeFile(rootPath, relativePath);
    const part = range ? bytes.subarray(range.start, range.end + 1) : bytes;
    return new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(part);
        controller.close();
      },
    });
  }

  private async wholeFile(rootPath: string, relativePath: string) {
    const key = `${rootPath}::${relativePath}`;
    if (this.phoneCache?.key !== key) {
      this.phoneCache = { key, bytes: await this.pick(rootPath).read(rootPath, relativePath) };
    }
    return this.phoneCache.bytes;
  }

  mkdir(rootPath: string, relativePath: string) {
    return this.pick(rootPath).mkdir(rootPath, relativePath);
  }

  async copy(args: CopyArgs) {
    const fromPhone = isPhonePath(args.fromRoot);
    const toPhone = isPhonePath(args.toRoot);
    if (fromPhone === toPhone) {
      await this.pick(args.fromRoot).copy(args);
      return;
    }
    if (fromPhone && !toPhone) {
      // Same rules as local copies: never overwrite, never leave a partial file if the phone
      // disconnects mid-transfer.
      const dest = localJoin(args.toRoot, args.toRelative);
      await mkdir(dirname(dest), { recursive: true });
      try {
        await (await open(dest, "wx")).close();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
          throw new DestinationExistsError(relativeInsideRoot(args.toRelative));
        }
        throw error;
      }
      const temp = join(dirname(dest), `.${basename(dest)}.${randomUUID()}.part`);
      try {
        await this.phone.pull(args.fromRoot, args.fromRelative, temp);
        await rename(temp, dest);
      } catch (error) {
        await rm(temp, { force: true });
        await rm(dest, { force: true });
        throw error;
      }
      args.onProgress?.(1);
      return;
    }
    if (await this.phone.exists(args.toRoot, args.toRelative)) {
      throw new DestinationExistsError(relativeInsideRoot(args.toRelative));
    }
    await this.phone.push(localJoin(args.fromRoot, args.fromRelative), args.toRoot, args.toRelative);
    args.onProgress?.(1);
  }

  remove(rootPath: string, relativePath: string) {
    return this.pick(rootPath).remove(rootPath, relativePath);
  }
}

export class MergeVolumes implements Volumes {
  constructor(
    private readonly local: Volumes,
    private readonly phone: Volumes,
  ) {}

  async list(): Promise<VolumePresence[]> {
    const [a, b] = await Promise.all([this.local.list(), this.phone.list()]);
    return [...a, ...b];
  }

  async identify(rootPath: string): Promise<VolumePresence> {
    if (isPhonePath(rootPath)) return this.phone.identify(rootPath);
    return this.local.identify(rootPath);
  }
}
