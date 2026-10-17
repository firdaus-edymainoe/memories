import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema.js";

/** A pooled connection to the cloud database. One pool serves the catalog and Better Auth. */
export function connectPostgres(connectionString: string, options: { max?: number } = {}) {
  const pool = new pg.Pool({ connectionString, max: options.max ?? 10 });
  return { pool, db: drizzle(pool, { schema }) };
}
