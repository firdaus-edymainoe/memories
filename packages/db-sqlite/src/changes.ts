import type { CatalogChangeFeed, ChangeBatch, FileVersion, SyncEntity, SyncRecord, VirtualFolder } from "@memories/core";
import { and, eq } from "drizzle-orm";
import type { SqliteRemoteDatabase } from "drizzle-orm/sqlite-proxy";
import type { DatabaseSync } from "node:sqlite";
import { toDrive, toFile, toJob, toReplica } from "./rows.js";
import * as schema from "./schema.js";

/** Which catalog tables are synced, how a row is keyed, and which columns count as a change. */
const TRACKED: ReadonlyArray<{ entity: SyncEntity; table: string; key: string[]; columns: string[] }> = [
  { entity: "drive", table: "drives", key: ["id"], columns: ["name", "kind", "root_path", "volume_id", "online"] },
  { entity: "object", table: "objects", key: ["hash"], columns: ["size", "mime"] },
  {
    entity: "file",
    table: "files",
    key: ["id"],
    columns: ["object_hash", "name", "kind", "taken_at", "place", "inbox", "trashed_at"],
  },
  // Copy progress changes many times a second; the finished copy is what the cloud needs.
  {
    entity: "replica",
    table: "replicas",
    key: ["drive_id", "relative_path"],
    columns: ["file_id", "status", "size", "modified_at", "object_hash"],
  },
  { entity: "folder", table: "virtual_folders", key: ["id"], columns: ["name", "parent_id"] },
  { entity: "fileFolder", table: "file_folders", key: ["file_id"], columns: ["folder_id"] },
  { entity: "version", table: "file_versions", key: ["file_id", "version"], columns: ["object_hash", "size", "created_at"] },
  {
    entity: "backupJob",
    table: "backup_jobs",
    key: ["id"],
    columns: ["source_drive_id", "dest_drive_id", "source_relative_paths", "last_run_at", "auto"],
  },
];

function keyExpression(row: "NEW" | "OLD" | null, key: string[]) {
  return `json_array(${key.map((column) => (row ? `${row}.${column}` : column)).join(", ")})`;
}

// An upsert, not `INSERT OR REPLACE`: inside a trigger the outer statement's conflict rule wins.
function record(entity: SyncEntity, key: string) {
  return `UPDATE sync_state SET last_seq = last_seq + 1;
    INSERT INTO sync_changes (seq, entity, key) VALUES ((SELECT last_seq FROM sync_state), '${entity}', ${key})
      ON CONFLICT (entity, key) DO UPDATE SET seq = excluded.seq;`;
}

/**
 * Migration: a queue of changed rows, filled by triggers while sync is on. Triggers write the
 * queue in the same transaction as the change, so nothing is missed even if the app quits.
 * One entry per row (the latest change wins); `seq` only grows.
 */
