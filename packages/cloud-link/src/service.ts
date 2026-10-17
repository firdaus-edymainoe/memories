import {
  type CatalogChangeFeed,
  type CloudAdminUser,
  type CloudProvider,
  type CloudRole,
  type CloudStatus,
  type CloudUser,
  type Drive,
  type DriveKind,
  syncCatalog,
} from "@memories/core";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { CloudApi, CloudApiError } from "./api.js";
import { type CloudConnection, cloudRoot, cloudVolumeId } from "./file-io.js";
import type { CloudState, CloudStateStore } from "./state.js";

/** How the service adds the cloud place to the catalog (core's `registerDrive`, in the host). */
export interface PlaceRegistry {
  list(): Promise<Drive[]>;
  register(input: { name: string; kind: DriveKind; rootPath: string; volumeId: string }): Promise<Drive>;
}

export type CloudServiceOptions = {
  /** The cloud server. Without one, cloud mode is not offered and the app stays local only. */
  serverUrl: string | null;
  store: CloudStateStore;
  changes: CatalogChangeFeed;
  places: PlaceRegistry;
  /** Opens a URL in the system browser (Electron's `shell.openExternal`). */
  openExternal: (url: string) => Promise<void>;
  device: { name: string; platform: string };
  fetch?: typeof fetch;
  now?: () => Date;
};

type PendingSignIn = { state: string; verifier: string; redirectUri: string; expiresAt: number };

const SIGN_IN_WINDOW_MS = 10 * 60 * 1000;
export const CLOUD_PLACE_NAME = "Memories Cloud";

function random() {
  return randomBytes(32).toString("base64url");
}

function same(a: string, b: string) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * Optional cloud mode for the desktop app: the account, catalog sync and the cloud place.
 * Nothing here runs until the person signs in; signing out keeps everything local.
 */
export class CloudService implements CloudConnection {
  private state: CloudState | null = null;
  private api: CloudApi | null;
  private pending: PendingSignIn | null = null;
  private syncing: Promise<void> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private providers: CloudProvider[] | null = null;
  private readonly now: () => Date;

  constructor(private readonly options: CloudServiceOptions) {
    this.now = options.now ?? (() => new Date());
    this.api = options.serverUrl
      ? new CloudApi(options.serverUrl.replace(/\/+$/, ""), () => this.state?.session?.token ?? null, options.fetch)
      : null;
  }

  /** Loads what was saved last time. Call once before anything else. */
  async load() {
    this.state = await this.options.store.load();
    return this;
  }

  private get loaded() {
    if (!this.state) throw new Error("CloudService.load() was not called");
    return this.state;
  }

  private requireApi() {
    if (!this.api) throw new Error("Memories Cloud isn't set up for this app");
    return this.api;
  }

  private async update(change: Partial<CloudState>) {
    this.state = { ...this.loaded, ...change };
    await this.options.store.save(this.state);
  }

  current() {
    const session = this.state?.session;
    return session && this.api ? { user: session.user, api: this.api } : null;
  }

  async status(): Promise<CloudStatus> {
    const state = this.loaded;
    const user = state.session?.user ?? null;
    const root = user ? cloudRoot(user.id) : null;
    const storage = root ? (await this.options.places.list()).find((drive) => drive.rootPath === root) : undefined;
    return {
      available: this.api !== null,
      serverUrl: this.api?.serverUrl ?? null,
      providers: await this.availableProviders(),
      user,
      sync: {
        enabled: state.syncEnabled,
        pending: state.syncEnabled ? await this.options.changes.pendingCount() : 0,
        lastSyncedAt: state.lastSyncedAt,
        error: state.lastError,
        running: this.syncing !== null,
      },
      storageDriveId: storage?.id ?? null,
    };
  }

  private async availableProviders() {
    if (!this.api) return [];
    if (!this.providers) {
      try {
        this.providers = (await this.api.config()).providers;
      } catch {
        return []; // Offline: try again next time.
      }
    }
    return this.providers;
  }

  // Signing in and out

  async signUp(input: { name: string; email: string; password: string }) {
    return this.startSession(await this.requireApi().signUp({ ...input, callbackURL: `${this.requireApi().serverUrl}/` }));
  }

  async signIn(input: { email: string; password: string }) {
    return this.startSession(await this.requireApi().signIn(input));
  }

  /**
   * Opens the system browser to sign in with a provider. The browser comes back to
   * `redirectUri` (this app's own server, `/cloud/callback`) with a code for `completeSignIn`.
   */
  async startSignIn(provider: CloudProvider, redirectUri: string) {
    const api = this.requireApi();
    if (!(await this.availableProviders()).includes(provider)) throw new Error(`Signing in with ${provider} isn't set up`);
    const verifier = random();
    this.pending = { state: random(), verifier, redirectUri, expiresAt: this.now().getTime() + SIGN_IN_WINDOW_MS };
    const url = api.desktopSignInUrl({
      provider,
      redirectUri,
      state: this.pending.state,
      codeChallenge: createHash("sha256").update(verifier).digest("base64url"),
    });
    await this.options.openExternal(url);
    return { url };
  }

