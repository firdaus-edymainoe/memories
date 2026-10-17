import {
  type CloudAdminUser,
  type CloudCatalogGateway,
  type CloudDevice,
  type CloudDriveProvider,
  type CloudProvider,
  type ConnectedDrive,
  type CloudRole,
  type CloudUser,
  type SyncBatch,
  cloudUserFrom,
} from "@memories/core";

/** A failed call to the cloud server. `status` 0 means it could not be reached. */
export class CloudApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | null = null,
  ) {
    super(message);
    this.name = "CloudApiError";
  }
}

export type PresignedRequest = {
  method: "GET" | "PUT";
  url: string;
  headers: Record<string, string>;
  expiresAt: string;
  /** Send the upload in consecutive pieces of at most `maxBytes`, each with `content-range`. */
  chunked?: { maxBytes: number };
};
export type CloudEntry = { path: string; directory: boolean; size: number; modifiedAt: string | null };
export type CloudFileStat = { path: string; size: number; modifiedAt: string; contentType: string | null; sha256: string | null };

type AuthUser = {
  id: string;
  email: string;
  name: string;
  role?: string | null;
  emailVerified: boolean;
  image?: string | null;
  banned?: boolean | null;
  banReason?: string | null;
  createdAt?: string;
};

/**
 * HTTP client for the Memories cloud server (`apps/cloud`). Runs in the desktop app's main
 * process; the session token never reaches the UI.
 */
