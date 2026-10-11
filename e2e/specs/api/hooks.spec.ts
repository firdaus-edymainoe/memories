import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runApiToExit, startApi } from "../../support/api-server.js";
import { expect, test } from "../../support/fixtures.js";

test.describe("test hooks", () => {
  test("health is up and the API runs in test mode on the worker's own catalog", async ({ mem }) => {
    expect(await mem.json("GET", "/health")).toEqual({ ok: true });
    const state = await mem.json<{ testMode: boolean; catalogPath: string }>("GET", "/__test/state");
    expect(state.testMode).toBe(true);
    expect(state.catalogPath).toContain("memories-e2e-w");
    expect(state.catalogPath).not.toContain("Application Support");
  });

  test("reset empties the catalog and unplugs fakes", async ({ mem }) => {
    const root = await mem.place("pics", { "a.txt": "a" });
    await mem.addAndIngest({ name: "Pics", kind: "computer", rootPath: root });
    await mem.setPhones([{ vendorId: 0x18d1, productId: 0x4ee2, serial: "PX", label: "Pixel", dir: root }]);
    expect(await mem.files()).toHaveLength(1);
    await mem.json("POST", "/__test/reset");
    expect(await mem.drives()).toEqual([]);
    expect(await mem.files()).toEqual([]);
    expect(await mem.backups()).toEqual([]);
    const volumes = await mem.json<{ volumes: { volumeId: string }[] }>("GET", "/volumes");
    expect(volumes.volumes.map((v) => v.volumeId)).toEqual(["test-root"]);
  });

  test("test mode refuses to start without MEMORIES_DB", async () => {
    const result = await runApiToExit({ testMode: true });
    expect(result.code).not.toBe(0);
    expect(result.output).toContain("MEMORIES_TEST_MODE=1 needs MEMORIES_DB");
  });

  test("hooks are inert when MEMORIES_TEST_MODE is off", async () => {
    const dir = await mkdtemp(join(tmpdir(), "memories-e2e-normal-"));
    const server = await startApi({ testMode: false, dbPath: join(dir, "catalog.sqlite") });
    try {
      for (const [method, path] of [["GET", "/__test/state"], ["POST", "/__test/reset"], ["PUT", "/__test/volumes"], ["PUT", "/__test/phones"]] as const) {
        const res = await fetch(`${server.url}${path}`, { method, headers: { "content-type": "application/json" }, body: method === "GET" ? null : "{}" });
        expect(res.status, `${method} ${path}`).toBe(404);
      }
      expect(server.logs()).not.toContain("test mode");
    } finally {
      await server.stop();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
