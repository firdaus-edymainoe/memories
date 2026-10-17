import type { CloudDriveProvider, ConnectedDrive, DriveConnectionRecord, DriveConnectionStore } from "@memories/core";
import {
  type AccessToken,
  type AccessTokenSource,
  type DriveAccount,
  DriveAuthorizationError,
  type DriveProvider,
  type DriveProviderId,
  type DriveTokens,
  type ObjectStorage,
} from "@memories/storage";
import { randomBytes, timingSafeEqual } from "node:crypto";
import * as z from "zod";
import { CloudSpace } from "./cloud-files.js";
import { isDesktopRedirect, pkceChallenge } from "./desktop-sign-in.js";
import type { TokenVault } from "./token-vault.js";

/** The provider sends the browser back here after the person allows access to their drive. */
export const DRIVE_CALLBACK_PATH = "/drives/callback";
/** The desktop app's own loopback page that finishes connecting a drive. */
export const DESKTOP_DRIVE_CALLBACK_PATH = "/cloud/drives/callback";

const START_TTL_MS = 15 * 60 * 1000;
const HANDOFF_TTL_MS = 5 * 60 * 1000;
const REFRESH_EARLY_MS = 60 * 1000;
const CACHE_LIMIT = 200;

/** The request named something that doesn't exist or isn't allowed. Nothing changed. */
export class DriveConnectInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DriveConnectInputError";
  }
}

export class DriveNotFoundError extends Error {
  constructor() {
    super("That drive isn't connected to your account");
    this.name = "DriveNotFoundError";
  }
}

/** The person has to connect the drive again (they revoked access, or it expired). */
export class DriveReconnectError extends Error {
  readonly code = "RECONNECT";
  constructor(label: string) {
    super(`${label} needs to be connected again`);
    this.name = "DriveReconnectError";
  }
}

export const connectBody = z.object({
  provider: z.enum(["google-drive", "onedrive"]),
  redirectUri: z
    .string()
    .max(200)
    .refine((value) => isDesktopRedirect(value, DESKTOP_DRIVE_CALLBACK_PATH), "redirectUri must be the app's loopback callback"),
  state: z.string().min(16).max(200),
  codeChallenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/, "codeChallenge must be an S256 challenge"),
});

export const completeBody = z.object({
  code: z.string().min(1).max(8000),
  codeVerifier: z.string().regex(/^[A-Za-z0-9._~-]{43,128}$/),
  redirectUri: z.string().max(200),
});

/** Sealed into the provider's `state`: who asked, and how to get back to their app. */
type Started = {
  kind: "drive-start";
  userId: string;
  provider: DriveProviderId;
  redirectUri: string;
  appState: string;
  codeChallenge: string;
  verifier: string;
  expiresAt: number;
};

/** Sealed into the one-time code sent back to the app. Only the app's PKCE verifier opens it. */
type Handoff = {
  kind: "drive-handoff";
  userId: string;
  provider: DriveProviderId;
  redirectUri: string;
  codeChallenge: string;
  tokens: DriveTokens;
  account: DriveAccount;
  expiresAt: number;
};

const random = () => randomBytes(32).toString("base64url");

function sameText(a: string, b: string) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** A token source for a drive we only hold a fresh authorization for (while connecting it). */
class FixedTokens implements AccessTokenSource {
  constructor(private readonly tokens: DriveTokens) {}
  async token() {
    return { value: this.tokens.accessToken, expiresAt: new Date(this.tokens.expiresAt) };
  }
  expire() {}
}

export type DriveConnectionsOptions = {
  providers: Map<DriveProviderId, DriveProvider>;
  store: DriveConnectionStore;
  /** Seals tokens at rest and the hand-off codes. */
  vault: TokenVault;
  /** Public URL of this server. */
  baseURL: string;
  now?: () => Date;
};

/**
 * People's own drives (Google Drive, OneDrive), connected to their account. Someone can connect
 * several, of either kind. The app reaches each drive's files through the same storage contract
 * as Memories Cloud (`CloudSpace` on `ObjectStorage`), so nothing else knows which drive it is.
 *
 * Connecting follows the desktop sign-in (RFC 8252): the app sends a PKCE challenge, the person
 * allows access in their browser, this server trades the provider's code for tokens and sends a
 * sealed one-time code back to the app on 127.0.0.1, and only the app with the verifier can turn
 * it into a connection on its own signed-in account.
 */
