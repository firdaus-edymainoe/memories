/**
 * Small stand-ins for the Google Drive and Microsoft Graph APIs, for tests. They answer only the
 * calls the adapters make, check the bearer token, and keep files in memory.
 */

type Handler = (request: Request) => Promise<Response> | Response;

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

function asFetch(handler: Handler): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input as RequestInfo, init);
    return handler(request);
  }) as typeof fetch;
}

export class FakeTokens {
  current = "token-1";
  issued = 1;
  expired = 0;
  async token() {
    return { value: this.current, expiresAt: new Date(Date.now() + 3600_000) };
  }
  expire() {
    this.expired++;
    this.issued++;
    this.current = `token-${this.issued}`;
  }
}

type GFile = { id: string; name: string; mimeType: string; parents: string[]; bytes?: Uint8Array; appProperties: Record<string, string>; trashed: boolean; modifiedTime: string };

const FOLDER = "application/vnd.google-apps.folder";

/** Google Drive v3, the parts `GoogleDriveStorage` uses. */
export class FakeGoogleDrive {
  files = new Map<string, GFile>();
  sessions = new Map<string, { name: string; parents: string[]; mimeType: string; appProperties: Record<string, string>; size: number }>();
  /** Valid tokens. A request with another token gets 401. */
  tokens = new Set(["token-1"]);
  /** Whose account each token belongs to (`about`). */
  owners = new Map<string, { permissionId: string; emailAddress: string; displayName: string }>([
    ["token-1", { permissionId: "acc-1", emailAddress: "me@gmail.com", displayName: "Me" }],
  ]);
  calls: string[] = [];
  private next = 1;

  constructor() {
    this.files.set("root-folder", { id: "root-folder", name: "Memories", mimeType: FOLDER, parents: ["root"], appProperties: {}, trashed: false, modifiedTime: "2026-01-01T00:00:00.000Z" });
  }

  private id() {
    return `g${this.next++}`;
  }

  private view(file: GFile) {
    return {
      id: file.id,
      name: file.name,
      mimeType: file.mimeType,
      ...(file.bytes ? { size: String(file.bytes.byteLength) } : {}),
      modifiedTime: file.modifiedTime,
      appProperties: file.appProperties,
    };
  }

