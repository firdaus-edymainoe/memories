import { mkdtemp, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { arch, platform, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadKoffi, type Koffi } from "./mtp-koffi.js";
import { releaseOtherMtpClients } from "./mtp-darwin.js";
import { FMT_ASSOCIATION, type MtpClient, type MtpDeviceInfo, type MtpHost, type MtpObject, unsupportedMtpWrites } from "./mtp.js";

export const DEVICE_FLAGS_ANDROID_BUGS = 0x18008106;
const LIBMTP_FILES_AND_FOLDERS_ROOT = 0xffffffff;
const LIBMTP_FILETYPE_FOLDER = 0;
const LIBMTP_ERROR_NONE = 0;
const LIBMTP_ERROR_NO_DEVICE_ATTACHED = 5;

export type LibmtpFile = {
  itemId: number;
  name: string;
  size: number;
  folder: boolean;
  modified: number;
};

export type LibmtpSession = {
  label: string;
  listChildren(parent: number): Promise<LibmtpFile[]>;
  readObject(handle: number): Promise<Uint8Array>;
  close(): Promise<void>;
};

export type LibmtpBackend = {
  detect(): Promise<MtpDeviceInfo[]>;
  open(device: MtpDeviceInfo): Promise<LibmtpSession>;
};

export function libmtpDylibPath(os = platform(), cpu = arch()): string | null {
  if (os !== "darwin") return null;
  const slug = cpu === "arm64" ? "arm64" : "x64";
  const path = join(fileURLToPath(new URL(".", import.meta.url)), "..", "vendor", `darwin-${slug}`, "libmtp.dylib");
  return existsSync(path) ? path : null;
}

export function libmtpFileToMtp(file: LibmtpFile): MtpObject {
  return {
    handle: file.itemId,
    name: file.name,
    size: file.size,
    format: file.folder ? FMT_ASSOCIATION : 0x3000,
    takenAt: file.modified ? new Date(file.modified * 1000).toISOString() : null,
  };
}

function emptyBackend(): LibmtpBackend {
  return {
    async detect() {
      return [];
    },
    async open() {
      throw new Error("Bundled libmtp is not available. Run npm run vendor:libmtp -w @memories/fs-android.");
    },
  };
}

export class LibmtpHost implements MtpHost {
  private readonly backend: LibmtpBackend;

  constructor(backend?: LibmtpBackend) {
    this.backend = backend ?? (libmtpDylibPath() ? liveLibmtpBackend() : emptyBackend());
  }

  async listDevices(): Promise<MtpDeviceInfo[]> {
    try {
      await releaseOtherMtpClients();
      return await this.backend.detect();
    } catch {
      return [];
    }
  }

  async open(device: MtpDeviceInfo): Promise<MtpClient> {
    await releaseOtherMtpClients();
    const session = await this.backend.open(device);
    return new LibmtpClient(session);
  }
}

class LibmtpClient implements MtpClient {
  readonly label: string;
  mkdir = unsupportedMtpWrites().mkdir;
  sendObject = unsupportedMtpWrites().sendObject;
  deleteObject = unsupportedMtpWrites().deleteObject;

  constructor(private readonly session: LibmtpSession) {
    this.label = session.label;
  }

  async listChildren(parent: number): Promise<MtpObject[]> {
    const kids = await this.session.listChildren(parent === 0 ? LIBMTP_FILES_AND_FOLDERS_ROOT : parent);
    return kids.filter((row) => row.name && !row.name.startsWith(".")).map(libmtpFileToMtp);
  }

  readObject(handle: number): Promise<Uint8Array> {
    return this.session.readObject(handle);
  }

  close(): Promise<void> {
    return this.session.close();
  }
}

function liveLibmtpBackend(): LibmtpBackend {
  let api: LiveLibmtp | null = null;
  const load = () => {
    api ??= new LiveLibmtp();
    return api;
  };
  return {
    detect: () => load().detect(),
    open: (device) => load().open(device),
  };
}

type RawDevice = {
  vendor: string;
  product: string;
  vendorId: number;
  productId: number;
  deviceFlags: number;
  busLocation: number;
  devnum: number;
};

class LiveLibmtp {
  private readonly k: Koffi;
  private readonly lib: ReturnType<Koffi["load"]>;
  private readonly rawType: ReturnType<Koffi["struct"]>;
  private readonly fileType: ReturnType<Koffi["struct"]>;
  private readonly Init: () => void;
  private readonly SetDebug: (level: number) => void;
  private readonly Detect: (devices: unknown[], num: number[]) => number;
  private readonly Open: (raw: unknown) => unknown;
  private readonly Release: (device: unknown) => void;
  private readonly GetFriendlyname: (device: unknown) => unknown;
  private readonly GetModelname: (device: unknown) => unknown;
  private readonly GetSerialnumber: (device: unknown) => unknown;
  private readonly GetStorage: (device: unknown, sort: number) => number;
  private readonly GetFilesAndFolders: (device: unknown, storage: number, parent: number) => unknown;
  private readonly DestroyFile: (file: unknown) => void;
  private readonly GetFileToFile: (device: unknown, id: number, path: string, cb: unknown, data: unknown) => number;
  private readonly ClearErrorstack: (device: unknown) => void;
  private queue: Promise<unknown> = Promise.resolve();
  private inited = false;

  constructor() {
    const dylib = libmtpDylibPath();
    if (!dylib) throw new Error("Bundled libmtp is not available. Run npm run vendor:libmtp -w @memories/fs-android.");
    this.k = loadKoffi();
    this.lib = this.k.load(dylib);
    const entry = this.k.struct("LIBMTP_device_entry_t", {
      vendor: "str",
      vendor_id: "uint16",
      product: "str",
      product_id: "uint16",
      device_flags: "uint32",
    });
    this.rawType = this.k.struct("LIBMTP_raw_device_t", {
      device_entry: entry,
      bus_location: "uint32",
      devnum: "uint8",
    });
    this.fileType = this.k.struct("LIBMTP_file_t", {
      item_id: "uint32",
      parent_id: "uint32",
      storage_id: "uint32",
      filename: "str",
      filesize: "uint64",
      modificationdate: "int64",
      filetype: "int",
      next: "void *",
    });
    this.Init = this.lib.func("void LIBMTP_Init()");
    this.SetDebug = this.lib.func("void LIBMTP_Set_Debug(int level)");
    this.Detect = this.lib.func("int LIBMTP_Detect_Raw_Devices(_Out_ void **devices, _Out_ int *numdevs)");
    this.Open = this.lib.func("void *LIBMTP_Open_Raw_Device_Uncached(void *raw)");
    this.Release = this.lib.func("void LIBMTP_Release_Device(void *device)");
    this.GetFriendlyname = this.lib.func("void *LIBMTP_Get_Friendlyname(void *device)");
    this.GetModelname = this.lib.func("void *LIBMTP_Get_Modelname(void *device)");
    this.GetSerialnumber = this.lib.func("void *LIBMTP_Get_Serialnumber(void *device)");
    this.GetStorage = this.lib.func("int LIBMTP_Get_Storage(void *device, int sortby)");
    this.GetFilesAndFolders = this.lib.func("void *LIBMTP_Get_Files_And_Folders(void *device, uint32 storage, uint32 parent)");
    this.DestroyFile = this.lib.func("void LIBMTP_destroy_file_t(void *file)");
    this.GetFileToFile = this.lib.func(
      "int LIBMTP_Get_File_To_File(void *device, uint32 id, const char *path, void *callback, void *data)",
    );
    this.ClearErrorstack = this.lib.func("void LIBMTP_Clear_Errorstack(void *device)");
  }

  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private init() {
    if (this.inited) return;
    this.Init();
    this.SetDebug(0);
    this.inited = true;
  }

  private cString(ptr: unknown): string {
    if (!ptr) return "";
    try {
      const text = this.k.decode.string(ptr);
      this.k.free(ptr);
      return text || "";
    } catch {
      return "";
    }
  }

  private encodeRaw(raw: RawDevice) {
    const ptr = this.k.alloc(this.rawType, 1);
    this.k.encode(ptr, this.rawType, {
      device_entry: {
        vendor: raw.vendor,
        vendor_id: raw.vendorId,
        product: raw.product,
        product_id: raw.productId,
        device_flags: raw.deviceFlags | DEVICE_FLAGS_ANDROID_BUGS,
      },
      bus_location: raw.busLocation,
      devnum: raw.devnum,
    });
    return ptr;
  }

  private detectRaw(): RawDevice[] {
    this.init();
    const devices = [null];
    const num = [0];
    const err = this.Detect(devices, num);
    if (err === LIBMTP_ERROR_NO_DEVICE_ATTACHED || !num[0] || !devices[0]) return [];
    if (err !== LIBMTP_ERROR_NONE) throw new Error(`libmtp detect failed (${err})`);
    const rows = this.k.decode(devices[0], this.k.array(this.rawType, num[0])) as Array<{
      device_entry: {
        vendor: string;
        vendor_id: number;
        product: string;
        product_id: number;
        device_flags: number;
      };
      bus_location: number;
      devnum: number;
    }>;
    const copied = rows.map((row) => ({
      vendor: row.device_entry.vendor || "",
      product: row.device_entry.product || "",
      vendorId: row.device_entry.vendor_id,
      productId: row.device_entry.product_id,
      deviceFlags: row.device_entry.device_flags,
      busLocation: row.bus_location,
      devnum: row.devnum,
    }));
    this.k.free(devices[0]);
    return copied;
  }

  private openRaw(raw: RawDevice): unknown {
    const ptr = this.encodeRaw(raw);
    try {
      const device = this.Open(ptr);
      if (!device) throw new Error("Unable to open the phone over MTP. Quit Android File Transfer, unlock, set File transfer.");
      if (this.GetStorage(device, 0) !== 0) {
        this.ClearErrorstack(device);
        this.Release(device);
        throw new Error("libmtp storage unavailable");
      }
      return device;
    } finally {
      this.k.free(ptr);
    }
  }

  private describe(device: unknown, fallback: RawDevice): MtpDeviceInfo {
    const serial = this.cString(this.GetSerialnumber(device)) || null;
    const label =
      this.cString(this.GetFriendlyname(device)) ||
      this.cString(this.GetModelname(device)) ||
      fallback.product.replaceAll("_", " ") ||
      "Android";
    return {
      vendorId: fallback.vendorId,
      productId: fallback.productId,
      serial,
      label,
    };
  }

  async detect(): Promise<MtpDeviceInfo[]> {
    return this.exclusive(async () =>
      this.detectRaw().map((raw) => ({
        vendorId: raw.vendorId,
        productId: raw.productId,
        serial: null,
        label: raw.product.replaceAll("_", " ") || raw.vendor || "Android",
      })),
    );
  }

  async open(wanted: MtpDeviceInfo): Promise<LibmtpSession> {
    return this.exclusive(async () => {
      const raws = this.detectRaw();
      const match =
        raws.find(
          (row) =>
            row.vendorId === wanted.vendorId &&
            row.productId === wanted.productId &&
            (wanted.serial == null || true),
        ) ?? raws.find((row) => row.vendorId === wanted.vendorId && row.productId === wanted.productId);
      if (!match) throw new Error("Android phone not connected. Unlock it and set USB to File transfer.");
      const device = this.openRaw(match);
      const info = this.describe(device, match);
      if (wanted.serial && info.serial && wanted.serial !== info.serial) {
        this.Release(device);
        throw new Error("Android phone not connected. Unlock it and set USB to File transfer.");
      }
      return {
        label: info.label,
        listChildren: (parent) => this.exclusive(async () => this.list(device, parent)),
        readObject: (handle) => this.exclusive(async () => this.read(device, handle)),
        close: () =>
          this.exclusive(async () => {
            this.ClearErrorstack(device);
            this.Release(device);
          }),
      };
    });
  }

  private list(device: unknown, parent: number): LibmtpFile[] {
    const head = this.GetFilesAndFolders(device, 0, parent >>> 0);
    const out: LibmtpFile[] = [];
    let ptr = head;
    while (ptr) {
      const row = this.k.decode(ptr, this.fileType) as {
        item_id: number;
        filename: string;
        filesize: bigint | number;
        modificationdate: bigint | number;
        filetype: number;
        next: unknown;
      };
      const next = row.next;
      if (row.filename) {
        out.push({
          itemId: row.item_id,
          name: row.filename,
          size: Number(row.filesize),
          folder: row.filetype === LIBMTP_FILETYPE_FOLDER,
          modified: Number(row.modificationdate) || 0,
        });
      }
      this.DestroyFile(ptr);
      ptr = next;
    }
    return out;
  }

  private async read(device: unknown, handle: number): Promise<Uint8Array> {
    const dir = await mkdtemp(join(tmpdir(), "memories-mtp-"));
    const path = join(dir, `object-${handle}`);
    try {
      const hr = this.GetFileToFile(device, handle >>> 0, path, null, null);
      if (hr !== 0) throw new Error("Could not read that file from the phone.");
      return new Uint8Array(await readFile(path));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}
