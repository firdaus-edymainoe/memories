import { MemoriesError } from "./errors.js";

/**
 * Normalize and reject paths that would leave a drive root.
 * Pure string rules — core must not import Node `path`.
 */
export function relativeInsideRoot(relativePath: string): string {
  const parts = relativePath.split(/[/\\]/).filter((part) => part.length > 0 && part !== ".");
  if (parts.some((part) => part === "..")) {
    throw new MemoriesError("Path escapes drive root", 400);
  }
  return parts.join("/");
}

export function childRelative(parent: string, name: string): string {
  const root = relativeInsideRoot(parent);
  const leaf = relativeInsideRoot(name);
  if (!root) return leaf;
  return `${root}/${leaf}`;
}

export function parentRelative(relativePath: string): string {
  const rel = relativeInsideRoot(relativePath);
  const i = rel.lastIndexOf("/");
  if (i < 0) return "";
  return rel.slice(0, i);
}

/** True for absolute local paths (POSIX, Windows drive or UNC) and phone URIs. */
export function isAbsoluteRoot(path: string): boolean {
  return /^\//.test(path) || /^[A-Za-z]:[\\/]/.test(path) || /^\\\\[^\\]+\\/.test(path) || /^(mtp|adb):\/\//.test(path);
}
