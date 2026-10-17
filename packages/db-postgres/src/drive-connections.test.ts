import { PGlite } from "@electric-sql/pglite";
import type { DriveConnectionRecord } from "@memories/core";
import { drizzle } from "drizzle-orm/pglite";
import { beforeEach, describe, expect, it } from "vitest";
import { PostgresDriveConnectionStore, migrateCatalog } from "./index.js";
import * as schema from "./schema.js";

const record = (overrides: Partial<DriveConnectionRecord> = {}): DriveConnectionRecord => ({
  userId: "u1",
  id: "drv_1",
  provider: "google-drive",
  accountId: "acc-1",
  label: "Google Drive (me@gmail.com)",
  email: "me@gmail.com",
  status: "connected",
  rootId: "root",
  sealedTokens: "sealed",
  connectedAt: "2026-10-17T10:00:00.000Z",
  ...overrides,
});

describe("PostgresDriveConnectionStore", () => {
  let store: PostgresDriveConnectionStore;

  beforeEach(async () => {
    const db = drizzle(new PGlite(), { schema });
    await migrateCatalog(db);
    store = new PostgresDriveConnectionStore(db);
  });

  it("keeps several drives per person, apart from other people", async () => {
    await store.save(record());
    await store.save(record({ id: "drv_2", accountId: "acc-2", email: "work@x.com", connectedAt: "2026-10-17T11:00:00.000Z" }));
    await store.save(record({ id: "drv_3", provider: "onedrive", accountId: "acc-1", connectedAt: "2026-10-17T12:00:00.000Z" }));
    await store.save(record({ userId: "u2" }));
    expect((await store.list("u1")).map((r) => r.id)).toEqual(["drv_1", "drv_2", "drv_3"]);
    expect(await store.get("u2", "drv_1")).toEqual(record({ userId: "u2" }));
    expect(await store.findByAccount("u1", "onedrive", "acc-1")).toMatchObject({ id: "drv_3" });
    expect(await store.findByAccount("u1", "onedrive", "acc-2")).toBeNull();
  });

  it("updates in place, and removes one drive or everyone's", async () => {
    await store.save(record());
    await store.save(record({ status: "reconnect", sealedTokens: "new" }));
    expect(await store.list("u1")).toEqual([record({ status: "reconnect", sealedTokens: "new" })]);
    await store.save(record({ id: "drv_2", accountId: "acc-2" }));
    await store.remove("u1", "drv_1");
    expect((await store.list("u1")).map((r) => r.id)).toEqual(["drv_2"]);
    await store.removeUser("u1");
    expect(await store.list("u1")).toEqual([]);
  });

  it("refuses the same account twice under different ids", async () => {
    await store.save(record());
    await expect(store.save(record({ id: "drv_9" }))).rejects.toThrow();
  });
});
