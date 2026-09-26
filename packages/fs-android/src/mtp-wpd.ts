import { platform } from "node:os";
import { loadKoffi, type Koffi } from "./mtp-koffi.js";
import { FMT_ASSOCIATION, type MtpClient, type MtpDeviceInfo, type MtpHost, type MtpObject, unsupportedMtpWrites } from "./mtp.js";

export type WpdObject = {
  objectId: string;
  name: string;
  size: number;
  folder: boolean;
  takenAt: string | null;
};

export type WpdSession = {
  listChildren(parentObjectId: string): Promise<WpdObject[]>;
  readObject(objectId: string): Promise<Uint8Array>;
  close(): Promise<void>;
};

export type WpdDeviceRow = {
  pnpId: string;
  vendorId: number;
  productId: number;
  serial: string | null;
  label: string;
};

export type WpdBackend = {
  listDevices(): Promise<WpdDeviceRow[]>;
  open(pnpId: string): Promise<WpdSession>;
};

const DEVICE_ROOT = "DEVICE";

export function parseWpdPnpId(pnpId: string): { vendorId: number; productId: number; serial: string | null } {
  const vid = pnpId.match(/vid_([0-9a-f]{4})/i);
  const pid = pnpId.match(/pid_([0-9a-f]{4})/i);
  const parts = pnpId.split("#");
  const instance = parts[2] && !parts[2].startsWith("{") ? parts[2] : null;
  return {
    vendorId: vid ? Number.parseInt(vid[1]!, 16) : 0,
    productId: pid ? Number.parseInt(pid[1]!, 16) : 0,
    serial: instance || null,
  };
}

export function pickWpdRoot(deviceChildren: WpdObject[]): string {
  const folders = deviceChildren.filter((row) => row.folder && row.name);
  if (folders.length === 1) return folders[0]!.objectId;
  return DEVICE_ROOT;
}

export function wpdRowToMtp(row: WpdObject, handle: number): MtpObject {
  return {
    handle,
    name: row.name,
    size: row.size,
    format: row.folder ? FMT_ASSOCIATION : 0x3000,
    takenAt: row.takenAt,
  };
}

function emptyBackend(): WpdBackend {
  return {
    async listDevices() {
      return [];
    },
    async open() {
      throw new Error("Windows Portable Devices is only available on Windows.");
    },
  };
}

export class WpdMtpHost implements MtpHost {
  private readonly backend: WpdBackend;

  constructor(backend?: WpdBackend) {
    this.backend = backend ?? (platform() === "win32" ? liveWpdBackend() : emptyBackend());
  }

  async listDevices(): Promise<MtpDeviceInfo[]> {
    try {
      const rows = await this.backend.listDevices();
      return rows
        .filter((row) => row.vendorId && row.productId)
        .map((row) => ({
          vendorId: row.vendorId,
          productId: row.productId,
          serial: row.serial,
          label: row.label,
        }));
    } catch {
      return [];
    }
  }

  async open(device: MtpDeviceInfo): Promise<MtpClient> {
    const rows = await this.backend.listDevices();
    const match =
      rows.find(
        (row) =>
          row.vendorId === device.vendorId &&
          row.productId === device.productId &&
          (device.serial == null || row.serial === device.serial),
      ) ?? rows.find((row) => row.vendorId === device.vendorId && row.productId === device.productId);
    if (!match) throw new Error("Android phone not connected. Unlock it and set USB to File transfer.");
    const session = await this.backend.open(match.pnpId);
    const rootId = pickWpdRoot(await session.listChildren(DEVICE_ROOT));
    return new WpdMtpClient(match.label, session, rootId);
  }
}

class WpdMtpClient implements MtpClient {
  private next = 1;
  private readonly byHandle = new Map<number, string>();
  private readonly byId = new Map<string, number>();
  mkdir = unsupportedMtpWrites().mkdir;
  sendObject = unsupportedMtpWrites().sendObject;
  deleteObject = unsupportedMtpWrites().deleteObject;

  constructor(
    readonly label: string,
    private readonly session: WpdSession,
    private readonly rootId: string,
  ) {
    this.byHandle.set(0, rootId);
    this.byId.set(rootId, 0);
  }

  private intern(objectId: string): number {
    const existing = this.byId.get(objectId);
    if (existing !== undefined) return existing;
    const handle = this.next++;
    this.byHandle.set(handle, objectId);
    this.byId.set(objectId, handle);
    return handle;
  }

  async listChildren(parent: number): Promise<MtpObject[]> {
    const parentId = parent === 0 ? this.rootId : this.byHandle.get(parent);
    if (!parentId) return [];
    const kids = await this.session.listChildren(parentId);
    return kids.filter((row) => row.name && !row.name.startsWith(".")).map((row) => wpdRowToMtp(row, this.intern(row.objectId)));
  }

