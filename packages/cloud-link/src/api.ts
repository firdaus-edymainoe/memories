import type {
  CloudAdminUser,
  CloudCatalogGateway,
  CloudDevice,
  CloudProvider,
  CloudRole,
  CloudUser,
  SyncBatch,
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

export type PresignedRequest = { method: "GET" | "PUT"; url: string; headers: Record<string, string>; expiresAt: string };
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

export function toCloudUser(user: AuthUser): CloudUser {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: (user.role === "admin" ? "admin" : "user") satisfies CloudRole,
    emailVerified: Boolean(user.emailVerified),
    image: user.image ?? null,
  };
}

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

  private async call<T>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<{ body: T; response: Response }> {
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
    return this.call<{ providers: CloudProvider[]; storage: string }>("/v1/config").then((r) => r.body);
  }

  private async session(path: string, json: unknown) {
    const { body, response } = await this.call<{ token?: string; user: AuthUser }>(path, { method: "POST", json });
    const token = response.headers.get("set-auth-token") ?? body.token;
    if (!token) throw new CloudApiError("The server did not start a session", 500);
    return { token, user: toCloudUser(body.user) };
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
    }).then((r) => ({ token: r.body.token, user: toCloudUser(r.body.user) }));
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

  listStorage(path: string, recursive = false) {
    const params = new URLSearchParams({ path });
    if (recursive) params.set("recursive", "1");
    return this.call<{ entries: CloudEntry[] }>(`/v1/storage/list?${params}`).then((r) => r.body.entries);
  }

  async statStorage(path: string): Promise<CloudFileStat | null> {
    try {
      return (await this.call<{ file: CloudFileStat }>(`/v1/storage/stat?${new URLSearchParams({ path })}`)).body.file;
    } catch (error) {
      if (error instanceof CloudApiError && error.status === 404) return null;
      throw error;
    }
  }

  prepareUpload(input: { path: string; size: number; sha256: string; contentType: string }) {
    return this.call<{ upload: PresignedRequest }>("/v1/storage/uploads", { method: "POST", json: input }).then((r) => r.body.upload);
  }

  prepareDownload(path: string) {
    return this.call<{ download: PresignedRequest }>("/v1/storage/downloads", { method: "POST", json: { path } }).then(
      (r) => r.body.download,
    );
  }

  async copyStorage(from: string, to: string) {
    await this.call("/v1/storage/copy", { method: "POST", json: { from, to } });
  }

  async removeStorage(path: string) {
    await this.call(`/v1/storage/object?${new URLSearchParams({ path })}`, { method: "DELETE" });
  }

  /** Sends a signed request straight to the storage provider. */
  async sendSigned(request: PresignedRequest, init: { body?: BodyInit; range?: { start: number; end: number } } = {}) {
    const headers = new Headers(request.headers);
    if (init.range) headers.set("range", `bytes=${init.range.start}-${init.range.end}`);
    const body = init.body;
    let response: Response;
    try {
      response = await this.fetchImpl(request.url, {
        method: request.method,
        headers,
        ...(body !== undefined ? { body } : {}),
        // Node's fetch needs this to send a stream as the body.
        ...(body instanceof ReadableStream ? ({ duplex: "half" } as RequestInit) : {}),
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
      ...toCloudUser(user),
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
