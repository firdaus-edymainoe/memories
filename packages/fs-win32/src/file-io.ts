import { kindFromName, mimeFromName, relativeInsideRoot, type DirEntry, type FileIO, type FileStat } from "@memories/core";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { constants } from "node:fs";
import { access, copyFile, mkdir, readdir, readFile, realpath, stat, unlink } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";

function resolveInside(rootPath: string, relativePath: string) {
  const rel = relativeInsideRoot(relativePath);
  const rootAbs = resolve(rootPath);
  const abs = rel ? resolve(rootAbs, rel) : rootAbs;
  const prefix = rootAbs.endsWith(sep) ? rootAbs : rootAbs + sep;
  if (abs !== rootAbs && !abs.startsWith(prefix)) throw new Error("Path escapes drive root");
  return abs;
}

function inside(rootReal: string, candidate: string) {
  const prefix = rootReal.endsWith(sep) ? rootReal : rootReal + sep;
  return candidate === rootReal || candidate.startsWith(prefix);
}

/**
 * Like resolveInside, but also follows symlinks: the real location of the path (or of its nearest
 * existing parent, for paths about to be created) must stay inside the real root.
 */
async function containedPath(rootPath: string, relativePath: string) {
  const abs = resolveInside(rootPath, relativePath);
  const rootReal = await realpath(resolve(rootPath));
  let probe = abs;
  for (;;) {
    try {
      const real = await realpath(probe);
      if (!inside(rootReal, real)) throw new Error("Path escapes drive root");
      return abs;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = dirname(probe);
      if (parent === probe || probe === resolve(rootPath)) throw error;
      probe = parent;
    }
  }
}

export class NodeFileIO implements FileIO {
  async walk(rootPath: string, subPath = ""): Promise<FileStat[]> {
    const start = await containedPath(rootPath, subPath);
    const out: FileStat[] = [];
    // The folder being indexed must be readable; otherwise we would mistake it for empty.
    await readdir(start);
    await walkDir(start, resolve(rootPath), out);
    return out;
  }

  async list(rootPath: string, subPath = ""): Promise<DirEntry[]> {
    const start = await containedPath(rootPath, subPath).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    });
    if (!start) return [];
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
    const abs = await containedPath(rootPath, relativePath);
    const hash = createHash("sha256");
    const stream = createReadStream(abs);
    for await (const chunk of stream) hash.update(chunk);
    return hash.digest("hex");
  }

  async read(rootPath: string, relativePath: string) {
    return readFile(await containedPath(rootPath, relativePath));
  }

  async exists(rootPath: string, relativePath: string) {
    try {
      await access(await containedPath(rootPath, relativePath));
      return true;
    } catch {
      return false;
    }
  }

  async mkdir(rootPath: string, relativePath: string) {
    await mkdir(await containedPath(rootPath, relativePath), { recursive: true });
  }

  async copy(args: Parameters<FileIO["copy"]>[0]) {
    const from = await containedPath(args.fromRoot, args.fromRelative);
    const to = await containedPath(args.toRoot, args.toRelative);
    await mkdir(dirname(to), { recursive: true });
    // Never replace an existing file: the use cases decide what to do with name clashes.
    await copyFile(from, to, constants.COPYFILE_EXCL);
    args.onProgress?.(1);
  }

  async remove(rootPath: string, relativePath: string) {
    await unlink(await containedPath(rootPath, relativePath));
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
    });
  }
}
