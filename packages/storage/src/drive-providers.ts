import { type AccessTokenSource, DriveApiError, DriveHttp, type DriveObjectStorage } from "./drive-storage.js";
import { GOOGLE_FOLDER, GoogleDriveStorage, quoteGoogle } from "./google-drive.js";
import { GRAPH, OneDriveStorage } from "./onedrive.js";

/** Drives a person can bring and connect to their account. */
export type DriveProviderId = "google-drive" | "onedrive";

export const DRIVE_PROVIDER_IDS: readonly DriveProviderId[] = ["google-drive", "onedrive"];

/** This server's OAuth app at the provider. */
export type OAuthClient = { clientId: string; clientSecret: string };

/** What an authorization gives us. `refreshToken` is what we keep; the rest is short-lived. */
export type DriveTokens = { accessToken: string; refreshToken: string; expiresAt: string };

/** Whose drive it is, as the provider tells it. `accountId` stays the same if they rename. */
export type DriveAccount = { accountId: string; email: string | null; name: string | null };

/** The refresh token stopped working (revoked, expired, password changed): connect again. */
export class DriveAuthorizationError extends Error {
  constructor(message = "This drive needs to be connected again") {
    super(message);
    this.name = "DriveAuthorizationError";
  }
}

type TokenResponse = { access_token?: string; refresh_token?: string; expires_in?: number; error?: string; error_description?: string };

/**
 * One kind of personal drive: how to ask the person for access (OAuth 2.0 with PKCE), who the
 * account is, where the app's folder is, and the `ObjectStorage` that works on it. The server
 * talks to every drive through this class and `ObjectStorage`, never to a provider directly.
 */
export abstract class DriveProvider {
  abstract readonly id: DriveProviderId;
  /** How people know it, e.g. "Google Drive". */
  abstract readonly label: string;
  protected abstract readonly authorizeEndpoint: string;
  protected abstract readonly tokenEndpoint: string;
  protected abstract readonly scopes: string[];
  /** Microsoft wants the scopes again when refreshing; Google does not. */
  protected readonly scopeOnRefresh: boolean = false;

  constructor(
    protected readonly client: OAuthClient,
    protected readonly fetchImpl: typeof fetch = fetch,
  ) {}

  /** Extra query parameters the provider needs to hand out a refresh token and an account picker. */
  protected abstract authorizeParams(): Record<string, string>;
  abstract account(tokens: AccessTokenSource): Promise<DriveAccount>;
  /** Finds or makes the app's folder in the drive and returns its id. */
  abstract prepareRoot(tokens: AccessTokenSource): Promise<string>;
  abstract storage(tokens: AccessTokenSource, rootId: string): DriveObjectStorage;
  /** Tells the provider we no longer want access. Best effort. */
  async revoke(_refreshToken: string): Promise<void> {}

  authorizeUrl(input: { redirectUri: string; state: string; codeChallenge: string }) {
    const url = new URL(this.authorizeEndpoint);
    const params = {
      client_id: this.client.clientId,
      redirect_uri: input.redirectUri,
      response_type: "code",
      scope: this.scopes.join(" "),
      state: input.state,
      code_challenge: input.codeChallenge,
      code_challenge_method: "S256",
      ...this.authorizeParams(),
    };
    for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value);
    return url.toString();
  }

  exchangeCode(input: { code: string; redirectUri: string; codeVerifier: string }) {
    return this.token({ grant_type: "authorization_code", code: input.code, redirect_uri: input.redirectUri, code_verifier: input.codeVerifier }, null);
  }

  /** A fresh access token. Keeps the old refresh token unless the provider sends a new one. */
  refresh(refreshToken: string) {
    const scope = this.scopeOnRefresh ? { scope: this.scopes.join(" ") } : {};
    return this.token({ grant_type: "refresh_token", refresh_token: refreshToken, ...scope }, refreshToken);
  }

  private async token(params: Record<string, string>, previousRefresh: string | null): Promise<DriveTokens> {
    let response: Response;
    try {
      response = await this.fetchImpl(this.tokenEndpoint, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
        body: new URLSearchParams({ ...params, client_id: this.client.clientId, client_secret: this.client.clientSecret }),
      });
    } catch {
      throw new DriveApiError(`Can't reach ${this.label}. Check your internet connection.`, 0);
    }
    const body = (await response.json().catch(() => ({}))) as TokenResponse;
    if (!response.ok || !body.access_token) {
      if (body.error === "invalid_grant") throw new DriveAuthorizationError();
      throw new DriveApiError(body.error_description || body.error || `${this.label} refused the sign-in (${response.status})`, response.status || 502, body.error ?? null);
    }
    const refreshToken = body.refresh_token ?? previousRefresh;
    if (!refreshToken) throw new DriveApiError(`${this.label} did not allow offline access. Try connecting again.`, 400);
    return {
      accessToken: body.access_token,
      refreshToken,
      expiresAt: new Date(Date.now() + (body.expires_in ?? 3600) * 1000).toISOString(),
    };
  }
}