export class DriveConnections {
  private readonly now: () => Date;
  private readonly cache = new Map<string, ObjectStorage>();

  constructor(private readonly options: DriveConnectionsOptions) {
    this.now = options.now ?? (() => new Date());
  }

  /** Drives this server can connect. */
  available(): CloudDriveProvider[] {
    return [...this.options.providers.keys()];
  }

  private provider(id: DriveProviderId) {
    const provider = this.options.providers.get(id);
    if (!provider) throw new DriveConnectInputError(`Connecting ${id} isn't set up on this server`);
    return provider;
  }

  private get callbackUrl() {
    return `${this.options.baseURL}${DRIVE_CALLBACK_PATH}`;
  }

  /** Where the person's browser goes to allow access to their drive. */
  start(userId: string, input: z.infer<typeof connectBody>) {
    const provider = this.provider(input.provider);
    const verifier = random();
    const started: Started = {
      kind: "drive-start",
      userId,
      provider: provider.id,
      redirectUri: input.redirectUri,
      appState: input.state,
      codeChallenge: input.codeChallenge,
      verifier,
      expiresAt: this.now().getTime() + START_TTL_MS,
    };
    const url = provider.authorizeUrl({
      redirectUri: this.callbackUrl,
      state: this.options.vault.seal(started),
      codeChallenge: pkceChallenge(verifier),
    });
    return { url };
  }

  /**
   * The provider's redirect. Returns where to send the browser: back to the app with a one-time
   * code, or with `error` if the person said no.
   */
  async callback(query: { code?: string; state?: string; error?: string }): Promise<string> {
    const started = query.state ? this.options.vault.open<Started>(query.state) : null;
    if (!started || started.kind !== "drive-start" || started.expiresAt < this.now().getTime()) {
      throw new DriveConnectInputError("This link has expired. Go back to Memories and try again.");
    }
    const back = new URL(started.redirectUri);
    back.searchParams.set("state", started.appState);
    if (query.error || !query.code) {
      back.searchParams.set("error", query.error === "access_denied" ? "access_denied" : "failed");
      return back.toString();
    }
    const provider = this.provider(started.provider);
    const tokens = await provider.exchangeCode({ code: query.code, redirectUri: this.callbackUrl, codeVerifier: started.verifier });
    const account = await provider.account(new FixedTokens(tokens));
    const handoff: Handoff = {
      kind: "drive-handoff",
      userId: started.userId,
      provider: started.provider,
      redirectUri: started.redirectUri,
      codeChallenge: started.codeChallenge,
      tokens,
      account,
      expiresAt: this.now().getTime() + HANDOFF_TTL_MS,
    };
    back.searchParams.set("code", this.options.vault.seal(handoff));
    return back.toString();
  }

  /** The app trades the one-time code and its verifier for the connection. */
  async complete(userId: string, input: z.infer<typeof completeBody>): Promise<ConnectedDrive> {
    const handoff = this.options.vault.open<Handoff>(input.code);
    if (!handoff || handoff.kind !== "drive-handoff" || handoff.expiresAt < this.now().getTime()) {
      throw new DriveConnectInputError("This link has expired. Try connecting the drive again.");
    }
    if (handoff.userId !== userId || handoff.redirectUri !== input.redirectUri || !sameText(pkceChallenge(input.codeVerifier), handoff.codeChallenge)) {
      throw new DriveConnectInputError("This link is not for this app");
    }
    const provider = this.provider(handoff.provider);
    const rootId = await provider.prepareRoot(new FixedTokens(handoff.tokens));
    const existing = await this.options.store.findByAccount(userId, provider.id, handoff.account.accountId);
    const email = handoff.account.email;
    const record: DriveConnectionRecord = {
      userId,
      id: existing?.id ?? `drv_${randomBytes(12).toString("base64url")}`,
      provider: provider.id,
      accountId: handoff.account.accountId,
      label: existing?.label ?? (email ? `${provider.label} (${email})` : provider.label),
      email,
      status: "connected",
      rootId,
      sealedTokens: this.options.vault.seal(handoff.tokens),
      connectedAt: existing?.connectedAt ?? this.now().toISOString(),
    };
    await this.options.store.save(record);
    this.forget(userId, record.id);
    return publicView(record);
  }

  async list(userId: string): Promise<ConnectedDrive[]> {
    return (await this.options.store.list(userId)).map(publicView);
  }

