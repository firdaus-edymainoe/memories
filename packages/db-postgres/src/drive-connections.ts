import type { CloudDriveProvider, DriveConnectionRecord, DriveConnectionStore } from "@memories/core";
import { and, asc, eq, sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import * as schema from "./schema.js";

type Db = PgDatabase<PgQueryResultHKT, typeof schema>;
type Row = typeof schema.driveConnections.$inferSelect;

const table = schema.driveConnections;

function fromRow(row: Row): DriveConnectionRecord {
  return {
    userId: row.userId,
    id: row.id,
    provider: row.provider as CloudDriveProvider,
    accountId: row.accountId,
    label: row.label,
    email: row.email,
    status: row.status === "reconnect" ? "reconnect" : "connected",
    rootId: row.rootId,
    sealedTokens: row.sealedTokens,
    connectedAt: new Date(row.connectedAt).toISOString(),
  };
}

/** Everyone's connected drives in PostgreSQL. */
export class PostgresDriveConnectionStore implements DriveConnectionStore {
  constructor(private readonly db: Db) {}

  async list(userId: string) {
    const rows = await this.db.select().from(table).where(eq(table.userId, userId)).orderBy(asc(table.connectedAt), asc(table.id));
    return rows.map(fromRow);
  }

  async get(userId: string, id: string) {
    const [row] = await this.db.select().from(table).where(and(eq(table.userId, userId), eq(table.id, id)));
    return row ? fromRow(row) : null;
  }

  async findByAccount(userId: string, provider: CloudDriveProvider, accountId: string) {
    const [row] = await this.db
      .select()
      .from(table)
      .where(and(eq(table.userId, userId), eq(table.provider, provider), eq(table.accountId, accountId)));
    return row ? fromRow(row) : null;
  }

  async save(record: DriveConnectionRecord) {
    const values = {
      userId: record.userId,
      id: record.id,
      provider: record.provider,
      accountId: record.accountId,
      label: record.label,
      email: record.email,
      status: record.status,
      rootId: record.rootId,
      sealedTokens: record.sealedTokens,
      connectedAt: record.connectedAt,
    };
    const { userId: _userId, id: _id, ...changes } = values;
    await this.db
      .insert(table)
      .values(values)
      .onConflictDoUpdate({ target: [table.userId, table.id], set: { ...changes, updatedAt: sql`now()` } });
  }

  async remove(userId: string, id: string) {
    await this.db.delete(table).where(and(eq(table.userId, userId), eq(table.id, id)));
  }

  async removeUser(userId: string) {
    await this.db.delete(table).where(eq(table.userId, userId));
  }
}