  /** Understands the queries the adapter builds: parent, name, folder or not, trashed. */
  private matches(file: GFile, q: string) {
    const unquote = (text: string) => text.replace(/\\'/g, "'").replace(/\\\\/g, "\\");
    const parent = /'((?:[^'\\]|\\.)*)' in parents/.exec(q)?.[1];
    const name = /name = '((?:[^'\\]|\\.)*)'/.exec(q)?.[1];
    if (parent !== undefined && !file.parents.includes(unquote(parent))) return false;
    if (name !== undefined && file.name !== unquote(name)) return false;
    if (q.includes(`mimeType = '${FOLDER}'`) && file.mimeType !== FOLDER) return false;
    if (q.includes(`mimeType != '${FOLDER}'`) && file.mimeType === FOLDER) return false;
    if (q.includes("trashed = false") && file.trashed) return false;
    return true;
  }

  fetch = asFetch(async (request) => {
    const url = new URL(request.url);
    this.calls.push(`${request.method} ${url.pathname}`);
    if (url.pathname.startsWith("/upload/session/")) return this.receive(url.pathname.split("/").pop()!, request);
    const token = request.headers.get("authorization")?.replace(/^Bearer /, "");
    if (!token || !this.tokens.has(token)) return json({ error: { code: 401, message: "Invalid Credentials" } }, 401);

    if (url.pathname === "/drive/v3/about") return json({ user: this.owners.get(token) ?? this.owners.get("token-1") });
    const parts = url.pathname.replace(/^\/(upload\/)?drive\/v3\//, "").split("/");
    if (url.pathname === "/upload/drive/v3/files" && request.method === "POST") {
      const meta = (await request.json()) as { name: string; parents: string[]; mimeType: string; appProperties?: Record<string, string> };
      const session = this.id();
      this.sessions.set(session, {
        ...meta,
        appProperties: meta.appProperties ?? {},
        size: Number(request.headers.get("x-upload-content-length")),
      });
      return new Response(null, { status: 200, headers: { location: `https://www.googleapis.com/upload/session/${session}` } });
    }
    if (parts[0] !== "files") return json({ error: { message: "not found" } }, 404);
    if (parts.length === 1 && request.method === "GET") {
      const q = url.searchParams.get("q") ?? "";
      return json({ files: [...this.files.values()].filter((file) => this.matches(file, q)).map((file) => this.view(file)) });
    }
    if (parts.length === 1 && request.method === "POST") {
      const body = (await request.json()) as { name: string; mimeType: string; parents: string[] };
      const file: GFile = { id: this.id(), ...body, appProperties: {}, trashed: false, modifiedTime: new Date().toISOString() };
      this.files.set(file.id, file);
      return json(this.view(file));
    }
    const file = this.files.get(decodeURIComponent(parts[1]!));
    if (!file) return json({ error: { message: "File not found" } }, 404);
    if (parts[2] === "copy" && request.method === "POST") {
      const body = (await request.json()) as { name: string; parents: string[]; appProperties?: Record<string, string> };
      const copy: GFile = { ...file, id: this.id(), name: body.name, parents: body.parents, appProperties: body.appProperties ?? file.appProperties, modifiedTime: new Date().toISOString() };
      this.files.set(copy.id, copy);
      return json(this.view(copy));
    }
    if (request.method === "PATCH") {
      Object.assign(file, (await request.json()) as Partial<GFile>);
      return json(this.view(file));
    }
    if (request.method === "GET" && url.searchParams.get("alt") === "media") {
      const bytes = file.bytes ?? new Uint8Array();
      const range = /bytes=(\d+)-(\d+)/.exec(request.headers.get("range") ?? "");
      if (range) return new Response(bytes.slice(Number(range[1]), Number(range[2]) + 1) as BodyInit, { status: 206 });
      return new Response(bytes as BodyInit);
    }
    return json({ error: { message: "not handled" } }, 400);
  });

  private async receive(session: string, request: Request) {
    const pending = this.sessions.get(session);
    if (!pending) return json({ error: { message: "No such upload" } }, 404);
    const bytes = new Uint8Array(await request.arrayBuffer());
    if (bytes.byteLength !== pending.size) return json({ error: { message: "Wrong size" } }, 400);
    this.sessions.delete(session);
    const file: GFile = { id: this.id(), name: pending.name, mimeType: pending.mimeType, parents: pending.parents, bytes, appProperties: pending.appProperties, trashed: false, modifiedTime: new Date().toISOString() };
    this.files.set(file.id, file);
    return json(this.view(file));
  }

  /** The path of every file that is not trashed, below the Memories folder. */
  paths() {
    const pathOf = (file: GFile): string | null => {
      if (file.id === "root-folder") return "";
      const parent = this.files.get(file.parents[0]!);
      if (!parent) return null;
      const base = pathOf(parent);
      return base === null ? null : base ? `${base}/${file.name}` : file.name;
    };
    return [...this.files.values()].filter((file) => file.mimeType !== FOLDER && !file.trashed).map(pathOf).filter((path): path is string => path !== null).sort();
  }
}

type GItem = { id: string; name: string; parent: string | null; folder: boolean; bytes?: Uint8Array; description?: string; modified: string };

/** Microsoft Graph, the parts `OneDriveStorage` uses. The app folder is item `approot`. */
export class FakeGraph {
  items = new Map<string, GItem>([["approot", { id: "approot", name: "Memories", parent: null, folder: true, modified: "2026-01-01T00:00:00.000Z" }]]);
  sessions = new Map<string, { parent: string; name: string; description?: string; received: Uint8Array[]; size: number | null }>();
  monitors = new Map<string, number>();
  tokens = new Set(["token-1"]);
  /** Personal accounts keep descriptions; work accounts drop them. */
  keepDescriptions = true;
  email = "me@outlook.com";
  driveId = "drive-1";
  private next = 1;

  private id() {
    return `o${this.next++}`;
  }

  private childrenOf(id: string) {
    return [...this.items.values()].filter((item) => item.parent === id);
  }

  private find(parent: string, name: string) {
    return this.childrenOf(parent).find((item) => item.name.toLowerCase() === name.toLowerCase()) ?? null;
  }

