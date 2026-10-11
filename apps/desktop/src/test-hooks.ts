/**
 * Test-only hooks for end-to-end tests. Nothing here runs unless MEMORIES_TEST_MODE=1.
 *
 * - Volumes come from a list the test controls (plug / unplug without real disks).
 * - Phones come from a fake MTP host backed by a plain folder (no USB, no adb).
 * - adb is never downloaded or executed.
 * - /__test/* routes reset the catalog and drive the fakes.
 * - MEMORIES_DB is required, so a test can never touch the real catalog.
 */
import type { FileIO, Ports, VolumePresence, Volumes } from "@memories/core";
import { SqliteCatalog } from "@memories/db-sqlite";
import {
  AndroidFileIO,
  AndroidVolumes,
  MergeVolumes,
  MtpFileIO,
  MtpVolumes,
  PhoneFileIO,
  PhoneVolumes,
  SwitchFileIO,
} from "@memories/fs-android";
import type { MtpClient, MtpDeviceInfo, MtpHost, MtpObject } from "@memories/fs-android";
import Database from "better-sqlite3";
import { Hono } from "hono";
import { mkdir, readdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { platform } from "node:os";
import { join, resolve, sep } from "node:path";

export function isTestMode() {
  return process.env.MEMORIES_TEST_MODE === "1";
}

const FMT_ASSOCIATION = 0x3001;
const FMT_UNDEFINED = 0x3000;
export const DEFAULT_TEST_VOLUMES: VolumePresence[] = [{ volumeId: "test-root", mountPath: "/", label: "Test disk" }];

/** Volumes the test plugs in and unplugs at will. Longest mount path wins, like a real OS. */
export class TestVolumes implements Volumes {
  present: VolumePresence[] = [...DEFAULT_TEST_VOLUMES];

  async list() {
    return this.present.map((volume) => ({ ...volume }));
  }

  async identify(rootPath: string): Promise<VolumePresence> {
    const match = this.present
      .filter((volume) => {
        if (rootPath === volume.mountPath) return true;
        const prefix = volume.mountPath.endsWith("/") || volume.mountPath.endsWith("\\") ? volume.mountPath : `${volume.mountPath}${sep}`;
        return rootPath.startsWith(prefix);
      })
      .sort((a, b) => b.mountPath.length - a.mountPath.length)[0];
    if (match) return { ...match };
    return { volumeId: `path:${rootPath}`, mountPath: rootPath, label: rootPath };
  }
}

export type FakePhone = MtpDeviceInfo & { dir: string };

/** A phone whose storage is a plain folder. Handle 0 is the storage root. */
class FolderMtpClient implements MtpClient {
  private paths = new Map<number, string>([[0, ""]]);
  private handles = new Map<string, number>([["", 0]]);
  private next = 1;

  constructor(
    private readonly dir: string,
    readonly label: string,
  ) {}

  private handleFor(rel: string) {
    let handle = this.handles.get(rel);
    if (handle === undefined) {
      handle = this.next++;
      this.handles.set(rel, handle);
      this.paths.set(handle, rel);
    }
    return handle;
  }

  private abs(handle: number) {
    const rel = this.paths.get(handle);
    if (rel === undefined) throw new Error("Invalid object handle");
    return { rel, abs: rel ? join(this.dir, ...rel.split("/")) : this.dir };
  }

  async listChildren(parent: number): Promise<MtpObject[]> {
    const { rel, abs } = this.abs(parent);
    const names = await readdir(abs);
    const out: MtpObject[] = [];
    for (const name of names) {
      const childRel = rel ? `${rel}/${name}` : name;
      const info = await stat(join(abs, name));
      out.push({
        handle: this.handleFor(childRel),
        name,
        size: info.isDirectory() ? 0 : info.size,
        format: info.isDirectory() ? FMT_ASSOCIATION : FMT_UNDEFINED,
        takenAt: info.mtime.toISOString(),
      });
    }
    return out;
  }

  async readObject(handle: number) {
    return new Uint8Array(await readFile(this.abs(handle).abs));
  }

  async mkdir(parent: number, name: string) {
    const { rel, abs } = this.abs(parent);
    await mkdir(join(abs, name), { recursive: true });
    return this.handleFor(rel ? `${rel}/${name}` : name);
  }

  async sendObject(parent: number, name: string, bytes: Uint8Array) {
    const { rel, abs } = this.abs(parent);
    await writeFile(join(abs, name), bytes);
    return this.handleFor(rel ? `${rel}/${name}` : name);
  }

  async deleteObject(handle: number) {
    await unlink(this.abs(handle).abs);
  }

  async close() {}
}

export class FakeMtpHost implements MtpHost {
  phones: FakePhone[] = [];
  opened = 0;

  async listDevices(): Promise<MtpDeviceInfo[]> {
    return this.phones.map(({ vendorId, productId, serial, label }) => ({ vendorId, productId, serial, label }));
  }

  async open(device: MtpDeviceInfo): Promise<MtpClient> {
    const phone = this.phones.find(
      (row) =>
        row.vendorId === device.vendorId &&
        row.productId === device.productId &&
        (!device.serial || !row.serial || row.serial === device.serial),
    );
    if (!phone) throw new Error("Android phone not connected. Unlock it and set USB to File transfer.");
    this.opened += 1;
    return new FolderMtpClient(phone.dir, phone.label);
  }
}

/** adb never runs in test mode. */
const noAdb = async (): Promise<never> => {
  throw new Error("adb is disabled in test mode");
};

/** Stand-in for the system folder picker: answers with queued paths (null = the user cancelled). */
export class FakePicker {
  queue: (string | null)[] = [];
  calls = 0;
  pick = async () => {
    this.calls += 1;
    return this.queue.length ? (this.queue.shift() ?? null) : null;
  };
}

export type TestState = { ports: Ports; volumes: TestVolumes; mtp: FakeMtpHost; picker: FakePicker; catalogPath: string };

export async function createTestPorts(catalogPath: string): Promise<TestState> {
  const catalog = new SqliteCatalog(catalogPath);
  const volumes = new TestVolumes();
  const mtp = new FakeMtpHost();
  const phoneIO = new PhoneFileIO(new MtpFileIO(mtp), new AndroidFileIO(noAdb));
  const phoneVolumes = new PhoneVolumes(new MtpVolumes(mtp), new AndroidVolumes(noAdb));
  const local =
    platform() === "win32"
      ? new (await import("@memories/fs-win32")).NodeFileIO()
      : new (await import("@memories/fs-darwin")).NodeFileIO();
  const ports: Ports = {
    catalog,
    fileIO: new SwitchFileIO(local as FileIO, phoneIO),
    volumes: new MergeVolumes(volumes, phoneVolumes),
  };
  return { ports, volumes, mtp, picker: new FakePicker(), catalogPath };
}

export function requireTestCatalogPath(): string {
  const path = process.env.MEMORIES_DB;
  if (!path) {
    throw new Error("MEMORIES_TEST_MODE=1 needs MEMORIES_DB so tests never touch the real catalog.");
  }
  return resolve(path);
}

/** Routes under /__test. Only mounted in test mode. */
export function createTestRoutes(state: TestState) {
  const app = new Hono();

  app.get("/__test/state", async (c) =>
    c.json({
      testMode: true,
      catalogPath: state.catalogPath,
      volumes: state.volumes.present,
      phones: state.mtp.phones,
      picker: { queue: state.picker.queue, calls: state.picker.calls },
    }),
  );

  app.post("/__test/reset", async (c) => {
    const db = new Database(state.catalogPath);
    try {
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
        .all() as { name: string }[];
      db.transaction(() => {
        for (const { name } of tables) db.prepare(`DELETE FROM "${name}"`).run();
      })();
    } finally {
      db.close();
    }
    state.volumes.present = [...DEFAULT_TEST_VOLUMES];
    state.mtp.phones = [];
    state.picker.queue = [];
    state.picker.calls = 0;
    return c.json({ ok: true });
  });

  app.put("/__test/volumes", async (c) => {
    const body = await c.req.json<{ volumes: VolumePresence[] }>();
    state.volumes.present = body.volumes.map((volume) => ({ ...volume }));
    return c.json({ volumes: state.volumes.present });
  });

  app.put("/__test/phones", async (c) => {
    const body = await c.req.json<{ phones: FakePhone[] }>();
    state.mtp.phones = body.phones.map((phone) => ({ ...phone, serial: phone.serial ?? null }));
    return c.json({ phones: state.mtp.phones });
  });

  app.put("/__test/picker", async (c) => {
    const body = await c.req.json<{ paths: (string | null)[] }>();
    state.picker.queue = [...body.paths];
    return c.json({ queue: state.picker.queue });
  });

  return app;
}