export function installChangeTracking(sqlite: DatabaseSync) {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS sync_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      tracking INTEGER NOT NULL DEFAULT 0,
      replace_pending INTEGER NOT NULL DEFAULT 0,
      last_seq INTEGER NOT NULL DEFAULT 0
    );
    INSERT OR IGNORE INTO sync_state (id) VALUES (1);
    CREATE TABLE IF NOT EXISTS sync_changes (
      seq INTEGER NOT NULL,
      entity TEXT NOT NULL,
      key TEXT NOT NULL,
      PRIMARY KEY (entity, key)
    );
    CREATE INDEX IF NOT EXISTS sync_changes_seq ON sync_changes (seq);
  `);
  const on = "(SELECT tracking FROM sync_state) = 1";
  for (const { entity, table, key, columns } of TRACKED) {
    const changed = [...key, ...columns].map((column) => `OLD.${column} IS NOT NEW.${column}`).join(" OR ");
    sqlite.exec(`
      CREATE TRIGGER IF NOT EXISTS sync_${table}_insert AFTER INSERT ON ${table} WHEN ${on}
      BEGIN ${record(entity, keyExpression("NEW", key))} END;
      CREATE TRIGGER IF NOT EXISTS sync_${table}_update AFTER UPDATE ON ${table} WHEN ${on} AND (${changed})
      BEGIN ${record(entity, keyExpression("OLD", key))} ${record(entity, keyExpression("NEW", key))} END;
      CREATE TRIGGER IF NOT EXISTS sync_${table}_delete AFTER DELETE ON ${table} WHEN ${on}
      BEGIN ${record(entity, keyExpression("OLD", key))} END;
    `);
  }
}

type State = { tracking: number; replace_pending: number };

/** The catalog's outgoing changes for cloud sync (see `CatalogChangeFeed`). */
export class ChangeFeed implements CatalogChangeFeed {
  constructor(
    private readonly sqlite: DatabaseSync,
    private readonly db: SqliteRemoteDatabase<typeof schema>,
  ) {}

  private state() {
    return this.sqlite.prepare("SELECT tracking, replace_pending FROM sync_state WHERE id = 1").get() as State;
  }

  async isTracking() {
    return this.state().tracking === 1;
  }

  async pendingCount() {
    return (this.sqlite.prepare("SELECT COUNT(*) AS count FROM sync_changes").get() as { count: number }).count;
  }

  async start() {
    this.transaction(() => {
      this.sqlite.exec("DELETE FROM sync_changes; UPDATE sync_state SET tracking = 1, replace_pending = 1");
      for (const { entity, table, key } of TRACKED) {
        this.sqlite.exec(`
          INSERT INTO sync_changes (seq, entity, key)
            SELECT (SELECT last_seq FROM sync_state) + ROW_NUMBER() OVER (), '${entity}', ${keyExpression(null, key)} FROM ${table};
          UPDATE sync_state SET last_seq = MAX(last_seq, COALESCE((SELECT MAX(seq) FROM sync_changes), 0));
        `);
      }
    });
  }

  async stop() {
    this.transaction(() => {
      this.sqlite.exec("DELETE FROM sync_changes; UPDATE sync_state SET tracking = 0, replace_pending = 0");
    });
  }

  async read(limit: number): Promise<ChangeBatch> {
    const replace = this.state().replace_pending === 1;
    const rows = this.sqlite
      .prepare("SELECT seq, entity, key FROM sync_changes ORDER BY seq LIMIT ?")
      .all(limit) as Array<{ seq: number; entity: SyncEntity; key: string }>;
    const records: SyncRecord[] = [];
    for (const row of rows) records.push(await this.hydrate(row.entity, JSON.parse(row.key) as Array<string | number>));
    return { cursor: rows.at(-1)?.seq ?? 0, replace, records };
  }

  async acknowledge(cursor: number) {
    this.transaction(() => {
      this.sqlite.prepare("DELETE FROM sync_changes WHERE seq <= ?").run(cursor);
      this.sqlite.exec("UPDATE sync_state SET replace_pending = 0");
    });
  }

  private transaction(work: () => void) {
    this.sqlite.exec("BEGIN IMMEDIATE");
    try {
      work();
      this.sqlite.exec("COMMIT");
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
  }

  /** The row as it is now, or `null` if it is gone. */
  private async hydrate(entity: SyncEntity, key: Array<string | number>): Promise<SyncRecord> {
    const [a, b] = key as [string, string | number];
    switch (entity) {
      case "drive": {
        const [row] = await this.db.select().from(schema.drives).where(eq(schema.drives.id, a));
        return { entity, key: [a], data: row ? toDrive(row) : null };
      }
      case "object": {
        const [row] = await this.db.select().from(schema.objects).where(eq(schema.objects.hash, a));
        return { entity, key: [a], data: row ?? null };
      }
      case "file": {
        const [row] = await this.db.select().from(schema.files).where(eq(schema.files.id, a));
        return { entity, key: [a], data: row ? toFile(row) : null };
      }
      case "replica": {
        const relativePath = String(b);
        const [row] = await this.db
          .select()
          .from(schema.replicas)
          .where(and(eq(schema.replicas.driveId, a), eq(schema.replicas.relativePath, relativePath)));
        return { entity, key: [a, relativePath], data: row ? toReplica(row) : null };
      }
      case "folder": {
        const [row] = await this.db.select().from(schema.virtualFolders).where(eq(schema.virtualFolders.id, a));
        const data: VirtualFolder | null = row ? { id: row.id, name: row.name, parentId: row.parentId } : null;
        return { entity, key: [a], data };
      }
      case "fileFolder": {
        const [row] = await this.db.select().from(schema.fileFolders).where(eq(schema.fileFolders.fileId, a));
        return { entity, key: [a], data: row ?? null };
      }
      case "version": {
        const version = Number(b);
        const [row] = await this.db
          .select()
          .from(schema.fileVersions)
          .where(and(eq(schema.fileVersions.fileId, a), eq(schema.fileVersions.version, version)));
        const data: FileVersion | null = row ?? null;
        return { entity, key: [a, version], data };
      }
      case "backupJob": {
        const [row] = await this.db.select().from(schema.backupJobs).where(eq(schema.backupJobs.id, a));
        return { entity, key: [a], data: row ? toJob(row) : null };
      }
    }
  }
}
