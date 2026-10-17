import { sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";

const owner = `
  user_id TEXT NOT NULL,
  device_id TEXT NOT NULL,`;
const ownedBy = `FOREIGN KEY (user_id, device_id) REFERENCES cloud_devices (user_id, id) ON DELETE CASCADE`;

/** Schema changes in order. Append only: never edit a step that has shipped. */
const MIGRATIONS: readonly string[] = [
  // 1: devices and their catalogs.
  `
  CREATE TABLE cloud_devices (
    user_id TEXT NOT NULL,
    id TEXT NOT NULL,
    name TEXT NOT NULL,
    platform TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_synced_at TIMESTAMPTZ,
    PRIMARY KEY (user_id, id)
  );
  CREATE TABLE catalog_drives (${owner}
    id TEXT NOT NULL,
    name TEXT NOT NULL,
    kind TEXT NOT NULL,
    root_path TEXT NOT NULL,
    volume_id TEXT NOT NULL,
    online BOOLEAN NOT NULL,
    PRIMARY KEY (user_id, device_id, id),
    ${ownedBy}
  );
  CREATE TABLE catalog_objects (${owner}
    hash TEXT NOT NULL,
    size BIGINT NOT NULL,
    mime TEXT NOT NULL,
    PRIMARY KEY (user_id, device_id, hash),
    ${ownedBy}
  );
  CREATE TABLE catalog_files (${owner}
    id TEXT NOT NULL,
    object_hash TEXT NOT NULL,
    name TEXT NOT NULL,
    kind TEXT NOT NULL,
    taken_at TEXT,
    place TEXT,
    inbox BOOLEAN NOT NULL,
    trashed_at TEXT,
    PRIMARY KEY (user_id, device_id, id),
    ${ownedBy}
  );
  CREATE INDEX catalog_files_hash ON catalog_files (user_id, object_hash);
  CREATE TABLE catalog_replicas (${owner}
    drive_id TEXT NOT NULL,
    relative_path TEXT NOT NULL,
    file_id TEXT NOT NULL,
    status TEXT NOT NULL,
    progress INTEGER,
    size BIGINT,
    modified_at TEXT,
    object_hash TEXT,
    PRIMARY KEY (user_id, device_id, drive_id, relative_path),
    ${ownedBy}
  );
  CREATE INDEX catalog_replicas_file ON catalog_replicas (user_id, device_id, file_id);
  CREATE TABLE catalog_folders (${owner}
    id TEXT NOT NULL,
    name TEXT NOT NULL,
    parent_id TEXT,
    PRIMARY KEY (user_id, device_id, id),
    ${ownedBy}
  );
  CREATE TABLE catalog_file_folders (${owner}
    file_id TEXT NOT NULL,
    folder_id TEXT NOT NULL,
    PRIMARY KEY (user_id, device_id, file_id),
    ${ownedBy}
  );
  CREATE TABLE catalog_file_versions (${owner}
    file_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    object_hash TEXT NOT NULL,
    size BIGINT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (user_id, device_id, file_id, version),
    ${ownedBy}
  );
  CREATE TABLE catalog_backup_jobs (${owner}
    id TEXT NOT NULL,
    source_drive_id TEXT NOT NULL,
    dest_drive_id TEXT NOT NULL,
    source_relative_paths JSONB NOT NULL,
    last_run_at TEXT,
    auto BOOLEAN NOT NULL DEFAULT false,
    PRIMARY KEY (user_id, device_id, id),
    ${ownedBy}
  );
  `,
  // 2: personal drives people connect (Google Drive, OneDrive). Several per person.
  `
  CREATE TABLE drive_connections (
    user_id TEXT NOT NULL,
    id TEXT NOT NULL,
    provider TEXT NOT NULL,
    account_id TEXT NOT NULL,
    label TEXT NOT NULL,
    email TEXT,
    status TEXT NOT NULL,
    root_id TEXT NOT NULL,
    sealed_tokens TEXT NOT NULL,
    connected_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, id),
    UNIQUE (user_id, provider, account_id)
  );
  `,
];

/**
 * Brings the catalog tables up to date. Safe to run on every start and from several servers at
 * once: an advisory lock lets one run the steps while the others wait.
 */
export async function migrateCatalog(db: PgDatabase<PgQueryResultHKT, Record<string, unknown>>) {
  await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(4243520271)`);
    await tx.execute(sql`CREATE TABLE IF NOT EXISTS memories_migrations (version INTEGER PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
    const result = await tx.execute<{ version: number | null }>(sql`SELECT MAX(version) AS version FROM memories_migrations`);
    const rows = (Array.isArray(result) ? result : (result as { rows: Array<{ version: number | null }> }).rows) ?? [];
    const current = Number(rows[0]?.version ?? 0);
    for (let version = current; version < MIGRATIONS.length; version++) {
      // One statement per call: drivers that use the extended protocol refuse several at once.
      for (const statement of MIGRATIONS[version]!.split(/;\s*$/m)) {
        if (statement.trim()) await tx.execute(sql.raw(statement));
      }
      await tx.execute(sql`INSERT INTO memories_migrations (version) VALUES (${version + 1})`);
    }
  });
}
