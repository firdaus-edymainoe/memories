import type { FileKind } from "./domain.js";

export function kindFromName(name: string): FileKind {
  const lower = name.toLowerCase();
  const dot = lower.lastIndexOf(".");
  const ext = dot >= 0 ? lower.slice(dot + 1) : "";
  if (["jpg", "jpeg", "png", "gif", "webp", "heic", "heif"].includes(ext)) return "photo";
  if (["mp4", "mov", "m4v", "webm"].includes(ext)) return "video";
  return "document";
}

const MIME_BY_EXT: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  heic: "image/heic",
  heif: "image/heif",
  mp4: "video/mp4",
  mov: "video/quicktime",
  m4v: "video/x-m4v",
  webm: "video/webm",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  wav: "audio/wav",
  aac: "audio/aac",
  pdf: "application/pdf",
  txt: "text/plain",
  md: "text/plain",
  json: "application/json",
  csv: "text/csv",
};

export function mimeFromName(name: string): string {
  const lower = name.toLowerCase();
  const dot = lower.lastIndexOf(".");
  const ext = dot >= 0 ? lower.slice(dot + 1) : "";
  if (MIME_BY_EXT[ext]) return MIME_BY_EXT[ext];
  const kind = kindFromName(name);
  if (kind === "photo") return "image/jpeg";
  if (kind === "video") return "video/mp4";
  return "application/octet-stream";
}

export function dayFromTakenAt(takenAt: string | null): string | null {
  if (!takenAt) return null;
  return takenAt.slice(0, 10);
}
