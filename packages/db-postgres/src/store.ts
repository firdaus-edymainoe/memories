import {
  type CloudCatalogStore,
  type CloudDevice,
  type DriveKind,
  type FileKind,
  type ReplicaStatus,
  type SyncBatch,
  type SyncEntity,
  type SyncRecord,
  syncKey,
} from "@memories/core";
import { type SQL, and, eq, getTableColumns, or, sql } from "drizzle-orm";
import type { PgColumn, PgDatabase, PgQueryResultHKT, PgTable } from "drizzle-orm/pg-core";
import * as schema from "./schema.js";

type Db = PgDatabase<PgQueryResultHKT, typeof schema>;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type Row = Record<string, unknown>;
type Key = SyncRecord["key"];

/**
 * How one synced entity maps onto its table. Keeps the per-table detail in one place so storing,
 * deleting and reading back are the same code for every entity.
 */
type Mapping = {
  table: PgTable & { userId: PgColumn; deviceId: PgColumn };
  /** Primary-key columns after the owner columns, in the record's key order. */
  keyColumns: PgColumn[];
  toRow(data: NonNullable<SyncRecord["data"]>): Row;
  fromRow(row: Row): SyncRecord;
};

const MAPPINGS: Record<SyncEntity, Mapping> = {
  drive: {
    table: schema.drives,
    keyColumns: [schema.drives.id],
    toRow: (data) => ({ ...(data as Row) }),
    fromRow: (row) => {
      const r = row as typeof schema.drives.$inferSelect;
      return {
        entity: "drive",
        key: [r.id],
        data: { id: r.id, name: r.name, kind: r.kind as DriveKind, rootPath: r.rootPath, volumeId: r.volumeId, online: r.online },
      };
    },
  },
  object: {
    table: schema.objects,
    keyColumns: [schema.objects.hash],
    toRow: (data) => ({ ...(data as Row) }),
    fromRow: (row) => {
      const r = row as typeof schema.objects.$inferSelect;
      return { entity: "object", key: [r.hash], data: { hash: r.hash, size: r.size, mime: r.mime } };
    },
  },
  file: {
    table: schema.files,
    keyColumns: [schema.files.id],
    toRow: (data) => ({ ...(data as Row), trashedAt: (data as { trashedAt?: string | null }).trashedAt ?? null }),
    fromRow: (row) => {
      const r = row as typeof schema.files.$inferSelect;
      return {
        entity: "file",
        key: [r.id],
        data: {
          id: r.id,
          objectHash: r.objectHash,
          name: r.name,
          kind: r.kind as FileKind,
          takenAt: r.takenAt,
          place: r.place,
          inbox: r.inbox,
          trashedAt: r.trashedAt,
        },
      };
    },
  },
  replica: {
    table: schema.replicas,
    keyColumns: [schema.replicas.driveId, schema.replicas.relativePath],
    toRow: (data) => {
      const d = data as Extract<SyncRecord, { entity: "replica" }>["data"] & object;
      return {
        driveId: d.driveId,
        relativePath: d.relativePath,
        fileId: d.fileId,
        status: d.status,
        progress: d.progress,
        size: d.size ?? null,
        modifiedAt: d.modifiedAt ?? null,
        objectHash: d.objectHash ?? null,
      };
    },
    fromRow: (row) => {
      const r = row as typeof schema.replicas.$inferSelect;
      return {
        entity: "replica",
        key: [r.driveId, r.relativePath],
        data: {
          fileId: r.fileId,
          driveId: r.driveId,
          relativePath: r.relativePath,
          status: r.status as ReplicaStatus,
          progress: r.progress,
          size: r.size,
          modifiedAt: r.modifiedAt,
          objectHash: r.objectHash,
        },
      };
    },
  },
  folder: {
    table: schema.folders,
    keyColumns: [schema.folders.id],
    toRow: (data) => ({ ...(data as Row) }),
    fromRow: (row) => {
      const r = row as typeof schema.folders.$inferSelect;
      return { entity: "folder", key: [r.id], data: { id: r.id, name: r.name, parentId: r.parentId } };
    },
  },
  fileFolder: {
    table: schema.fileFolders,
    keyColumns: [schema.fileFolders.fileId],
    toRow: (data) => ({ ...(data as Row) }),
    fromRow: (row) => {
      const r = row as typeof schema.fileFolders.$inferSelect;
      return { entity: "fileFolder", key: [r.fileId], data: { fileId: r.fileId, folderId: r.folderId } };
    },
  },
  version: {
    table: schema.fileVersions,
    keyColumns: [schema.fileVersions.fileId, schema.fileVersions.version],
    toRow: (data) => ({ ...(data as Row) }),
    fromRow: (row) => {
      const r = row as typeof schema.fileVersions.$inferSelect;
      return {
        entity: "version",
        key: [r.fileId, r.version],
        data: { fileId: r.fileId, version: r.version, objectHash: r.objectHash, size: r.size, createdAt: r.createdAt },
      };
    },
  },
  backupJob: {
    table: schema.backupJobs,
    keyColumns: [schema.backupJobs.id],
    toRow: (data) => {
      const d = data as Extract<SyncRecord, { entity: "backupJob" }>["data"] & object;
      return {
        id: d.id,
        sourceDriveId: d.sourceDriveId,
        destDriveId: d.destDriveId,
        sourceRelativePaths: d.sourceRelativePaths,
        lastRunAt: d.lastRunAt,
        auto: d.auto ?? false,
      };
    },
    fromRow: (row) => {
      const r = row as typeof schema.backupJobs.$inferSelect;
      return {
        entity: "backupJob",
        key: [r.id],
        data: {
          id: r.id,
          sourceDriveId: r.sourceDriveId,
          destDriveId: r.destDriveId,
          sourceRelativePaths: r.sourceRelativePaths,
          lastRunAt: r.lastRunAt,
          auto: r.auto,
        },
      };
    },
  },
};