  private async record(userId: string, id: string) {
    const record = await this.options.store.get(userId, id);
    if (!record) throw new DriveNotFoundError();
    return record;
  }

  async rename(userId: string, id: string, label: string) {
    const record = await this.record(userId, id);
    const next = { ...record, label };
    await this.options.store.save(next);
    return publicView(next);
  }

  /** Forgets the drive. The files stay in the person's drive; we just stop having access. */
  async disconnect(userId: string, id: string) {
    const record = await this.record(userId, id);
    const tokens = this.options.vault.open<DriveTokens>(record.sealedTokens);
    if (tokens) await this.options.providers.get(record.provider)?.revoke(tokens.refreshToken).catch(() => undefined);
    await this.options.store.remove(userId, id);
    this.forget(userId, id);
  }

  /** The person's account is gone: drop every connection (their files stay in their drives). */
  async removeUser(userId: string) {
    for (const record of await this.options.store.list(userId)) await this.disconnect(userId, record.id).catch(() => undefined);
    await this.options.store.removeUser(userId);
  }

  /** The files in one connected drive, through the same contract as Memories Cloud. */
  async space(userId: string, id: string): Promise<CloudSpace> {
    const record = await this.record(userId, id);
    if (record.status === "reconnect") throw new DriveReconnectError(record.label);
    const key = `${userId}/${id}`;
    let storage = this.cache.get(key);
    if (!storage) {
      const provider = this.provider(record.provider);
      storage = provider.storage(new ConnectionTokens(record, provider, this.options.store, this.options.vault, this.now), record.rootId);
      if (this.cache.size >= CACHE_LIMIT) this.cache.delete(this.cache.keys().next().value!);
      this.cache.set(key, storage);
    }
    return new CloudSpace(storage);
  }

  private forget(userId: string, id: string) {
    this.cache.delete(`${userId}/${id}`);
  }
}

function publicView(record: DriveConnectionRecord): ConnectedDrive {
  return {
    id: record.id,
    provider: record.provider,
    label: record.label,
    email: record.email,
    status: record.status,
    connectedAt: record.connectedAt,
  };
}

/**
 * Access tokens for one stored connection. Uses the saved access token while it is fresh,
 * refreshes it when it runs out (saving what the provider sends back, since Microsoft rotates
 * refresh tokens), and marks the drive for reconnecting when the provider revokes access.
 */
class ConnectionTokens implements AccessTokenSource {
  private current: AccessToken | null = null;
  private refreshing: Promise<AccessToken> | null = null;
  private stale = false;

  constructor(
    private readonly initial: DriveConnectionRecord,
    private readonly provider: DriveProvider,
    private readonly store: DriveConnectionStore,
    private readonly vault: TokenVault,
    private readonly now: () => Date,
  ) {}

  private fresh(token: AccessToken | null): token is AccessToken {
    return token !== null && token.expiresAt.getTime() - REFRESH_EARLY_MS > this.now().getTime();
  }

  async token() {
    if (!this.stale && this.fresh(this.current)) return this.current;
    this.refreshing ??= this.load().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  expire() {
    this.current = null;
    this.stale = true;
  }

  private async load(): Promise<AccessToken> {
    // Read again: another request or server may have refreshed it already.
    const record = (await this.store.get(this.initial.userId, this.initial.id)) ?? this.initial;
    if (record.status === "reconnect") throw new DriveReconnectError(record.label);
    const saved = this.vault.open<DriveTokens>(record.sealedTokens);
    if (!saved) return this.reconnect(record);
    const savedToken = { value: saved.accessToken, expiresAt: new Date(saved.expiresAt) };
    if (!this.stale && this.fresh(savedToken)) {
      this.current = savedToken;
      return savedToken;
    }
    let tokens: DriveTokens;
    try {
      tokens = await this.provider.refresh(saved.refreshToken);
    } catch (error) {
      if (error instanceof DriveAuthorizationError) return this.reconnect(record);
      throw error;
    }
    await this.store.save({ ...record, sealedTokens: this.vault.seal(tokens) });
    this.stale = false;
    this.current = { value: tokens.accessToken, expiresAt: new Date(tokens.expiresAt) };
    return this.current;
  }

  private async reconnect(record: DriveConnectionRecord): Promise<never> {
    await this.store.save({ ...record, status: "reconnect" });
    throw new DriveReconnectError(record.label);
  }
}