/** Folder the app keeps its files in, in the person's Google Drive. */
export const GOOGLE_ROOT_FOLDER = "Memories";

export class GoogleDriveProvider extends DriveProvider {
  readonly id = "google-drive";
  readonly label = "Google Drive";
  protected readonly authorizeEndpoint = "https://accounts.google.com/o/oauth2/v2/auth";
  protected readonly tokenEndpoint = "https://oauth2.googleapis.com/token";
  /** `drive.file`: only the files Memories made. Not the rest of the person's drive. */
  protected readonly scopes = ["openid", "email", "https://www.googleapis.com/auth/drive.file"];

  protected authorizeParams() {
    // `consent` makes Google hand out a refresh token every time; `select_account` lets someone
    // pick a second Google account to connect.
    return { access_type: "offline", prompt: "consent select_account", include_granted_scopes: "true" };
  }

  async account(tokens: AccessTokenSource): Promise<DriveAccount> {
    const about = await new DriveHttp(tokens, this.fetchImpl, this.label).json<{ user?: { permissionId?: string; emailAddress?: string; displayName?: string } }>(
      "https://www.googleapis.com/drive/v3/about?fields=user(permissionId,emailAddress,displayName)",
    );
    const user = about?.user;
    if (!user?.permissionId) throw new DriveApiError("Google Drive did not say whose drive this is", 502);
    return { accountId: user.permissionId, email: user.emailAddress ?? null, name: user.displayName ?? null };
  }

  async prepareRoot(tokens: AccessTokenSource) {
    const http = new DriveHttp(tokens, this.fetchImpl, this.label);
    // With `drive.file` this only finds a folder Memories made, never one the person made.
    const q = `name = ${quoteGoogle(GOOGLE_ROOT_FOLDER)} and mimeType = '${GOOGLE_FOLDER}' and 'root' in parents and trashed = false`;
    const found = await http.json<{ files?: Array<{ id: string }> }>(`https://www.googleapis.com/drive/v3/files?${new URLSearchParams({ q, fields: "files(id)", pageSize: "1" })}`);
    if (found?.files?.[0]) return found.files[0].id;
    const made = await http.json<{ id: string }>("https://www.googleapis.com/drive/v3/files?fields=id", {
      method: "POST",
      json: { name: GOOGLE_ROOT_FOLDER, mimeType: GOOGLE_FOLDER, parents: ["root"] },
    });
    return made!.id;
  }

  storage(tokens: AccessTokenSource, rootId: string) {
    return new GoogleDriveStorage({ tokens, rootFolderId: rootId, fetch: this.fetchImpl });
  }

  override async revoke(refreshToken: string) {
    await this.fetchImpl(`https://oauth2.googleapis.com/revoke?${new URLSearchParams({ token: refreshToken })}`, { method: "POST" }).catch(() => undefined);
  }
}

