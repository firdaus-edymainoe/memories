import {
  type ByteRange,
  DestinationExistsError,
  kindFromName,
  mimeFromName,
  relativeInsideRoot,
  type DirEntry,
  type FileIO,
  type FileStat,
} from "@memories/core";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, copyFile, mkdir, open, readdir, readFile, rename, rm, stat, unlink } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { readDetails } from "./details.js";

function resolveInside(rootPath: string, relativePath: string) {
  const rel = relativeInsideRoot(relativePath);
  const rootAbs = resolve(rootPath);
  const abs = rel ? resolve(rootAbs, rel) : rootAbs;
  const prefix = rootAbs.endsWith(sep) ? rootAbs : rootAbs + sep;
  if (abs !== rootAbs && !abs.startsWith(prefix)) throw new Error("Path escapes drive root");
  return abs;
}

export class NodeFileIO implements FileIO {
  async walk(rootPath: string, subPath = ""): Promise<FileStat[]> {
    const start = resolveInside(rootPath, subPath);
    const out: FileStat[] = [];
    await walkDir(start, resolve(rootPath), out);
    return out;
  }

  async list(rootPath: string, subPath = ""): Promise<DirEntry[]> {
    const start = resolveInside(rootPath, subPath);
    const prefix = relativeInsideRoot(subPath);
    let entries;
    try {
      entries = await readdir(start, { withFileTypes: true });
    } catch {
      return [];
    }
    const out: DirEntry[] = [];
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        out.push({ name: entry.name, relativePath, directory: true, size: 0, kind: null });
        continue;
      }
      if (!entry.isFile()) continue;
      const info = await stat(join(start, entry.name));
      out.push({
        name: entry.name,
        relativePath,
        directory: false,
        size: info.size,
        kind: kindFromName(entry.name),
      });
    }
    return out.sort((a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name));
  }

  async hash(rootPath: string, relativePath: string) {
    const abs = resolveInside(rootPath, relativePath);
    const hash = createHash("sha256");
    const stream = createReadStream(abs);
    for await (const chunk of stream) hash.update(chunk);
    return hash.digest("hex");
  }

  async read(rootPath: string, relativePath: string) {
    return readFile(resolveInside(rootPath, relativePath));
  }

  describe(rootPath: string, relativePath: string) {
    return readDetails(resolveInside(rootPath, relativePath));
  }

  async size(rootPath: string, relativePath: string) {
    return (await stat(resolveInside(rootPath, relativePath))).size;
  }

  async stream(rootPath: string, relativePath: string, range?: ByteRange) {
    const abs = resolveInside(rootPath, relativePath);
    await stat(abs);
    const nodeStream = createReadStream(abs, range ? { start: range.start, end: range.end } : {});
    return Readable.toWeb(nodeStream) as ReadableStream<Uint8Array>;
  }

  async exists(rootPath: string, relativePath: string) {
    try {
      await access(resolveInside(rootPath, relativePath));
      return true;
    } catch {
      return false;
    }
  }

  async mkdir(rootPath: string, relativePath: string) {
    await mkdir(resolveInside(rootPath, relativePath), { recursive: true });
  }

  /**
   * Never overwrites and never leaves a half-written file behind: the name is reserved with an
   * exclusive create, the bytes go to a temp file beside it, and a rename swaps it in. Only plain
   * file operations are used, so it also works on exFAT/FAT32 drives.
   */
  async copy(args: Parameters<FileIO["copy"]>[0]) {
    const from = resolveInside(args.fromRoot, args.fromRelative);
    const to = resolveInside(args.toRoot, args.toRelative);
    await mkdir(dirname(to), { recursive: true });

    try {
      await (await open(to, "wx")).close();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new DestinationExistsError(relativeInsideRoot(args.toRelative));
      }
      throw error;
    }

    const temp = join(dirname(to), `.${basename(to)}.${randomUUID()}.part`);
    try {
      await copyFile(from, temp);
      await rename(temp, to);
    } catch (error) {
      await rm(temp, { force: true });
      await rm(to, { force: true });
      throw error;
    }
    args.onProgress?.(1);
  }

  async remove(rootPath: string, relativePath: string) {
    await unlink(resolveInside(rootPath, relativePath));
  }
}

async function walkDir(current: string, rootAbs: string, out: FileStat[]) {
  let entries;
  try {
    entries = await readdir(current, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const abs = join(current, entry.name);
    if (entry.isDirectory()) {
      await walkDir(abs, rootAbs, out);
      continue;
    }
    if (!entry.isFile()) continue;
    const info = await stat(abs);
    const relativePath = abs.slice(rootAbs.length).replace(/^[/\\]/, "").replaceAll("\\", "/");
    out.push({
      relativePath,
      size: info.size,
      mime: mimeFromName(entry.name),
      kind: kindFromName(entry.name),
      takenAt: info.mtime.toISOString(),
      place: null,
      modifiedAt: info.mtime.toISOString(),
    });
  }
}
