import type { Drive, FileKind } from "@memories/core";

export type Family =
  | "photo"
  | "video"
  | "music"
  | "pdf"
  | "word"
  | "sheet"
  | "slides"
  | "text"
  | "code"
  | "archive"
  | "installer"
  | "other";

export type Shelf = "photos" | "videos" | "documents" | "music" | "apps" | "code" | "archives" | "other";

const EXT: Record<string, Family> = {};
function map(family: Family, exts: string) {
  for (const ext of exts.split(" ")) EXT[ext] = family;
}
map("photo", "jpg jpeg png gif webp heic heif bmp tif tiff dng cr2 cr3 nef arw raf orf svg avif");
map("video", "mp4 mov m4v webm avi mkv 3gp mts wmv");
map("music", "mp3 m4a wav aac ogg flac aiff opus");
map("pdf", "pdf");
map("word", "doc docx odt rtf pages");
map("sheet", "xls xlsx csv ods numbers tsv");
map("slides", "ppt pptx key odp");
map("text", "txt md markdown log");
map(
  "code",
  "js mjs cjs ts tsx jsx py rb go rs java kt swift c h cpp hpp cs php html htm css scss json yml yaml toml xml sh bash zsh ps1 sql ipynb",
);
map("archive", "zip rar 7z tar gz tgz bz2 xz");
map("installer", "dmg pkg exe msi apk appx msix deb rpm iso app");

export const FAMILY: Record<Family, { label: string; one: string; shelf: Shelf; tint: string }> = {
  photo: { label: "Photos", one: "Photo", shelf: "photos", tint: "#3F7A5A" },
  video: { label: "Videos", one: "Video", shelf: "videos", tint: "#3A6A8C" },
  music: { label: "Music & audio", one: "Audio", shelf: "music", tint: "#B54A82" },
  pdf: { label: "PDFs", one: "PDF", shelf: "documents", tint: "#C8433A" },
  word: { label: "Word documents", one: "Document", shelf: "documents", tint: "#2E68BE" },
  sheet: { label: "Spreadsheets", one: "Spreadsheet", shelf: "documents", tint: "#21845A" },
  slides: { label: "Presentations", one: "Presentation", shelf: "documents", tint: "#CB7119" },
  text: { label: "Notes & text", one: "Text", shelf: "documents", tint: "#6A7A71" },
  code: { label: "Code", one: "Code", shelf: "code", tint: "#6553CC" },
  archive: { label: "Zip files", one: "Zip file", shelf: "archives", tint: "#8B6A3E" },
  installer: { label: "Apps & installers", one: "Installer", shelf: "apps", tint: "#A87A4C" },
  other: { label: "Other files", one: "File", shelf: "other", tint: "#77867E" },
};

export const SHELF: Record<Shelf, { label: string; families: Family[] }> = {
  photos: { label: "Photos", families: ["photo"] },
  videos: { label: "Videos", families: ["video"] },
  documents: { label: "Documents", families: ["pdf", "word", "sheet", "slides", "text"] },
  music: { label: "Music & audio", families: ["music"] },
  apps: { label: "Apps & installers", families: ["installer"] },
  code: { label: "Code", families: ["code"] },
  archives: { label: "Zip files", families: ["archive"] },
  other: { label: "Other files", families: ["other"] },
};

export const SHELF_ORDER: Shelf[] = ["photos", "videos", "documents", "music", "apps", "code", "archives", "other"];

/** Always listed in the sidebar, even when empty. */
export const PRIMARY_SHELVES: Shelf[] = ["photos", "videos", "documents", "music"];

/** Only listed when the library has at least one matching file. */
export const EXTRA_SHELVES: Shelf[] = ["apps", "code", "archives", "other"];

/** Sidebar labels for document formats under the Documents accordion. */
export const DOC_NAV: { family: Family; label: string }[] = [
  { family: "pdf", label: "PDF" },
  { family: "word", label: "Word" },
  { family: "sheet", label: "Spreadsheets" },
  { family: "slides", label: "PowerPoint" },
  { family: "text", label: "Notes" },
];

export function fileExt(name: string) {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

export function familyOf(name: string, kind: FileKind | null): Family {
  const byExt = EXT[fileExt(name)];
  if (byExt) return byExt;
  if (kind === "photo") return "photo";
  if (kind === "video") return "video";
  return "other";
}

export function shelfOf(name: string, kind: FileKind | null): Shelf {
  return FAMILY[familyOf(name, kind)].shelf;
}

export function extLabel(name: string) {
  const ext = fileExt(name);
  return ext ? ext.slice(0, 4).toUpperCase() : "FILE";
}

export function monthKey(iso: string | null) {
  if (!iso) return "undated";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso.slice(0, 7) || "undated";
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

export function dayKey(iso: string | null) {
  if (!iso) return "undated";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso.slice(0, 10) || "undated";
  return `${monthKey(iso)}-${String(date.getDate()).padStart(2, "0")}`;
}

export function monthLabel(key: string) {
  if (key === "undated") return "No date";
  const date = new Date(`${key}-01T00:00:00`);
  if (Number.isNaN(date.getTime())) return key;
  return date.toLocaleString("en-GB", { month: "long", year: "numeric" });
}

export function dayLabel(key: string) {
  if (key === "undated") return "No date";
  const date = new Date(`${key}T00:00:00`);
  if (Number.isNaN(date.getTime())) return key;
  return date.toLocaleString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
}

export function shortDate(iso: string | null) {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

export function friendlySince(iso: string | null) {
  if (!iso) return "Not backed up yet";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "Backed up before";
  const days = Math.floor((Date.now() - then) / 86_400_000);
  if (days <= 0) return "Backed up today";
  if (days === 1) return "Backed up yesterday";
  if (days < 30) return `Backed up ${days} days ago`;
  return `Last backed up ${shortDate(iso)}`;
}

export function formatSize(bytes: number | undefined | null) {
  if (!bytes) return "";
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

export function plural(n: number, one: string, many = `${one}s`) {
  return `${n.toLocaleString("en-GB")} ${n === 1 ? one : many}`;
}

export function isPhonePath(path: string) {
  return path.startsWith("adb://") || path.startsWith("mtp://");
}

export function phoneFolderLabel(rootPath: string) {
  const folder = rootPath.replace(/^(mtp|adb):\/\/[^/]+\/?/, "");
  return folder ? folder.split("/").join(" › ") : "Whole phone";
}

export function pathLeaf(path: string) {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

export function placeWhere(drive: Drive) {
  if (drive.kind === "phone") {
    const folder = drive.rootPath.replace(/^(mtp|adb):\/\/[^/]+\/?/, "");
    return folder ? `${pathLeaf(folder)} folder` : "Whole phone";
  }
  if (/^\/Volumes\/[^/]+\/?$/.test(drive.rootPath) || /^[A-Za-z]:\\?$/.test(drive.rootPath)) return "Whole drive";
  return `${pathLeaf(drive.rootPath)} folder`;
}

export const PLACE_KIND: Record<Drive["kind"], { label: string; hint: string }> = {
  computer: { label: "This computer", hint: "A folder like Pictures or Documents" },
  disk: { label: "External drive", hint: "A hard drive or SSD you plug in" },
  usb: { label: "USB stick", hint: "A small memory stick" },
  phone: { label: "Android phone", hint: "Photos and files on your phone" },
};

export function placeStatus(drive: Drive) {
  if (drive.online) return drive.kind === "computer" ? "Ready" : "Plugged in";
  return drive.kind === "computer" ? "Can’t find this folder" : "Unplugged";
}