  private resolve(path: string[]) {
    let current = this.items.get("approot")!;
    for (const name of path) {
      const found = this.find(current.id, name);
      if (!found) return null;
      current = found;
    }
    return current;
  }

  private view(item: GItem) {
    return {
      id: item.id,
      name: item.name,
      lastModifiedDateTime: item.modified,
      parentReference: { driveId: "drive-1", id: item.parent },
      ...(item.folder ? { folder: { childCount: this.childrenOf(item.id).length } } : { file: { mimeType: "application/octet-stream" }, size: item.bytes?.byteLength ?? 0 }),
      ...(item.description ? { description: item.description } : {}),
      ...(item.folder ? {} : { "@microsoft.graph.downloadUrl": `https://download.test/${item.id}` }),
    };
  }

  fetch = asFetch(async (request) => {
    const url = new URL(request.url);
    if (url.host === "upload.test") return this.receive(url.pathname.slice(1), request);
    if (url.host === "download.test") {
      const item = this.items.get(url.pathname.slice(1));
      return item?.bytes ? new Response(item.bytes as BodyInit) : new Response(null, { status: 404 });
    }
    if (url.host === "monitor.test") {
      const target = this.monitors.get(url.pathname.slice(1));
      return json(target === undefined ? { status: "failed", error: { code: "nameAlreadyExists" } } : { status: "completed", resourceId: target });
    }
    const token = request.headers.get("authorization")?.replace(/^Bearer /, "");
    if (!token || !this.tokens.has(token)) return json({ error: { code: "InvalidAuthenticationToken", message: "Expired" } }, 401);

    if (url.pathname === "/v1.0/me") return json({ mail: this.email, userPrincipalName: this.email, displayName: "Me" });
    if (url.pathname === "/v1.0/me/drive") return json({ id: this.driveId });
    let path = decodeURIComponent(url.pathname).replace(/^\/v1\.0\/me\/drive/, "");
    // Path addressing: /special/approot:/a/b:/children → the item at a/b, then /children.
    let target: GItem | null;
    let rest: string;
    const byPath = /^\/(special\/approot|items\/([^/:]+)):\/(.+?):(\/.*)?$/.exec(path);
    if (byPath) {
      const base = byPath[2] ? this.items.get(byPath[2]) : this.items.get("approot");
      const names = byPath[3]!.split("/");
      rest = byPath[4] ?? "";
      if (rest === "/createUploadSession" || rest === "/content") return this.upload(base!, names, rest, request);
      target = base ? (names.reduce<GItem | null>((at, name) => (at ? this.find(at.id, name) : null), base)) : null;
    } else {
      const plain = /^\/(special\/approot|items\/([^/]+))(\/.*)?$/.exec(path);
      if (!plain) return json({ error: { message: "not handled" } }, 400);
      target = plain[2] ? (this.items.get(plain[2]) ?? null) : this.items.get("approot")!;
      rest = plain[3] ?? "";
    }
    path = rest;
    if (!target) return json({ error: { code: "itemNotFound", message: "Not found" } }, 404);

    if (path === "/children" && request.method === "GET") {
      const all = this.childrenOf(target.id).map((item) => this.view(item));
      const skip = Number(url.searchParams.get("skip") ?? 0);
      const page = all.slice(skip, skip + 2);
      const more = skip + 2 < all.length;
      return json({ value: page, ...(more ? { "@odata.nextLink": `https://graph.microsoft.com/v1.0/me/drive/items/${target.id}/children?skip=${skip + 2}` } : {}) });
    }
    if (path === "/children" && request.method === "POST") {
      const body = (await request.json()) as { name: string };
      if (this.find(target.id, body.name)) return json({ error: { code: "nameAlreadyExists" } }, 409);
      const item: GItem = { id: this.id(), name: body.name, parent: target.id, folder: true, modified: new Date().toISOString() };
      this.items.set(item.id, item);
      return json(this.view(item), 201);
    }
    if (path === "/copy" && request.method === "POST") {
      const body = (await request.json()) as { parentReference: { id: string }; name: string };
      if (this.find(body.parentReference.id, body.name)) return json({ error: { code: "nameAlreadyExists" } }, 409);
      const copy: GItem = { ...target, id: this.id(), name: body.name, parent: body.parentReference.id, modified: new Date().toISOString() };
      this.items.set(copy.id, copy);
      const monitor = this.id();
      this.monitors.set(monitor, Number(copy.id.slice(1)));
      return new Response(null, { status: 202, headers: { location: `https://monitor.test/${monitor}` } });
    }
    if (path === "" && request.method === "DELETE") {
      this.items.delete(target.id);
      return new Response(null, { status: 204 });
    }
    if (path === "" && request.method === "GET") return json(this.view(target));
    return json({ error: { message: "not handled" } }, 400);
  });