  async completeSignIn(input: { code: string; state: string }) {
    const pending = this.pending;
    if (!pending || !same(pending.state, input.state) || pending.expiresAt < this.now().getTime()) {
      throw new Error("This sign-in was not started here, or it took too long. Try again from Memories.");
    }
    this.pending = null;
    const session = await this.requireApi().exchangeDesktopCode({
      code: input.code,
      codeVerifier: pending.verifier,
      redirectUri: pending.redirectUri,
    });
    return this.startSession(session);
  }

  private async startSession(session: { token: string; user: CloudUser }) {
    const previous = this.loaded.session?.user.id;
    await this.update({ session, lastError: null });
    // Another account's catalog must not leak into this one: start the sync over.
    if (previous && previous !== session.user.id && this.loaded.syncEnabled) await this.options.changes.start();
    await this.registerDevice().catch(() => undefined);
    return session.user;
  }

  private async registerDevice() {
    await this.requireApi().registerDevice({ id: this.loaded.deviceId, ...this.options.device });
  }

  async signOut() {
    if (this.api && this.loaded.session) await this.api.signOut().catch(() => undefined);
    await this.update({ session: null, lastError: null });
  }

  async forgotPassword(email: string) {
    await this.requireApi().requestPasswordReset(email);
  }

  async resendVerification() {
    const user = this.loaded.session?.user;
    if (user) await this.requireApi().sendVerificationEmail(user.email);
  }

  /** Re-reads the account (for a new role or a confirmed email). Signs out if it was revoked. */
  async refresh() {
    if (!this.api || !this.loaded.session) return null;
    try {
      const user = await this.api.me();
      await this.update({ session: { ...this.loaded.session, user } });
      return user;
    } catch (error) {
      if (error instanceof CloudApiError && error.status === 401) await this.update({ session: null });
      throw error;
    }
  }

  // Catalog sync

  /** Turning sync on sends the whole catalog; turning it off stops recording changes. */
  async setSyncEnabled(enabled: boolean) {
    if (enabled && !this.loaded.session) throw new Error("Sign in to Memories Cloud first");
    if (enabled === this.loaded.syncEnabled) return;
    if (enabled) await this.options.changes.start();
    else await this.options.changes.stop();
    await this.update({ syncEnabled: enabled, lastError: null });
    if (enabled) void this.syncNow().catch(() => undefined);
  }

  /** Sends waiting changes now. Only one sync runs at a time; a second call waits for it. */
  syncNow(): Promise<void> {
    if (this.syncing) return this.syncing;
    const run = this.runSync().finally(() => {
      this.syncing = null;
    });
    this.syncing = run;
    return run;
  }

  private async runSync() {
    const state = this.loaded;
    if (!state.syncEnabled || !state.session) return;
    try {
      await this.registerDevice();
      await syncCatalog(this.options.changes, this.requireApi(), { deviceId: state.deviceId });
      await this.update({ lastSyncedAt: this.now().toISOString(), lastError: null });
    } catch (error) {
      const expired = error instanceof CloudApiError && error.status === 401;
      await this.update({
        lastError: expired ? "You were signed out. Sign in again to keep syncing." : error instanceof Error ? error.message : String(error),
        ...(expired ? { session: null } : {}),
      });
      throw error;
    }
  }

  /** Syncs in the background every `everyMs` while there is something to send. */
  startBackgroundSync(everyMs = 30_000) {
    this.stopBackgroundSync();
    const tick = async () => {
      const state = this.state;
      if (!state?.syncEnabled || !state.session || this.syncing) return;
      if ((await this.options.changes.pendingCount()) === 0) return;
      await this.syncNow();
    };
    this.timer = setInterval(() => void tick().catch(() => undefined), everyMs);
    void tick().catch(() => undefined);
  }

  stopBackgroundSync() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  // Cloud storage

  /** Adds the person's cloud storage as a place (once; later calls return the same one). */
  async addStoragePlace() {
    const user = this.loaded.session?.user;
    if (!user) throw new Error("Sign in to Memories Cloud first");
    return this.options.places.register({
      name: CLOUD_PLACE_NAME,
      kind: "cloud",
      rootPath: cloudRoot(user.id),
      volumeId: cloudVolumeId(user.id),
    });
  }

  // People (admins only; the server checks the role on every call)

  listUsers(input: { search?: string; limit?: number; offset?: number } = {}): Promise<{ users: CloudAdminUser[]; total: number }> {
    return this.requireApi().listUsers(input);
  }

  setRole(userId: string, role: CloudRole) {
    return this.requireApi().setRole(userId, role);
  }

  banUser(userId: string, reason?: string) {
    return this.requireApi().banUser(userId, reason);
  }

  unbanUser(userId: string) {
    return this.requireApi().unbanUser(userId);
  }

  async removeUser(userId: string) {
    if (userId === this.loaded.session?.user.id) throw new Error("You can't remove your own account here");
    return this.requireApi().removeUser(userId);
  }
}
