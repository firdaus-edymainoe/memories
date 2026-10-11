import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, utimes, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { REPO } from "./env.js";

const HELLO_JPG = readFileSync(join(REPO, "fixtures", "hello.jpg"));

/** A real, decodable JPEG with a unique tail so every photo has its own content hash. */
export function jpeg(seed: string) {
  return Buffer.concat([HELLO_JPG, Buffer.from(`\n<!-- ${seed} -->`)]);
}

/** Not a playable video; the app treats it by extension. */
export function mp4(seed: string, size = 64) {
  const head = Buffer.from([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x70, 0x34, 0x32]);
  return Buffer.concat([head, Buffer.alloc(Math.max(0, size - head.length - seed.length), 0), Buffer.from(seed)]);
}

export function pdf(seed: string) {
  return Buffer.from(`%PDF-1.4\n% ${seed}\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n`);
}

export function text(seed: string) {
  return Buffer.from(`${seed}\n`);
}

export function sha256(bytes: Buffer | string) {
  return createHash("sha256").update(bytes).digest("hex");
}

export type FileSpec = Buffer | string | { bytes: Buffer | string; mtime?: string };

/** Default file date: well before the frozen browser clock. */
export const DEFAULT_MTIME = "2025-08-12T19:40:00+08:00";

/** Write a folder tree. Keys are relative paths ("Wedding/first-dance.jpg"); dates are pinned. */
export async function writeTree(root: string, files: Record<string, FileSpec>) {
  await mkdir(root, { recursive: true });
  for (const [rel, spec] of Object.entries(files)) {
    const abs = join(root, ...rel.split("/"));
    await mkdir(dirname(abs), { recursive: true });
    const { bytes, mtime } =
      typeof spec === "string" || Buffer.isBuffer(spec) ? { bytes: spec, mtime: undefined } : spec;
    await writeFile(abs, bytes);
    const when = new Date(mtime ?? DEFAULT_MTIME);
    await utimes(abs, when, when);
  }
  return root;
}

/** A small family library used by most specs. */
export function familyPictures(): Record<string, FileSpec> {
  return {
    "Wedding/First dance.jpg": { bytes: jpeg("first-dance"), mtime: "2025-08-12T19:40:00+08:00" },
    "Wedding/Garden vows.jpg": { bytes: jpeg("garden-vows"), mtime: "2025-08-12T16:05:00+08:00" },
    "Wedding/Speeches.mp4": { bytes: mp4("speeches"), mtime: "2025-08-12T20:30:00+08:00" },
    "Langkawi 2025/Beach morning.jpg": { bytes: jpeg("beach"), mtime: "2025-12-26T08:10:00+08:00" },
    "Langkawi 2025/Flight tickets.pdf": { bytes: pdf("flight"), mtime: "2025-11-30T09:00:00+08:00" },
    "School/School report 2026.pdf": { bytes: pdf("report"), mtime: "2026-06-20T12:00:00+08:00" },
    "Budget 2026.xlsx": { bytes: text("budget"), mtime: "2026-01-03T20:00:00+08:00" },
    "notes.txt": { bytes: text("A document on this drive."), mtime: "2025-09-01T09:00:00+08:00" },
  };
}
