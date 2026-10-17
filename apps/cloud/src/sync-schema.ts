import type { SyncBatch } from "@memories/core";
import * as z from "zod";

/** What a device may send. Anything else is refused before it reaches the database. */

const id = z.string().min(1).max(200);
const text = z.string().max(4096);
const nullableText = text.nullable();
const size = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

const drive = z.object({
  id,
  name: text,
  kind: z.enum(["computer", "disk", "usb", "phone", "cloud"]),
  rootPath: text,
  volumeId: text,
  online: z.boolean(),
});
const object = z.object({ hash: id, size, mime: z.string().max(255) });
const file = z.object({
  id,
  objectHash: id,
  name: text,
  kind: z.enum(["photo", "video", "document"]),
  takenAt: nullableText,
  place: nullableText,
  inbox: z.boolean(),
  trashedAt: nullableText.optional(),
});
const replica = z.object({
  fileId: id,
  driveId: id,
  relativePath: text,
  status: z.enum(["ready", "copying"]),
  progress: z.number().int().min(0).max(100).nullable(),
  size: size.nullable().optional(),
  modifiedAt: nullableText.optional(),
  objectHash: id.nullable().optional(),
});
const folder = z.object({ id, name: text, parentId: id.nullable() });
const fileFolder = z.object({ fileId: id, folderId: id });
const version = z.object({ fileId: id, version: z.number().int().positive(), objectHash: id, size, createdAt: text });
const backupJob = z.object({
  id,
  sourceDriveId: id,
  destDriveId: id,
  sourceRelativePaths: z.array(text).max(1000),
  lastRunAt: nullableText,
  auto: z.boolean().optional(),
});

const record = z.discriminatedUnion("entity", [
  z.object({ entity: z.literal("drive"), key: z.tuple([id]), data: drive.nullable() }),
  z.object({ entity: z.literal("object"), key: z.tuple([id]), data: object.nullable() }),
  z.object({ entity: z.literal("file"), key: z.tuple([id]), data: file.nullable() }),
  z.object({ entity: z.literal("replica"), key: z.tuple([id, text]), data: replica.nullable() }),
  z.object({ entity: z.literal("folder"), key: z.tuple([id]), data: folder.nullable() }),
  z.object({ entity: z.literal("fileFolder"), key: z.tuple([id]), data: fileFolder.nullable() }),
  z.object({ entity: z.literal("version"), key: z.tuple([id, z.number().int().positive()]), data: version.nullable() }),
  z.object({ entity: z.literal("backupJob"), key: z.tuple([id]), data: backupJob.nullable() }),
]);

export const MAX_BATCH_RECORDS = 1000;

export const syncBatchSchema = z.object({
  deviceId: id,
  replace: z.boolean(),
  records: z.array(record).max(MAX_BATCH_RECORDS),
});

/** The key must name the row the data is for, or a device could write one row under another's key. */
function keyMatches(r: z.infer<typeof record>) {
  if (!r.data) return true;
  switch (r.entity) {
    case "drive":
    case "file":
    case "folder":
    case "backupJob":
      return r.key[0] === r.data.id;
    case "object":
      return r.key[0] === r.data.hash;
    case "replica":
      return r.key[0] === r.data.driveId && r.key[1] === r.data.relativePath;
    case "fileFolder":
      return r.key[0] === r.data.fileId;
    case "version":
      return r.key[0] === r.data.fileId && r.key[1] === r.data.version;
  }
}

export function parseSyncBatch(input: unknown): SyncBatch {
  const batch = syncBatchSchema.parse(input);
  const bad = batch.records.findIndex((r) => !keyMatches(r));
  if (bad >= 0) throw new Error(`Record ${bad} has a key that does not match its data`);
  return batch as SyncBatch;
}