const CHUNK = 500;

function chunks<T>(items: T[], size = CHUNK) {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function toDevice(row: typeof schema.devices.$inferSelect): CloudDevice {
  return {
    id: row.id,
    name: row.name,
    platform: row.platform,
    createdAt: row.createdAt.toISOString(),
    lastSyncedAt: row.lastSyncedAt?.toISOString() ?? null,
  };
}

/** Every device's catalog in PostgreSQL (see `CloudCatalogStore`). */
export class PostgresCatalogStore implements CloudCatalogStore {
  constructor(private readonly db: Db) {}

  async registerDevice(userId: string, device: { id: string; name: string; platform: string }) {
    const [row] = await this.db
      .insert(schema.devices)
      .values({ userId, ...device })
      .onConflictDoUpdate({
        target: [schema.devices.userId, schema.devices.id],
        set: { name: device.name, platform: device.platform },
      })
      .returning();
    return toDevice(row!);
  }

  async listDevices(userId: string) {
    const rows = await this.db.select().from(schema.devices).where(eq(schema.devices.userId, userId));
    return rows.map(toDevice);
  }

  async apply(userId: string, batch: SyncBatch) {
    // The latest record per key wins, as it would have locally.
    const latest = new Map<string, SyncRecord>();
    for (const record of batch.records) {
      if (!MAPPINGS[record.entity]) throw new Error(`Unknown entity ${JSON.stringify(record.entity)}`);
      latest.set(syncKey(record), record);
    }

    await this.db.transaction(async (tx) => {
      await tx
        .insert(schema.devices)
        .values({ userId, id: batch.deviceId, name: "This device", platform: "unknown", lastSyncedAt: new Date() })
        .onConflictDoUpdate({ target: [schema.devices.userId, schema.devices.id], set: { lastSyncedAt: new Date() } });

      if (batch.replace) {
        for (const mapping of Object.values(MAPPINGS)) {
          await tx.delete(mapping.table).where(this.owned(mapping, userId, batch.deviceId));
        }
      }

      for (const [entity, mapping] of Object.entries(MAPPINGS) as Array<[SyncEntity, Mapping]>) {
        const records = [...latest.values()].filter((record) => record.entity === entity);
        await this.remove(tx, mapping, userId, batch.deviceId, records.filter((record) => record.data === null).map((r) => r.key));
        await this.upsert(tx, mapping, userId, batch.deviceId, records.flatMap((record) => (record.data ? [record.data] : [])));
      }
    });
  }

  async snapshot(userId: string, deviceId: string) {
    const records: SyncRecord[] = [];
    for (const mapping of Object.values(MAPPINGS)) {
      const rows = (await this.db.select().from(mapping.table).where(this.owned(mapping, userId, deviceId))) as Row[];
      records.push(...rows.map((row) => mapping.fromRow(row)));
    }
    return records;
  }

  async removeDevice(userId: string, deviceId: string) {
    await this.db.delete(schema.devices).where(and(eq(schema.devices.userId, userId), eq(schema.devices.id, deviceId)));
  }

  async removeUser(userId: string) {
    await this.db.delete(schema.devices).where(eq(schema.devices.userId, userId));
  }

  private owned(mapping: Mapping, userId: string, deviceId: string) {
    return and(eq(mapping.table.userId, userId), eq(mapping.table.deviceId, deviceId))!;
  }

  private async upsert(tx: Tx, mapping: Mapping, userId: string, deviceId: string, items: Array<NonNullable<SyncRecord["data"]>>) {
    if (items.length === 0) return;
    const keyNames = new Set(mapping.keyColumns.map((column) => column.name));
    const properties: string[] = [];
    // On conflict, take every non-key column from the incoming row.
    const set: Record<string, SQL> = {};
    for (const [property, column] of Object.entries(getTableColumns(mapping.table))) {
      if (property === "userId" || property === "deviceId") continue;
      properties.push(property);
      if (!keyNames.has(column.name)) set[property] = sql.raw(`excluded."${column.name}"`);
    }
    // Only known columns, and the owner always last: a device can never write another's rows.
    const row = (data: NonNullable<SyncRecord["data"]>) => {
      const mapped = mapping.toRow(data);
      return { ...Object.fromEntries(properties.map((property) => [property, mapped[property] ?? null])), userId, deviceId };
    };
    for (const part of chunks(items)) {
      await tx
        .insert(mapping.table)
        .values(part.map(row))
        .onConflictDoUpdate({ target: [mapping.table.userId, mapping.table.deviceId, ...mapping.keyColumns], set });
    }
  }

  private async remove(tx: Tx, mapping: Mapping, userId: string, deviceId: string, keys: Key[]) {
    for (const part of chunks(keys)) {
      const matches = part.map((key) => and(...mapping.keyColumns.map((column, index) => eq(column, key[index]!)))!);
      await tx.delete(mapping.table).where(and(this.owned(mapping, userId, deviceId), or(...matches)));
    }
  }
}
