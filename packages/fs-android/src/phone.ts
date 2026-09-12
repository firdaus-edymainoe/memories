import type { CopyArgs, DirEntry, FileIO, FileStat, VolumePresence, Volumes } from "@memories/core";
import { AndroidFileIO } from "./file-io.js";
import { MtpFileIO, MtpVolumes } from "./mtp.js";
import { isMtpPath } from "./mtp-uri.js";
import { isAdbPath } from "./uri.js";
import { AndroidVolumes } from "./volumes.js";

export type PhoneBridge = FileIO & {
  pull(rootPath: string, relativePath: string, localAbs: string): Promise<string>;
  push(localAbs: string, rootPath: string, relativePath: string): Promise<void>;
};

export class PhoneFileIO implements PhoneBridge {
  constructor(
    private readonly mtp: MtpFileIO,
    private readonly adb: AndroidFileIO,
  ) {}

  private pick(rootPath: string): PhoneBridge {
    if (isMtpPath(rootPath)) return this.mtp;
    if (isAdbPath(rootPath)) return this.adb;
    throw new Error("Not a phone path");
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

  copy(args: CopyArgs) {
    return this.pick(args.fromRoot).copy(args);
  }

  pull(rootPath: string, relativePath: string, localAbs: string) {
    return this.pick(rootPath).pull(rootPath, relativePath, localAbs);
  }

  push(localAbs: string, rootPath: string, relativePath: string) {
    return this.pick(rootPath).push(localAbs, rootPath, relativePath);
  }
}

export class PhoneVolumes implements Volumes {
  constructor(
    private readonly mtp: MtpVolumes,
    private readonly adb: AndroidVolumes,
  ) {}

  async list(): Promise<VolumePresence[]> {
    const plugged = await this.mtp.list().catch(() => []);
    if (plugged.length) return plugged;
    return this.adb.list().catch(() => []);
  }

  async identify(rootPath: string): Promise<VolumePresence> {
    if (isMtpPath(rootPath)) return this.mtp.identify(rootPath);
    if (isAdbPath(rootPath)) return this.adb.identify(rootPath);
    throw new Error("Not a phone path");
  }
}