  private async upload(parent: GItem, names: string[], kind: string, request: Request) {
    const name = names[names.length - 1]!;
    if (names.length !== 1) return json({ error: { message: "This fake only uploads into a folder by id" } }, 400);
    if (this.find(parent.id, name)) return json({ error: { code: "nameAlreadyExists" } }, 409);
    if (kind === "/content") {
      const item: GItem = { id: this.id(), name, parent: parent.id, folder: false, bytes: new Uint8Array(await request.arrayBuffer()), modified: new Date().toISOString() };
      this.items.set(item.id, item);
      return json(this.view(item), 201);
    }
    const body = (await request.json()) as { item: { name: string; description?: string } };
    const session = this.id();
    this.sessions.set(session, { parent: parent.id, name, ...(body.item.description ? { description: body.item.description } : {}), received: [], size: null });
    return json({ uploadUrl: `https://upload.test/${session}`, expirationDateTime: new Date(Date.now() + 3600_000).toISOString() });
  }

  private async receive(id: string, request: Request) {
    if (request.headers.has("authorization")) return json({ error: { message: "Upload URLs must not carry a token" } }, 400);
    const session = this.sessions.get(id);
    if (!session) return json({ error: { message: "No such session" } }, 404);
    const range = /bytes (\d+)-(\d+)\/(\d+)/.exec(request.headers.get("content-range") ?? "");
    if (!range) return json({ error: { message: "Content-Range is required" } }, 400);
    const bytes = new Uint8Array(await request.arrayBuffer());
    const start = Number(range[1]);
    const total = Number(range[3]);
    const have = session.received.reduce((sum, part) => sum + part.byteLength, 0);
    if (start !== have || bytes.byteLength !== Number(range[2]) - start + 1) return json({ error: { message: "Out of order" } }, 416);
    session.received.push(bytes);
    if (have + bytes.byteLength < total) return json({ nextExpectedRanges: [`${have + bytes.byteLength}-`] }, 202);
    this.sessions.delete(id);
    if (this.find(session.parent, session.name)) return json({ error: { code: "nameAlreadyExists" } }, 409);
    const all = new Uint8Array(total);
    let at = 0;
    for (const part of session.received) {
      all.set(part, at);
      at += part.byteLength;
    }
    const item: GItem = {
      id: this.id(),
      name: session.name,
      parent: session.parent,
      folder: false,
      bytes: all,
      ...(session.description && this.keepDescriptions ? { description: session.description } : {}),
      modified: new Date().toISOString(),
    };
    this.items.set(item.id, item);
    return json(this.view(item), 201);
  }

  paths() {
    const pathOf = (item: GItem): string => (item.parent && item.parent !== "approot" ? `${pathOf(this.items.get(item.parent)!)}/${item.name}` : item.name);
    return [...this.items.values()].filter((item) => !item.folder).map(pathOf).sort();
  }
}

/** Sends a signed upload the way the desktop app does, in pieces when the provider wants them. */
export async function sendSignedUpload(fetchImpl: typeof fetch, request: { method: string; url: string; headers: Record<string, string>; chunked?: { maxBytes: number } }, bytes: Uint8Array) {
  if (!request.chunked) return fetchImpl(request.url, { method: request.method, headers: request.headers, body: bytes as BodyInit });
  let response: Response | null = null;
  for (let start = 0; start < bytes.byteLength; start += request.chunked.maxBytes) {
    const piece = bytes.subarray(start, Math.min(start + request.chunked.maxBytes, bytes.byteLength));
    response = await fetchImpl(request.url, {
      method: request.method,
      headers: { ...request.headers, "content-range": `bytes ${start}-${start + piece.byteLength - 1}/${bytes.byteLength}` },
      body: piece as BodyInit,
    });
    if (!response.ok) return response;
  }
  return response!;
}
