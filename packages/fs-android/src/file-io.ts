import {
  kindFromName,
  mimeFromName,
  parentRelative,
  relativeInsideRoot,
  type DirEntry,
  type FileIO,
  type FileStat,
} from "@memories/core";
import { mkdir, readFile, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { adb, defaultRunner, type Runner } from "./run.js";
import { parseAdbRoot, quoteShell } from "./uri.js";

function remoteJoin(remoteRoot: string, relativePath: string) {
  const rel = relativeInsideRoot(relativePath);
  if (!rel) return remoteRoot;
  return `${remoteRoot.replace(/\/$/, "")}/${rel}`;
}

export class AndroidFileIO implements FileIO {
  constructor(private readonly run: Runner = defaultRunner) {}

  async walk(rootPath: string, subPath = ""): Promise<FileStat[]> {
    const { serial, remoteRoot } = parseAdbRoot(rootPath);
    const start = remoteJoin(remoteRoot, subPath);
    const script = `find ${quoteShell(start)} -type f -exec stat -c '%s %Y %n' {} +`;
    let stdout = "";
    try {
      stdout = (await adb(this.run, ["-s", serial, "shell", script])).stdout;
    } catch {
      return [];
    }
    const out: FileStat[] = [];
    for (const line of stdout.split("\n")) {
      const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
      if (!match) continue;
      const abs = match[3]!;
      if (!abs.startsWith(start)) continue;
      let relativePath = abs.slice(start.length).replace(/^\//, "");
      if (subPath) {
        const prefix = relativeInsideRoot(subPath);
        relativePath = relativePath ? `${prefix}/${relativePath}` : prefix;
      }
      const name = abs.slice(abs.lastIndexOf("/") + 1);
      if (name.startsWith(".")) continue;
      out.push({
        relativePath,
        size: Number(match[1]),
        mime: mimeFromName(name),
        kind: kindFromName(name),
        takenAt: new Date(Number(match[2]) * 1000).toISOString(),
        place: null,
      });
    }
    return out;
  }

  async list(rootPath: string, subPath = ""): Promise<DirEntry[]> {
    const { serial, remoteRoot } = parseAdbRoot(rootPath);
    const start = remoteJoin(remoteRoot, subPath);
    const prefix = relativeInsideRoot(subPath);
    let stdout = "";
    try {
      stdout = (await adb(this.run, ["-s", serial, "shell", `ls -1p ${quoteShell(start)}`])).stdout;
    } catch {
      return [];
    }
    const out: DirEntry[] = [];
    for (const line of stdout.split("\n")) {
      const raw = line.replace(/\r$/, "").trim();
      if (!raw || raw === "./" || raw === "../") continue;
      const directory = raw.endsWith("/");
      const name = directory ? raw.slice(0, -1) : raw;
      if (!name || name.startsWith(".")) continue;
      out.push({
        name,
        relativePath: prefix ? `${prefix}/${name}` : name,
        directory,
        size: 0,
        kind: directory ? null : kindFromName(name),
      });
    }
    return out.sort((a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name));
  }

  async hash(rootPath: string, relativePath: string) {
    const { serial, remoteRoot } = parseAdbRoot(rootPath);
    const remote = remoteJoin(remoteRoot, relativePath);
    const { stdout } = await adb(this.run, ["-s", serial, "shell", `sha256sum ${quoteShell(remote)}`]);
    const hex = stdout.trim().split(/\s+/)[0];
    if (!hex || !/^[0-9a-f]+$/i.test(hex)) throw new Error(`Could not hash ${relativePath}`);
    return hex.toLowerCase();
  }

  async read(rootPath: string, relativePath: string) {
    const tmp = join(tmpdir(), `memories-adb-${crypto.randomUUID()}`);
    try {
      await this.pull(rootPath, relativePath, tmp);
      return await readFile(tmp);
    } finally {
      await unlink(tmp).catch(() => undefined);
    }
  }

  async exists(rootPath: string, relativePath: string) {
    const { serial, remoteRoot } = parseAdbRoot(rootPath);
    const remote = remoteJoin(remoteRoot, relativePath);
    try {
      const { stdout } = await adb(this.run, ["-s", serial, "shell", `test -e ${quoteShell(remote)} && echo yes`]);
      return stdout.includes("yes");
    } catch {
      return false;
    }
  }

  async mkdir(rootPath: string, relativePath: string) {
    const { serial, remoteRoot } = parseAdbRoot(rootPath);
    const remote = remoteJoin(remoteRoot, relativePath);
    await adb(this.run, ["-s", serial, "shell", `mkdir -p ${quoteShell(remote)}`]);
  }

  async copy(args: Parameters<FileIO["copy"]>[0]) {
    const from = parseAdbRoot(args.fromRoot);
    const to = parseAdbRoot(args.toRoot);
    const src = remoteJoin(from.remoteRoot, args.fromRelative);
    const dest = remoteJoin(to.remoteRoot, args.toRelative);
    if (from.serial === to.serial) {
      const parent = dest.slice(0, dest.lastIndexOf("/"));
      await adb(this.run, [
        "-s",
        from.serial,
        "shell",
        `mkdir -p ${quoteShell(parent)} && cp ${quoteShell(src)} ${quoteShell(dest)}`,
      ]);
      args.onProgress?.(1);
      return;
    }
    throw new Error("Copy between two phones is not supported");
  }

  async pull(rootPath: string, relativePath: string, localAbs: string) {
    const { serial, remoteRoot } = parseAdbRoot(rootPath);
    const remote = remoteJoin(remoteRoot, relativePath);
    await mkdir(dirname(localAbs), { recursive: true });
    await adb(this.run, ["-s", serial, "pull", remote, localAbs]);
    return localAbs;
  }

  async push(localAbs: string, rootPath: string, relativePath: string) {
    const { serial, remoteRoot } = parseAdbRoot(rootPath);
    const remote = remoteJoin(remoteRoot, relativePath);
    const parent = parentRelative(relativePath);
    if (parent) await this.mkdir(rootPath, parent);
    await adb(this.run, ["-s", serial, "push", localAbs, remote]);
  }

  async remove(rootPath: string, relativePath: string) {
    const { serial, remoteRoot } = parseAdbRoot(rootPath);
    const remote = remoteJoin(remoteRoot, relativePath);
    await adb(this.run, ["-s", serial, "shell", `rm -f ${quoteShell(remote)}`]);
  }
}
