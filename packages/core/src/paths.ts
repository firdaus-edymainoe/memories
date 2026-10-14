/**
 * Normalize and reject paths that would leave a drive root.
 * Pure string rules — core must not import Node `path`.
 */
export function relativeInsideRoot(relativePath: string): string {
  const parts = relativePath.split(/[/\\]/).filter((part) => part.length > 0 && part !== ".");
  if (parts.some((part) => part === "..")) {
    throw new Error("Path escapes drive root");
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

/** `photo.jpg` + 2 → `photo (2).jpg`, keeping any folder part. */
export function withCollisionSuffix(relativePath: string, attempt: number): string {
  const rel = relativeInsideRoot(relativePath);
  if (attempt <= 1) return rel;
  const slash = rel.lastIndexOf("/");
  const folder = slash >= 0 ? rel.slice(0, slash + 1) : "";
  const name = rel.slice(slash + 1);
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return `${folder}${name} (${attempt})`;
  return `${folder}${name.slice(0, dot)} (${attempt})${name.slice(dot)}`;
}