  async readObject(handle: number): Promise<Uint8Array> {
    const objectId = this.byHandle.get(handle);
    if (!objectId) throw new Error("Missing file on the phone");
    return this.session.readObject(objectId);
  }

  async close(): Promise<void> {
    await this.session.close();
  }
}

type Guid = { Data1: number; Data2: number; Data3: number; Data4: number[] };
type PropertyKey = { fmtid: Guid; pid: number };

function liveWpdBackend(): WpdBackend {
  let api: LiveWpd | null = null;
  const load = () => {
    api ??= new LiveWpd();
    return api;
  };
  return {
    listDevices: () => load().listDevices(),
    open: (pnpId) => load().open(pnpId),
  };
}

class LiveWpd {
  private readonly k: Koffi;
  private readonly ole32: ReturnType<Koffi["load"]>;
  private readonly CoCreateInstance: (...args: unknown[]) => number;
  private readonly CoTaskMemFree: (ptr: unknown) => void;
  private queue: Promise<unknown> = Promise.resolve();
  private manager: unknown = null;

  constructor() {
    this.k = loadKoffi();
    this.ole32 = this.k.load("ole32.dll");
    this.k.struct("GUID", {
      Data1: "uint32",
      Data2: "uint16",
      Data3: "uint16",
      Data4: this.k.array("uint8", 8),
    });
    this.k.struct("PROPERTYKEY", {
      fmtid: "GUID",
      pid: "uint32",
    });
    this.ole32.func("__stdcall", "CoInitializeEx", "long", ["void *", "uint32"])(null, 0);
    this.CoCreateInstance = this.ole32.func(
      "long __stdcall CoCreateInstance(GUID *rclsid, void *outer, uint32 ctx, GUID *iid, _Out_ void **ppv)",
    );
    this.CoTaskMemFree = this.ole32.func("void __stdcall CoTaskMemFree(void *pv)");
  }

  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn);
    this.queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  private guid(text: string): Guid {
    const hex = text.replace(/[{}-]/g, "");
    return {
      Data1: Number.parseInt(hex.slice(0, 8), 16),
      Data2: Number.parseInt(hex.slice(8, 12), 16),
      Data3: Number.parseInt(hex.slice(12, 16), 16),
      Data4: [...Buffer.from(hex.slice(16), "hex")],
    };
  }

  private key(fmtid: string, pid: number): PropertyKey {
    return { fmtid: this.guid(fmtid), pid };
  }

  private vtable(iface: unknown, slot: number) {
    const vtbl = this.k.decode(iface, "void *");
    return this.k.decode(vtbl, this.k.array("void *", slot + 1))[slot];
  }

  private com(iface: unknown, slot: number, proto: string, ...args: unknown[]) {
    return this.k.call(this.vtable(iface, slot), this.k.proto(proto), iface, ...args) as number;
  }

  private check(hr: number, what: string) {
    if (hr < 0) throw new Error(`${what} failed (0x${(hr >>> 0).toString(16)})`);
  }

  private create(clsid: string, iid: string): unknown {
    const out = [null];
    const hr = this.CoCreateInstance(this.guid(clsid), null, 1, this.guid(iid), out);
    this.check(hr, "CoCreateInstance");
    return out[0];
  }

  private release(iface: unknown | null | undefined) {
    if (!iface) return;
    try {
      this.com(iface, 2, "uint32 __stdcall (void *this)");
    } catch {
      /* already released */
    }
  }

  private decodeWstring(ptr: unknown): string {
    if (!ptr) return "";
    return this.k.decode.wstring(ptr);
  }

  private managerIface() {
    this.manager ??= this.create("0af10cec-2ecd-4b92-9581-e6f0c8e6c00c", "a1567595-4c2f-4574-a6fa-ecef917b9a40");
    return this.manager;
  }

  async listDevices(): Promise<WpdDeviceRow[]> {
    return this.exclusive(async () => this.listDevicesSync());
  }

  private listDevicesSync(): WpdDeviceRow[] {
    const mgr = this.managerIface();
    this.com(mgr, 4, "long __stdcall (void *this)");
    const count = [0];
    this.check(this.com(mgr, 3, "long __stdcall (void *this, void *ids, _Inout_ uint32 *count)", null, count), "GetDevices");
    if (!count[0]) return [];
    const ids = Buffer.alloc(count[0] * this.k.sizeof("void *"));
    this.check(this.com(mgr, 3, "long __stdcall (void *this, void *ids, _Inout_ uint32 *count)", ids, count), "GetDevices");
    const ptrs = this.k.decode(ids, this.k.array("void *", count[0])) as unknown[];
    const out: WpdDeviceRow[] = [];
    for (const ptr of ptrs) {
      const pnpId = this.decodeWstring(ptr);
      this.CoTaskMemFree(ptr);
      if (!pnpId) continue;
      const parsed = parseWpdPnpId(pnpId);
      out.push({
        pnpId,
        ...parsed,
        label: this.friendlyName(mgr, pnpId) || "Android",
      });
    }
    return out;
  }

  private friendlyName(mgr: unknown, pnpId: string): string {
    const len = [0];
    this.com(mgr, 5, "long __stdcall (void *this, const wchar_t *id, void *name, _Inout_ uint32 *len)", pnpId, null, len);
    if (!len[0]) return "";
    const buf = Buffer.alloc(len[0] * 2);
    const hr = this.com(
      mgr,
      5,
      "long __stdcall (void *this, const wchar_t *id, void *name, _Inout_ uint32 *len)",
      pnpId,
      buf,
      len,
    );
    if (hr < 0) return "";
    return buf.toString("utf16le").replace(/\0+$/, "");
  }

  async open(pnpId: string): Promise<WpdSession> {
    return this.exclusive(async () => this.openSync(pnpId));
  }

  private openSync(pnpId: string): WpdSession {
    const valuesClsid = "0c15d503-d017-47ce-8925-da1f28ab1883";
    const valuesIid = "6848f6f2-3155-4f86-b6f5-263eeeab3143";
    const client = this.create(valuesClsid, valuesIid);
    const clientName = this.key("204D9F0C-2292-4080-9F42-40664E70F859", 2);
    const clientMajor = this.key("204D9F0C-2292-4080-9F42-40664E70F859", 3);
    const clientMinor = this.key("204D9F0C-2292-4080-9F42-40664E70F859", 4);
    const clientRev = this.key("204D9F0C-2292-4080-9F42-40664E70F859", 5);
    const clientAccess = this.key("204D9F0C-2292-4080-9F42-40664E70F859", 9);
    this.check(
      this.com(
        client,
        7,
        "long __stdcall (void *this, PROPERTYKEY *key, const wchar_t *value)",
        clientName,
        "Memories",
      ),
      "SetStringValue",
    );
    for (const [key, value] of [
      [clientMajor, 1],
      [clientMinor, 0],
      [clientRev, 0],
      [clientAccess, 0x80000000],
    ] as const) {
      this.check(
        this.com(client, 9, "long __stdcall (void *this, PROPERTYKEY *key, uint32 value)", key, value >>> 0),
        "SetUnsignedIntegerValue",
      );
    }
    const device =
      this.tryCreate("f7c0039a-4762-488a-a4e3-9179944e6f2e", "625e2df8-6392-4cf0-9ad1-3cfa5f7177e8") ??
      this.create("728a21c5-3d9e-48d4-9867-897a1500527c", "625e2df8-6392-4cf0-9ad1-3cfa5f7177e8");
    this.check(
      this.com(device, 3, "long __stdcall (void *this, const wchar_t *id, void *client)", pnpId, client),
      "IPortableDevice.Open",
    );
    this.release(client);
    const contentOut = [null];
    this.check(this.com(device, 5, "long __stdcall (void *this, _Out_ void **content)", contentOut), "Content");
    const content = contentOut[0];
    const propsOut = [null];
    this.check(this.com(content, 4, "long __stdcall (void *this, _Out_ void **props)", propsOut), "Properties");
    const properties = propsOut[0];
    const resOut = [null];
    this.check(this.com(content, 5, "long __stdcall (void *this, _Out_ void **res)", resOut), "Transfer");
    const resources = resOut[0];
    const keys = this.propertyKeys();
    return {
      listChildren: (parent) => this.exclusive(async () => this.enumChildren(content, properties, keys, parent)),
      readObject: (objectId) => this.exclusive(async () => this.readStream(resources, objectId)),
      close: () =>
        this.exclusive(async () => {
          this.release(keys);
          this.release(resources);
          this.release(properties);
          this.release(content);
          this.com(device, 8, "long __stdcall (void *this)");
          this.release(device);
        }),
    };
  }

  private tryCreate(clsid: string, iid: string): unknown | null {
    const out = [null];
    const hr = this.CoCreateInstance(this.guid(clsid), null, 1, this.guid(iid), out);
    return hr < 0 ? null : out[0];
  }

  private propertyKeys(): unknown {
    const keys = this.create("de2d022d-2480-43be-97f0-d1fa2cf9f139", "dada2357-e0ad-492e-98dd-822bc2af27c8");
    const object = "EF6B490D-5CD8-437A-AFFC-DA8B60EE4A3C";
    for (const pid of [4, 7, 11, 12, 19]) {
      this.check(this.com(keys, 5, "long __stdcall (void *this, PROPERTYKEY *key)", this.key(object, pid)), "KeyCollection.Add");
    }
    return keys;
  }

  private enumChildren(content: unknown, properties: unknown, keys: unknown, parent: string): WpdObject[] {
    const enumOut = [null];
    this.check(
      this.com(
        content,
        3,
        "long __stdcall (void *this, uint32 flags, const wchar_t *parent, void *filter, _Out_ void **en)",
        0,
        parent,
        null,
        enumOut,
      ),
      "EnumObjects",
    );
    const enumerator = enumOut[0];
    const out: WpdObject[] = [];
    try {
      for (;;) {
        const buf = Buffer.alloc(this.k.sizeof("void *"));
        const fetched = [0];
        const hr = this.com(
          enumerator,
          3,
          "long __stdcall (void *this, uint32 count, void *ids, _Out_ uint32 *fetched)",
          1,
          buf,
          fetched,
        );
        if (hr < 0 || !fetched[0]) break;
        const ptr = this.k.decode(buf, "void *");
        const objectId = this.decodeWstring(ptr);
        this.CoTaskMemFree(ptr);
        const row = this.readProps(properties, keys, objectId);
        if (row) out.push(row);
        if (hr > 0) break;
      }
    } finally {
      this.release(enumerator);
    }
    return out;
  }

  private readProps(properties: unknown, keys: unknown, objectId: string): WpdObject | null {
    const valuesOut = [null];
    const hr = this.com(
      properties,
      5,
      "long __stdcall (void *this, const wchar_t *id, void *keys, _Out_ void **values)",
      objectId,
      keys,
      valuesOut,
    );
    if (hr < 0 || !valuesOut[0]) return null;
    const values = valuesOut[0];
    try {
      const object = "EF6B490D-5CD8-437A-AFFC-DA8B60EE4A3C";
      const name = this.stringValue(values, this.key(object, 12)) || this.stringValue(values, this.key(object, 4));
      if (!name) return null;
      const size = this.uint64Value(values, this.key(object, 11));
      const content = this.guidValue(values, this.key(object, 7));
      const folder = isWpdFolder(content, name, size);
      return { objectId, name, size, folder, takenAt: null };
    } finally {
      this.release(values);
    }
  }

  private stringValue(values: unknown, key: PropertyKey): string {
    const out = [null];
    const hr = this.com(values, 8, "long __stdcall (void *this, PROPERTYKEY *key, _Out_ void **value)", key, out);
    if (hr < 0 || !out[0]) return "";
    const text = this.decodeWstring(out[0]);
    this.CoTaskMemFree(out[0]);
    return text;
  }

  private uint64Value(values: unknown, key: PropertyKey): number {
    const out = [0n];
    const hr = this.com(values, 14, "long __stdcall (void *this, PROPERTYKEY *key, _Out_ uint64 *value)", key, out);
    if (hr < 0) return 0;
    return Number(out[0]);
  }

  private guidValue(values: unknown, key: PropertyKey): Guid | null {
    const guid: Guid = { Data1: 0, Data2: 0, Data3: 0, Data4: [0, 0, 0, 0, 0, 0, 0, 0] };
    const hr = this.com(values, 28, "long __stdcall (void *this, PROPERTYKEY *key, _Out_ GUID *value)", key, guid);
    if (hr < 0) return null;
    return guid;
  }

  private readStream(resources: unknown, objectId: string): Uint8Array {
    const resource = this.key("E81E79BE-34F0-41BF-B53F-F1A06AE87842", 0);
    const size = [0];
    const streamOut = [null];
    this.check(
      this.com(
        resources,
        5,
        "long __stdcall (void *this, const wchar_t *id, PROPERTYKEY *key, uint32 mode, _Out_ uint32 *opt, _Out_ void **stream)",
        objectId,
        resource,
        0,
        size,
        streamOut,
      ),
      "GetStream",
    );
    const stream = streamOut[0];
    const chunks: Buffer[] = [];
    try {
      const chunk = Math.max(size[0] || 0, 64 * 1024);
      for (;;) {
        const buf = Buffer.alloc(chunk);
        const read = [0];
        const hr = this.com(stream, 3, "long __stdcall (void *this, void *buf, uint32 cb, _Out_ uint32 *read)", buf, chunk, read);
        this.check(hr, "IStream.Read");
        if (!read[0]) break;
        chunks.push(buf.subarray(0, read[0]));
      }
    } finally {
      this.release(stream);
    }
    return new Uint8Array(Buffer.concat(chunks));
  }
}

function isWpdFolder(content: Guid | null, name: string, size: number) {
  if (content) {
    const folder = content.Data1 === 0x27e2e392 && content.Data2 === 0xa111;
    const functional = content.Data1 === 0x99ed0160 && content.Data2 === 0x17ff;
    if (folder || functional) return true;
  }
  return size === 0 && !name.includes(".");
}
