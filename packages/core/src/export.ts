import type { Ports } from "./ports.js";
import { copyFileVerified, getFileDetail } from "./use-cases.js";

export type ExportResult = {
  exported: number;
  failed: Array<{ name: string; reason: string }>;
};

/**
 * Copies files out to a folder the user chose, for example to send them or restore them
 * somewhere else. Nothing in the folder is overwritten: a name already taken gets " (2)".
 * With `objectHash`, the copy is of that older version of a single file.
 */
export async function exportFiles(
  ports: Ports,
  input: { fileIds: string[]; rootPath: string; objectHash?: string },
): Promise<ExportResult> {
  const result: ExportResult = { exported: 0, failed: [] };

  for (const id of input.fileIds) {
    const detail = await getFileDetail(ports, id);
    if (!detail) continue;
    const name = detail.file.name;
    const wanted = input.objectHash ?? detail.file.objectHash;
    const copies =
      wanted === detail.file.objectHash
        ? detail.replicas
        : (detail.versions.find((version) => version.objectHash === wanted)?.copies ?? []);
    const source = copies.find((row) => row.drive.online && row.replica.status === "ready");
    if (!source) {
      const where = copies.map((row) => row.drive.name);
      result.failed.push({
        name,
        reason: where.length ? `Plug in ${where.join(" or ")} first` : "No copy of this file is left",
      });
      continue;
    }

    try {
      await copyFileVerified(ports, {
        fromRoot: source.drive.rootPath,
        fromRelative: source.replica.relativePath,
        toRoot: input.rootPath,
        toRelative: name,
        hash: wanted,
      });
      result.exported += 1;
    } catch (error) {
      result.failed.push({ name, reason: error instanceof Error ? error.message : "Couldn’t copy it" });
    }
  }

  return result;
}