export class CloudApi implements CloudCatalogGateway {
  constructor(
    readonly serverUrl: string,
    private readonly token: () => string | null = () => null,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  /** @internal Used by `CloudStorageClient`. */
  async call<T>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<{ body: T; response: Response }> {
    const headers = new Headers(init.headers);
    const token = this.token();
    if (token) headers.set("authorization", `Bearer ${token}`);
    let body = init.body;
    if (init.json !== undefined) {
      headers.set("content-type", "application/json");
      body = JSON.stringify(init.json);
    }
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.serverUrl}${path}`, { ...init, headers, ...(body !== undefined ? { body } : {}) });
    } catch {
      throw new CloudApiError("Can't reach Memories Cloud. Check your internet connection.", 0);
    }
    const text = await response.text();
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }
    if (!response.ok) {
      const error = parsed as { error?: string; message?: string; code?: string } | null;
      throw new CloudApiError(error?.message || error?.error || response.statusText || "Request failed", response.status, error?.code ?? null);
    }
    return { body: parsed as T, response };
  }

  config() {
    return this.call<{ providers: CloudProvider[]; storage: string; drives?: CloudDriveProvider[] }>("/v1/config").then((r) => r.body);
  }

  private async session(path: string, json: unknown) {
    const { body, response } = await this.call<{ token?: string; user: AuthUser }>(path, { method: "POST", json });
    const token = response.headers.get("set-auth-token") ?? body.token;
    if (!token) throw new CloudApiError("The server did not start a session", 500);
    return { token, user: cloudUserFrom(body.user) };
  }

  signUp(input: { name: string; email: string; password: string; callbackURL?: string }) {
    return this.session("/api/auth/sign-up/email", input);
  }

  signIn(input: { email: string; password: string }) {
    return this.session("/api/auth/sign-in/email", { ...input, rememberMe: true });
  }

  /** Trades the one-time code from the browser hand-off for this app's own session. */
  exchangeDesktopCode(input: { code: string; codeVerifier: string; redirectUri: string }) {
    return this.call<{ token: string; user: AuthUser }>("/api/auth/desktop/token", {
      method: "POST",
      json: { code: input.code, code_verifier: input.codeVerifier, redirect_uri: input.redirectUri },
    }).then((r) => ({ token: r.body.token, user: cloudUserFrom(r.body.user) }));
  }

  /** Where the system browser goes to sign in with a provider. */
  desktopSignInUrl(input: { provider: CloudProvider; redirectUri: string; state: string; codeChallenge: string }) {
    const url = new URL("/desktop/sign-in", this.serverUrl);
    url.searchParams.set("provider", input.provider);
    url.searchParams.set("redirect_uri", input.redirectUri);
    url.searchParams.set("state", input.state);
    url.searchParams.set("code_challenge", input.codeChallenge);
    url.searchParams.set("code_challenge_method", "S256");
    return url.toString();
  }

  async signOut() {
    await this.call("/api/auth/sign-out", { method: "POST", json: {} });
  }

  async requestPasswordReset(email: string) {
    await this.call("/api/auth/request-password-reset", {
      method: "POST",
      json: { email, redirectTo: `${this.serverUrl}/reset-password` },
    });
  }

  async sendVerificationEmail(email: string) {
    await this.call("/api/auth/send-verification-email", { method: "POST", json: { email, callbackURL: `${this.serverUrl}/` } });
  }

  me() {
    return this.call<{ user: CloudUser }>("/v1/me").then((r) => r.body.user);
  }

  registerDevice(device: { id: string; name: string; platform: string }) {
    return this.call<{ device: CloudDevice }>(`/v1/devices/${encodeURIComponent(device.id)}`, {
      method: "PUT",
      json: { name: device.name, platform: device.platform },
    }).then((r) => r.body.device);
  }

  async push(batch: SyncBatch) {
    await this.call("/v1/sync", { method: "POST", json: batch });
  }

  /** Files in Memories Cloud (`null`) or in one of the person's own drives. Same API for both. */
  storage(driveId: string | null) {
    return new CloudStorageClient(this, driveId === null ? "/v1/storage" : `/v1/drives/${encodeURIComponent(driveId)}/storage`);
  }

  // The person's own drives (Google Drive, OneDrive)

  listDrives() {
    return this.call<{ providers: CloudDriveProvider[]; drives: ConnectedDrive[] }>("/v1/drives").then((r) => r.body);
  }

  /** Where the system browser goes so the person can allow access to their drive. */
  startDriveConnection(input: { provider: CloudDriveProvider; redirectUri: string; state: string; codeChallenge: string }) {
    return this.call<{ url: string }>("/v1/drives/connect", { method: "POST", json: input }).then((r) => r.body.url);
  }

  completeDriveConnection(input: { code: string; codeVerifier: string; redirectUri: string }) {
    return this.call<{ drive: ConnectedDrive }>("/v1/drives/complete", { method: "POST", json: input }).then((r) => r.body.drive);
  }

  renameDrive(driveId: string, label: string) {
    return this.call<{ drive: ConnectedDrive }>(`/v1/drives/${encodeURIComponent(driveId)}`, { method: "PATCH", json: { label } }).then(
      (r) => r.body.drive,
    );
  }

  async disconnectDrive(driveId: string) {
    await this.call(`/v1/drives/${encodeURIComponent(driveId)}`, { method: "DELETE" });
  }

  /** Sends a signed request straight to the storage provider. */
  async sendSigned(request: PresignedRequest, init: { body?: RequestInit["body"]; range?: { start: number; end: number } } = {}) {
    const headers = new Headers(request.headers);
    if (init.range) headers.set("range", `bytes=${init.range.start}-${init.range.end}`);
    return this.fetchSigned(request.url, { method: request.method, headers, ...(init.body !== undefined ? { body: init.body } : {}) });
  }

  /**
   * Uploads through a signed request: in one PUT, or piece by piece when the provider asks for
   * it (OneDrive). Pieces are read from the stream as they are sent, so nothing is held whole.
   */
  async uploadSigned(request: PresignedRequest, body: ReadableStream<Uint8Array> | Uint8Array, size: number) {
    if (!request.chunked || size === 0) return this.sendSigned(request, { body: body as RequestInit["body"] });
    const max = request.chunked.maxBytes;
    let start = 0;
    let response: Response | null = null;
    for await (const piece of pieces(body, max)) {
      const headers = new Headers(request.headers);
      headers.set("content-range", `bytes ${start}-${start + piece.byteLength - 1}/${size}`);
      response = await this.fetchSigned(request.url, { method: request.method, headers, body: piece as NonNullable<RequestInit["body"]> });
      start += piece.byteLength;
    }
    if (start !== size) throw new CloudApiError("The file changed while it was uploading", 400);
    return response!;
  }

  private async fetchSigned(url: string, init: RequestInit) {
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        ...init,
        // Node's fetch needs this to send a stream as the body.
        ...(init.body instanceof ReadableStream ? ({ duplex: "half" } as RequestInit) : {}),
      });
    } catch {
      throw new CloudApiError("Can't reach cloud storage. Check your internet connection.", 0);
    }
    if (!response.ok) throw new CloudApiError(`Cloud storage refused the request (${response.status})`, response.status);
    return response;
  }

  // People management (admins only). These are Better Auth's admin endpoints.

  async listUsers(input: { search?: string; limit?: number; offset?: number } = {}) {
    const params = new URLSearchParams({ limit: String(input.limit ?? 100), offset: String(input.offset ?? 0), sortBy: "createdAt" });
    if (input.search) {
      params.set("searchValue", input.search);
      params.set("searchField", input.search.includes("@") ? "email" : "name");
      params.set("searchOperator", "contains");
    }
    const { body } = await this.call<{ users: AuthUser[]; total: number }>(`/api/auth/admin/list-users?${params}`);
    const users: CloudAdminUser[] = body.users.map((user) => ({
      ...cloudUserFrom(user),
      banned: Boolean(user.banned),
      banReason: user.banReason ?? null,
      createdAt: new Date(user.createdAt ?? 0).toISOString(),
    }));
    return { users, total: body.total };
  }

  async setRole(userId: string, role: CloudRole) {
    await this.call("/api/auth/admin/set-role", { method: "POST", json: { userId, role } });
  }

  async banUser(userId: string, reason?: string) {
    await this.call("/api/auth/admin/ban-user", { method: "POST", json: { userId, ...(reason ? { banReason: reason } : {}) } });
  }

  async unbanUser(userId: string) {
    await this.call("/api/auth/admin/unban-user", { method: "POST", json: { userId } });
  }

  async removeUser(userId: string) {
    await this.call("/api/auth/admin/remove-user", { method: "POST", json: { userId } });
  }
}

/** Cuts a body into pieces of exactly `max` bytes (the last one shorter). */
async function* pieces(body: ReadableStream<Uint8Array> | Uint8Array, max: number): AsyncGenerator<Uint8Array> {
  if (body instanceof Uint8Array) {
    for (let at = 0; at < body.byteLength; at += max) yield body.subarray(at, Math.min(at + max, body.byteLength));
    return;
  }
  const reader = body.getReader();
  let buffer = new Uint8Array(max);
  let filled = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    let offset = 0;
    while (offset < value.byteLength) {
      const take = Math.min(max - filled, value.byteLength - offset);
      buffer.set(value.subarray(offset, offset + take), filled);
      filled += take;
      offset += take;
      if (filled === max) {
        yield buffer;
        buffer = new Uint8Array(max);
        filled = 0;
      }
    }
  }
  if (filled > 0) yield buffer.subarray(0, filled);
}

/**
 * One storage space on the cloud server: Memories Cloud or a connected drive. The server signs
 * requests; bytes go straight between this computer and the provider.
 */
export class CloudStorageClient {
  constructor(
    private readonly api: CloudApi,
    private readonly base: string,
  ) {}

  list(path: string, recursive = false) {
    const params = new URLSearchParams({ path });
    if (recursive) params.set("recursive", "1");
    return this.api.call<{ entries: CloudEntry[] }>(`${this.base}/list?${params}`).then((r) => r.body.entries);
  }

  async stat(path: string): Promise<CloudFileStat | null> {
    try {
      return (await this.api.call<{ file: CloudFileStat }>(`${this.base}/stat?${new URLSearchParams({ path })}`)).body.file;
    } catch (error) {
      if (error instanceof CloudApiError && error.status === 404 && error.code === "ENOENT") return null;
      throw error;
    }
  }

  prepareUpload(input: { path: string; size: number; sha256: string; contentType: string }) {
    return this.api.call<{ upload: PresignedRequest }>(`${this.base}/uploads`, { method: "POST", json: input }).then((r) => r.body.upload);
  }

  prepareDownload(path: string) {
    return this.api.call<{ download: PresignedRequest }>(`${this.base}/downloads`, { method: "POST", json: { path } }).then((r) => r.body.download);
  }

  async copy(from: string, to: string) {
    await this.api.call(`${this.base}/copy`, { method: "POST", json: { from, to } });
  }

  async remove(path: string) {
    await this.api.call(`${this.base}/object?${new URLSearchParams({ path })}`, { method: "DELETE" });
  }
}
