import { test as base, expect, type APIRequestContext, type Page, request as pwRequest } from "@playwright/test";
import type { BackupJob, Drive, DriveKind, FileDetail, LibraryFile, VolumePresence } from "@memories/core";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startApi, type ApiServer } from "./api-server.js";
import { pinClock } from "./clock.js";
import { FIXED_NOW, UI_ORIGIN } from "./env.js";
import { jpeg, writeTree, type FileSpec } from "./places.js";

export { expect };

export const TEST_ROOT_VOLUME: VolumePresence = { volumeId: "test-root", mountPath: "/", label: "Test disk" };

export type FakePhone = { vendorId: number; productId: number; serial?: string | null; label: string; dir: string };

export class Mem {
  constructor(
    readonly api: APIRequestContext,
    readonly server: ApiServer,
    readonly dir: string,
  ) {}

  get url() {
    return this.server.url;
  }

  /** UI URL that talks to this worker's API (live data, not the sample cabinet). */
  appUrl(extra = "") {
    return `${UI_ORIGIN}/?live=1&api=${encodeURIComponent(this.server.url)}${extra}`;
  }

  path(...parts: string[]) {
    return join(this.dir, ...parts);
  }

  async place(rel: string, files: Record<string, FileSpec> = {}) {
    return writeTree(this.path(rel), files);
  }

  async json<T>(method: "GET" | "POST" | "PUT", url: string, data?: unknown): Promise<T> {
    const res = await this.api.fetch(url, { method, ...(data === undefined ? {} : { data }) });
    const body = await res.json();
    if (!res.ok()) throw new Error(`${method} ${url} -> ${res.status()}: ${JSON.stringify(body)}`);
    return body as T;
  }

  async addPlace(input: { name: string; kind: DriveKind; rootPath: string; volumeId?: string }) {
    return (await this.json<{ drive: Drive }>("POST", "/drives", input)).drive;
  }

  async ingest(driveId: string, relativePath?: string) {
    return this.json<{ files: number; replicas: number }>("POST", "/ingest", { driveId, relativePath });
  }

  /** Register and index a folder in one go. */
  async addAndIngest(input: { name: string; kind: DriveKind; rootPath: string; volumeId?: string }) {
    const drive = await this.addPlace(input);
    await this.ingest(drive.id);
    return drive;
  }

  async drives() {
    return (await this.json<{ drives: Drive[] }>("GET", "/drives")).drives;
  }

  async drive(id: string) {
    const found = (await this.drives()).find((drive) => drive.id === id);
    if (!found) throw new Error(`No drive ${id}`);
    return found;
  }

  async files(query = "") {
    return (await this.json<{ files: LibraryFile[] }>("GET", `/files${query}`)).files;
  }

  async fileByName(name: string) {
    const file = (await this.files()).find((row) => row.name === name);
    if (!file) throw new Error(`No library file named ${name}`);
    return file;
  }

  async detail(id: string) {
    return this.json<FileDetail>("GET", `/files/${id}`);
  }

  async backups() {
    return (await this.json<{ jobs: BackupJob[] }>("GET", "/backups")).jobs;
  }

  async saveBackup(sourceDriveId: string, destDriveId: string, sourceRelativePaths: string[]) {
    return (await this.json<{ job: BackupJob }>("POST", "/backups", { sourceDriveId, destDriveId, sourceRelativePaths })).job;
  }

  async runBackup(id: string) {
    return this.json<{ copied: number; skipped: number }>("POST", `/backups/${id}/run`);
  }

  /** Replace the plugged-in volume list. The test disk at "/" stays unless `withRoot` is false. */
  async setVolumes(volumes: VolumePresence[], withRoot = true) {
    await this.json("PUT", "/__test/volumes", { volumes: withRoot ? [TEST_ROOT_VOLUME, ...volumes] : volumes });
  }