export class OneDriveProvider extends DriveProvider {
  readonly id = "onedrive";
  readonly label = "OneDrive";
  protected readonly authorizeEndpoint: string;
  protected readonly tokenEndpoint: string;
  /** `Files.ReadWrite.AppFolder`: only OneDrive's `Apps/Memories` folder. */
  protected readonly scopes = ["offline_access", "User.Read", "Files.ReadWrite.AppFolder"];
  protected override readonly scopeOnRefresh = true;

  /** `tenantId` `common` takes personal and work or school accounts. */
  constructor(client: OAuthClient & { tenantId?: string }, fetchImpl?: typeof fetch) {
    super(client, fetchImpl);
    const tenant = encodeURIComponent(client.tenantId ?? "common");
    this.authorizeEndpoint = `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/authorize`;
    this.tokenEndpoint = `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`;
  }

  protected authorizeParams() {
    return { prompt: "select_account", response_mode: "query" };
  }

  async account(tokens: AccessTokenSource): Promise<DriveAccount> {
    const http = new DriveHttp(tokens, this.fetchImpl, this.label);
    const [drive, me] = await Promise.all([
      http.json<{ id?: string }>(`${GRAPH}/me/drive?$select=id`),
      http.json<{ mail?: string | null; userPrincipalName?: string; displayName?: string }>(`${GRAPH}/me?$select=mail,userPrincipalName,displayName`),
    ]);
    if (!drive?.id) throw new DriveApiError("OneDrive did not say whose drive this is", 502);
    return { accountId: drive.id, email: me?.mail ?? me?.userPrincipalName ?? null, name: me?.displayName ?? null };
  }

  async prepareRoot(tokens: AccessTokenSource) {
    // Reading the app folder makes it the first time.
    const root = await new DriveHttp(tokens, this.fetchImpl, this.label).json<{ id: string }>(`${GRAPH}/me/drive/special/approot?$select=id`);
    return root!.id;
  }

  storage(tokens: AccessTokenSource, _rootId: string) {
    return new OneDriveStorage({ tokens, fetch: this.fetchImpl });
  }
}

export type DriveProviderSettings = Partial<Record<DriveProviderId, OAuthClient & { tenantId?: string }>>;

/** The drives this server can connect: every provider with an OAuth client set up. */
export function createDriveProviders(settings: DriveProviderSettings, fetchImpl?: typeof fetch) {
  const providers = new Map<DriveProviderId, DriveProvider>();
  if (settings["google-drive"]) providers.set("google-drive", new GoogleDriveProvider(settings["google-drive"], fetchImpl));
  if (settings.onedrive) providers.set("onedrive", new OneDriveProvider(settings.onedrive, fetchImpl));
  return providers;
}

/**
 * Reads `GOOGLE_DRIVE_CLIENT_ID`/`_SECRET` and `ONEDRIVE_CLIENT_ID`/`_SECRET` (plus optional
 * `ONEDRIVE_TENANT_ID`). A drive is offered only when both its id and secret are set.
 */
export function driveProviderSettingsFromEnv(env: Record<string, string | undefined>): DriveProviderSettings {
  const settings: DriveProviderSettings = {};
  if (env.GOOGLE_DRIVE_CLIENT_ID && env.GOOGLE_DRIVE_CLIENT_SECRET) {
    settings["google-drive"] = { clientId: env.GOOGLE_DRIVE_CLIENT_ID, clientSecret: env.GOOGLE_DRIVE_CLIENT_SECRET };
  }
  if (env.ONEDRIVE_CLIENT_ID && env.ONEDRIVE_CLIENT_SECRET) {
    settings.onedrive = {
      clientId: env.ONEDRIVE_CLIENT_ID,
      clientSecret: env.ONEDRIVE_CLIENT_SECRET,
      ...(env.ONEDRIVE_TENANT_ID ? { tenantId: env.ONEDRIVE_TENANT_ID } : {}),
    };
  }
  return settings;
}
