import type { FileDetails } from "@memories/core";
import exifr from "exifr";
import { parseFile } from "music-metadata";

const PHOTO = /\.(jpe?g|heic|heif|tiff?|png|webp|avif|dng|cr2|nef|arw|orf|rw2|raf)$/i;
const VIDEO = /\.(mp4|m4v|mov|3gp)$/i;

function validDate(value: unknown): Date | null {
  const date = value instanceof Date ? value : typeof value === "string" ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) return null;
  // Cameras with an unset clock write 1970/2000-era dates; treat those as unknown.
  return date.getFullYear() >= 1990 ? date : null;
}

/** Capture date from EXIF (photos) or the container header (videos). Best effort, never throws. */
export async function readDetails(absolutePath: string): Promise<FileDetails> {
  try {
    if (PHOTO.test(absolutePath)) {
      const exif = await exifr.parse(absolutePath, {
        pick: ["DateTimeOriginal", "CreateDate"],
        reviveValues: true,
      });
      const takenAt = validDate(exif?.DateTimeOriginal) ?? validDate(exif?.CreateDate);
      return takenAt ? { takenAt: takenAt.toISOString() } : {};
    }
    if (VIDEO.test(absolutePath)) {
      const { format } = await parseFile(absolutePath, { duration: false, skipCovers: true });
      const takenAt = validDate(format.creationTime);
      return takenAt ? { takenAt: takenAt.toISOString() } : {};
    }
  } catch {
    // Corrupt or unusual files simply keep their file-system date.
  }
  return {};
}