  /** Make a removable drive folder under this test's dir and plug it in. */
  async plugDrive(label: string, volumeId = `vol-${label.toLowerCase().replace(/\W+/g, "-")}`) {
    const mountPath = this.path("Volumes", label);
    await mkdir(mountPath, { recursive: true });
    const current = (await this.json<{ volumes: VolumePresence[] }>("GET", "/__test/state")).volumes;
    await this.setVolumes([...current.filter((v) => v.volumeId !== volumeId && v.volumeId !== "test-root"), { volumeId, mountPath, label }]);
    return { volumeId, mountPath, label };
  }

  async unplug(volumeId: string) {
    const current = (await this.json<{ volumes: VolumePresence[] }>("GET", "/__test/state")).volumes;
    await this.json("PUT", "/__test/volumes", { volumes: current.filter((v) => v.volumeId !== volumeId) });
  }

  async setPhones(phones: FakePhone[]) {
    await this.json("PUT", "/__test/phones", { phones });
  }
}

type WorkerFixtures = { apiServer: ApiServer; workerDir: string };
type TestFixtures = { mem: Mem; externalRequests: string[]; app: Page; stubExternalHosts: string[]; freezeClock: boolean };

export const test = base.extend<TestFixtures, WorkerFixtures>({
  workerDir: [
    async ({}, use) => {
      const dir = await mkdtemp(join(tmpdir(), "memories-e2e-w"));
      await use(dir);
      await rm(dir, { recursive: true, force: true });
    },
    { scope: "worker" },
  ],

  // One real API process per worker, with its own SQLite file. Reset between tests.
  apiServer: [
    async ({ workerDir }, use) => {
      const server = await startApi({ dbPath: join(workerDir, "catalog.sqlite") });
      await use(server);
      await server.stop();
    },
    { scope: "worker" },
  ],

  mem: async ({ apiServer, workerDir }, use, testInfo) => {
    const api = await pwRequest.newContext({ baseURL: apiServer.url });
    const reset = await api.post("/__test/reset");
    expect(reset.ok(), "test-mode reset endpoint").toBeTruthy();
    const dir = join(workerDir, `t${testInfo.testId}-${testInfo.retry}`);
    await mkdir(dir, { recursive: true });
    await use(new Mem(api, apiServer, dir));
    await api.dispose();
    await rm(dir, { recursive: true, force: true });
    if (testInfo.status !== testInfo.expectedStatus) {
      await testInfo.attach("api.log", { body: apiServer.logs(), contentType: "text/plain" });
    }
  },

  externalRequests: async ({}, use) => {
    await use([]);
  },

  /** Hosts whose images are served from a local fixture instead of failing the test (see the welcome tour). */
  stubExternalHosts: [[], { option: true }],

  /** Pin Date to FIXED_NOW (see support/clock.ts for why this is not page.clock). */
  freezeClock: [true, { option: true }],

  // Every page: frozen clock, no network beyond the box, and a check that nothing tried to leave.
  page: async ({ page, externalRequests, stubExternalHosts, freezeClock }, use) => {
    if (freezeClock) await pinClock(page, FIXED_NOW);
    await page.route(/^https?:\/\/(?!127\.0\.0\.1|localhost)[^/]+\//, async (route) => {
      const url = new URL(route.request().url());
      if (stubExternalHosts.includes(url.hostname)) {
        await route.fulfill({ status: 200, contentType: "image/jpeg", body: jpeg(`stub:${url.pathname}`) });
        return;
      }
      externalRequests.push(url.href);
      await route.abort("blockedbyclient");
    });
    await use(page);
    expect(externalRequests, "the desktop UI must not reach the internet").toEqual([]);
  },

  /** The live app, opened against this test's API. */
  app: async ({ page, mem }, use) => {
    await page.goto(mem.appUrl());
    await expect(page.getByRole("navigation", { name: "Main" })).toBeVisible();
    await use(page);
  },
});

/** Wait for the next 4s presence poll (Places / Backup screens) that starts after this call. */
export async function nextPoll(page: Page) {
  const request = await page.waitForRequest((req) => /\/drives$/.test(new URL(req.url()).pathname), { timeout: 8_000 });
  await request.response();
}

/** Mark the current test as documenting a known bug: it must fail until the bug is fixed. */
export function knownBug(reason: string) {
  test.fail(true, `Known bug: ${reason}`);
}
