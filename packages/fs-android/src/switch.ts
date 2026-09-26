import { relativeInsideRoot, type CopyArgs, type DirEntry, type FileIO, type FileStat, type VolumePresence, type Volumes } from "@memories/core";
import { mkdir } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
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
      const dest = localJoin(args.toRoot, args.toRelative);
      await mkdir(dirname(dest), { recursive: true });
      await this.phone.pull(args.fromRoot, args.fromRelative, dest);
      args.onProgress?.(1);
      return;
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
