import type { CloudUser, ConnectedDrive } from "@memories/core";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/** What the app remembers about cloud mode between launches. */
export type CloudState = {
  /** Made once per install. Each device syncs its own catalog. */
  deviceId: string;
  session: { token: string; user: CloudUser } | null;
  syncEnabled: boolean;
  lastSyncedAt: string | null;
  lastError: string | null;
  /** The person's own drives, as last heard from the server (so places show up offline too). */
  drives: ConnectedDrive[];
};

export interface CloudStateStore {
  load(): Promise<CloudState>;
  save(state: CloudState): Promise<void>;
}

/** Encrypts the session token at rest (Electron's `safeStorage` on the desktop). */
export interface SecretBox {
  encrypt(plain: string): string;
  decrypt(sealed: string): string;
}

/** No encryption. Only for development servers outside Electron. */
export class PlainSecretBox implements SecretBox {
  encrypt(plain: string) {
    return plain;
  }
  decrypt(sealed: string) {
    return sealed;
  }
}

export function freshState(): CloudState {
  return { deviceId: `dev_${randomUUID()}`, session: null, syncEnabled: false, lastSyncedAt: null, lastError: null, drives: [] };
}

export class MemoryStateStore implements CloudStateStore {
  constructor(private state: CloudState = freshState()) {}
  async load() {
    return structuredClone(this.state);
  }
  async save(state: CloudState) {
    this.state = structuredClone(state);
  }
}

type OnDisk = Omit<CloudState, "session"> & { session: { sealedToken: string; user: CloudUser } | null };

/** A JSON file next to the catalog, with the token sealed by a `SecretBox`. */
export class JsonFileStateStore implements CloudStateStore {
  constructor(
    private readonly path: string,
    private readonly secrets: SecretBox,
  ) {}

  async load(): Promise<CloudState> {
    let disk: OnDisk;
    try {
      disk = JSON.parse(await readFile(this.path, "utf8")) as OnDisk;
    } catch {
      const state = freshState();
      await this.save(state);
      return state;
    }
    let session: CloudState["session"] = null;
    if (disk.session) {
      try {
        session = { token: this.secrets.decrypt(disk.session.sealedToken), user: disk.session.user };
      } catch {
        session = null; // Sealed on another machine or by another OS user: sign in again.
      }
    }
    return { ...freshState(), ...disk, session };
  }

  async save(state: CloudState) {
    const disk: OnDisk = {
      ...state,
      session: state.session ? { sealedToken: this.secrets.encrypt(state.session.token), user: state.session.user } : null,
    };
    await mkdir(dirname(this.path), { recursive: true });
    const temp = `${this.path}.${randomUUID()}.tmp`;
    await writeFile(temp, JSON.stringify(disk, null, 2), { mode: 0o600 });
    await rename(temp, this.path);
  }
}
