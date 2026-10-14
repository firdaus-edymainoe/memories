import { mimeFromName } from "@memories/core";
import type { Thumbnailable } from "@memories/server";
import { nativeImage } from "electron";
import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

const SIZE = { width: 512, height: 512 };
/** Longest edge of a stored preview, in pixels: sharp on high-DPI screens, still small. */
const MAX_EDGE = 640;
/** Originals this small are cheaper to show as they are. */
const SMALL_ORIGINAL_BYTES = 200 * 1024;

function previewable(name: string) {
  const mime = mimeFromName(name);
  return mime.startsWith("image/") || mime.startsWith("video/") || mime === "application/pdf";
}

/**
 * Previews from the operating system (QuickLook on macOS, the Shell on Windows), so HEIC photos,
 * videos and PDFs get thumbnails without bundling decoders. Cached on disk: by content hash for
 * library files, by size + modification time for files browsed on a drive.
 */
export function createOsThumbnails(cacheDirectory: string) {
  return async ({ rootPath, relativePath, cacheKey }: Thumbnailable) => {
    // Phones are reached through mtp:// or adb:// roots; only local folders have a path to preview.
    if (!isAbsolute(rootPath) || !previewable(relativePath)) return null;
    const root = resolve(rootPath);
    const file = resolve(root, ...relativePath.split("/"));
    const inside = relative(root, file);
    if (!inside || inside.startsWith("..") || inside.startsWith(sep)) return null;

    const info = await stat(file);
    if (info.size <= SMALL_ORIGINAL_BYTES && mimeFromName(relativePath).startsWith("image/")) return null;
    const key = createHash("sha256")
      .update(cacheKey ?? `${file}:${info.size}:${info.mtimeMs}`)
      .digest("hex");
    const cached = join(cacheDirectory, key.slice(0, 2), `${key}.jpg`);
    const hit = await readFile(cached).catch(() => null);
    if (hit) return { bytes: new Uint8Array(hit), mime: "image/jpeg" };

    let image = await nativeImage.createThumbnailFromPath(file, SIZE);
    if (image.isEmpty()) return null;
    const { width, height } = image.getSize();
    if (Math.max(width, height) > MAX_EDGE) {
      image = image.resize(width >= height ? { width: MAX_EDGE, quality: "good" } : { height: MAX_EDGE, quality: "good" });
    }
    const bytes = image.toJPEG(80);
    await mkdir(join(cacheDirectory, key.slice(0, 2)), { recursive: true });
    await writeFile(cached, bytes);
    return { bytes: new Uint8Array(bytes), mime: "image/jpeg" };
  };
}
