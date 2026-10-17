import type { CloudProvider } from "@memories/core";
import { PostgresCatalogStore, connectPostgres, migrateCatalog } from "@memories/db-postgres";
import { createObjectStorage } from "@memories/storage";
import { getMigrations } from "better-auth/db/migration";
import { createCloudApp } from "./app.js";
import { type AuthOptions, createAuth } from "./auth.js";
import { CloudFiles } from "./cloud-files.js";
import type { CloudConfig } from "./config.js";

/** Wires the production pieces: one Postgres pool, the configured storage provider, Better Auth. */
export function createCloudServer(config: CloudConfig) {
  const { pool, db } = connectPostgres(config.databaseUrl);
  const catalog = new PostgresCatalogStore(db);
  const files = new CloudFiles(createObjectStorage(config.storage));
  const authOptions: AuthOptions = {
    database: pool,
    baseURL: config.baseURL,
    secret: config.secret,
    mailer: config.mailer,
    providers: config.providers,
    requireEmailVerification: config.requireEmailVerification,
    onUserDeleted: async (userId) => {
      await catalog.removeUser(userId);
      await files.removeAll(userId);
    },
  };
  const auth = createAuth(authOptions);
  const app = createCloudApp({ auth, catalog, files, providers: Object.keys(config.providers) as CloudProvider[] });

  return {
    app,
    auth,
    pool,
    /** Creates or updates Better Auth's tables and the catalog tables. */
    async migrate() {
      const { runMigrations } = await getMigrations(auth.options);
      await runMigrations();
      await migrateCatalog(db);
    },
    close: () => pool.end(),
  };
}
