import { promisify } from "node:util";
import { releaseOtherMtpClients } from "./mtp-darwin.js";
import type { MtpClient, MtpDeviceInfo, MtpHost, MtpObject } from "./mtp.js";
import { FMT_ASSOCIATION } from "./mtp.js";

const TYPE_COMMAND = 1;
const TYPE_DATA = 2;
const TYPE_RESPONSE = 3;
const OP_OPEN_SESSION = 0x1002;
const OP_CLOSE_SESSION = 0x1003;
const OP_GET_STORAGE_IDS = 0x1004;
const OP_GET_OBJECT_HANDLES = 0x1007;
const OP_GET_OBJECT_INFO = 0x1008;
const OP_GET_OBJECT = 0x1009;
const OP_DELETE_OBJECT = 0x100b;
const OP_SEND_OBJECT_INFO = 0x100c;
const OP_SEND_OBJECT = 0x100d;
const OP_GET_OBJECT_PROP_LIST = 0x9805;
const RESP_OK = 0x2001;
const RESP_SESSION_ALREADY_OPEN = 0x201e;
const PROP_OBJECT_FORMAT = 0xdc02;
const PROP_OBJECT_SIZE = 0xdc04;
const PROP_OBJECT_FILE_NAME = 0xdc07;
const PROP_DATE_MODIFIED = 0xdc09;
const PROP_PARENT_OBJECT = 0xdc0b;
const CLASS_STILL_IMAGE = 6;
const ALL_HANDLES = 0xffffffff;
const CHUNK = 16 * 1024;
const USB_TIMEOUT_MS = 20_000;
const DTYPE_UINT16 = 0x0004;
const DTYPE_UINT32 = 0x0006;
const DTYPE_UINT64 = 0x0008;
const DTYPE_STRING = 0xffff;

type TransferOut = (data: Buffer) => Promise<void>;
type TransferIn = () => Promise<Buffer>;

type UsbDevice = {
  deviceDescriptor: { idVendor: number; idProduct: number; iProduct: number; iSerialNumber: number };
  configDescriptor?: { interfaces?: unknown };
  interfaces?: UsbIface[];
  open: () => void;
  close: () => void;
  reset?: (cb: (err?: Error | null) => void) => void;
  getStringDescriptor?: (index: number, cb: (err?: Error | null, value?: string) => void) => void;
};

type UsbIface = {
  descriptor: { bInterfaceClass: number; bInterfaceSubClass: number };
  endpoints: Array<{
    direction: string;
    transferType: number;
    descriptor: { wMaxPacketSize: number };
    timeout?: number;
    transfer: (sizeOrData: number | Buffer, cb: (error?: Error | null, data?: Buffer) => void) => void;
  }>;
  isKernelDriverActive?: () => boolean;
  detachKernelDriver?: () => void;
  claim: () => void;
  release: (cb: (error?: Error | null) => void) => void;
};

type LiveSession = {
  info: MtpDeviceInfo;
  client: UsbMtpClient;
  drop: () => Promise<void>;
};

const VENDOR_SAMSUNG = 0x04e8;

export function usbStallMessage(error: unknown) {
  const msg = error instanceof Error ? error.message : String(error);
  if (/0x2009|Short MTP packet/i.test(msg)) {
    return "USB listing broke (invalid MTP handle). Unlock the device, set File transfer, unplug and plug it back in, then index a smaller folder such as DCIM/Camera.";
  }
  if (/TIMED_OUT|PIPE|LIBUSB/i.test(msg)) {
    return "The phone USB connection stalled. Unlock it, set File transfer, unplug and plug it back in.";
  }
  return msg;
}

function mtpIface(device: UsbDevice): UsbIface | undefined {
  return device.interfaces?.find(
    (iface) => iface.descriptor.bInterfaceClass === CLASS_STILL_IMAGE && iface.descriptor.bInterfaceSubClass === 1,
  );
}

function hasMtpConfig(device: UsbDevice) {
  const ifaces = device.configDescriptor?.interfaces;
  if (!Array.isArray(ifaces)) return false;
  return ifaces.some((entry) => {
    const alts = Array.isArray(entry) ? entry : [entry];
    return alts.some(
      (iface) =>
        iface &&
        typeof iface === "object" &&
        (iface as { bInterfaceClass?: number }).bInterfaceClass === CLASS_STILL_IMAGE &&
        (iface as { bInterfaceSubClass?: number }).bInterfaceSubClass === 1,
    );
  });
}

function stringDesc(device: UsbDevice, index: number): Promise<string | null> {
  if (!index || !device.getStringDescriptor) return Promise.resolve(null);
  return new Promise((resolve) => {
    device.getStringDescriptor(index, (err, value) => resolve(err ? null : value || null));
  });
}

function command(code: number, transactionId: number, params: number[]) {
  const buf = Buffer.alloc(12 + params.length * 4);
  buf.writeUInt32LE(buf.length, 0);
  buf.writeUInt16LE(TYPE_COMMAND, 4);
  buf.writeUInt16LE(code, 6);
  buf.writeUInt32LE(transactionId, 8);
  params.forEach((param, i) => buf.writeUInt32LE(param >>> 0, 12 + i * 4));
  return buf;
}

function parseMtpDate(value: string): string | null {
  const match = value.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})/);
  if (!match) return null;
  return `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}Z`;
}

function readPtpString(buf: Buffer, offset: number) {
  if (offset >= buf.length) return { value: "", next: offset };
  const chars = buf[offset]!;
  if (chars === 0) return { value: "", next: offset + 1 };
  const value = buf.subarray(offset + 1, offset + 1 + Math.max(0, chars - 1) * 2).toString("utf16le");
  return { value, next: offset + 1 + chars * 2 };
}

function parseObjectInfo(handle: number, buf: Buffer): MtpObject & { parent: number } {
  const format = buf.length >= 6 ? buf.readUInt16LE(4) : 0;
  const size = buf.length >= 12 ? buf.readUInt32LE(8) : 0;
  const parent = buf.length >= 42 ? buf.readUInt32LE(38) : 0;
  const fileName = readPtpString(buf, 52);
  const capture = readPtpString(buf, fileName.next);
  const modified = readPtpString(buf, capture.next);
  return {
    handle,
    name: fileName.value,
    size,
    format,
    takenAt: parseMtpDate(capture.value) ?? parseMtpDate(modified.value),
    parent,
  };
}

function parseHandles(payload: Buffer) {
  if (payload.length < 4) return [];
  const count = payload.readUInt32LE(0);
  const out: number[] = [];
  for (let i = 0; i < count && 4 + (i + 1) * 4 <= payload.length; i += 1) {
    out.push(payload.readUInt32LE(4 + i * 4));
  }
  return out;
}

export function parseStorageIds(payload: Buffer) {
  if (payload.length < 4) return [];
  const count = payload.readUInt32LE(0);
  if (count === 0) return [];
  if (count > 0 && count < 64 && payload.length >= 4 + count * 4) {
    const ids: number[] = [];
    for (let i = 0; i < count; i += 1) ids.push(payload.readUInt32LE(4 + i * 4));
    return ids.filter(Boolean);
  }
  const id = payload.readUInt32LE(0);
  return id ? [id] : [];
}

function skipPropValue(buf: Buffer, offset: number, dtype: number) {
  if (dtype === DTYPE_STRING) return readPtpString(buf, offset).next;
  if (dtype === 0x0001 || dtype === 0x0002) return offset + 1;
  if (dtype === 0x0003 || dtype === DTYPE_UINT16) return offset + 2;
  if (dtype === 0x0005 || dtype === DTYPE_UINT32) return offset + 4;
  if (dtype === 0x0007 || dtype === DTYPE_UINT64) return offset + 8;
  if (dtype === 0x0009 || dtype === 0x000a) return offset + 16;
  if (dtype >= 0x4000 && offset + 4 <= buf.length) {
    const count = buf.readUInt32LE(offset);
    const elem = dtype & 0xff;
    const size = elem <= 2 ? 1 : elem <= 4 ? 2 : elem <= 6 ? 4 : elem <= 8 ? 8 : 16;
    return offset + 4 + count * size;
  }
  return offset + 4;
}

export function parseObjectPropList(payload: Buffer): Array<MtpObject & { parent: number }> {
  if (payload.length < 4) return [];
  const count = payload.readUInt32LE(0);
  const byHandle = new Map<number, MtpObject & { parent: number }>();
  let offset = 4;
  for (let i = 0; i < count && offset + 8 <= payload.length; i += 1) {
    const handle = payload.readUInt32LE(offset);
    const prop = payload.readUInt16LE(offset + 4);
    const dtype = payload.readUInt16LE(offset + 6);
    offset += 8;
    const row = byHandle.get(handle) ?? {
      handle,
      name: "",
      size: 0,
      format: 0,
      takenAt: null,
      parent: 0,
    };
    if (prop === PROP_OBJECT_FILE_NAME && dtype === DTYPE_STRING) {
      const parsed = readPtpString(payload, offset);
      row.name = parsed.value;
      offset = parsed.next;
    } else if (prop === PROP_OBJECT_FORMAT && (dtype === DTYPE_UINT16 || dtype === DTYPE_UINT32)) {
      row.format = dtype === DTYPE_UINT16 ? payload.readUInt16LE(offset) : payload.readUInt32LE(offset);
      offset = skipPropValue(payload, offset, dtype);
    } else if (prop === PROP_OBJECT_SIZE && (dtype === DTYPE_UINT32 || dtype === DTYPE_UINT64)) {
      row.size = Number(dtype === DTYPE_UINT32 ? payload.readUInt32LE(offset) : payload.readBigUInt64LE(offset));
      offset = skipPropValue(payload, offset, dtype);
    } else if (prop === PROP_PARENT_OBJECT && dtype === DTYPE_UINT32) {
      row.parent = payload.readUInt32LE(offset);
      offset = skipPropValue(payload, offset, dtype);
    } else if (prop === PROP_DATE_MODIFIED && dtype === DTYPE_STRING) {
      const parsed = readPtpString(payload, offset);
      row.takenAt = parseMtpDate(parsed.value);
      offset = parsed.next;
    } else {
      offset = skipPropValue(payload, offset, dtype);
    }
    byHandle.set(handle, row);
  }
  return [...byHandle.values()].filter((row) => row.name);
}

function isRootParent(parent: number) {
  return parent === 0 || parent === ALL_HANDLES;
}

function filterNested(rows: Array<MtpObject & { parent: number }>, parent: number) {
  const matched = rows.filter((row) => row.parent === parent);
  return matched.length ? matched : rows;
}

async function readExact(transfer: (size: number) => Promise<Buffer>, packetSize: number): Promise<Buffer> {
  let first = Buffer.alloc(0);
  for (let i = 0; i < 3 && first.length === 0; i += 1) {
    first = await transfer(packetSize);
  }
  if (first.length < 12) throw new Error("Short MTP packet");
  const length = first.readUInt32LE(0);
  if (length < 12) throw new Error("Short MTP packet");
  const chunks = [first];
  let got = first.length;
  while (got < length) {
    const next = await transfer(Math.min(CHUNK, Math.max(packetSize, length - got)));
    if (!next.length) throw new Error("Short MTP packet");
    chunks.push(next);
    got += next.length;
  }
  return Buffer.concat(chunks, got).subarray(0, length);
}

function dataContainer(code: number, transactionId: number, payload: Buffer) {
  const buf = Buffer.alloc(12 + payload.length);
  buf.writeUInt32LE(buf.length, 0);
  buf.writeUInt16LE(TYPE_DATA, 4);
  buf.writeUInt16LE(code, 6);
  buf.writeUInt32LE(transactionId, 8);
  payload.copy(buf, 12);
  return buf;
}

function writePtpString(value: string) {
  if (!value) return Buffer.from([0]);
  const units = value.length + 1;
  const buf = Buffer.alloc(1 + units * 2);
  buf.writeUInt8(units, 0);
  buf.write(value, 1, "utf16le");
  return buf;
}

export function encodeObjectInfo(input: {
  storageId: number;
  format: number;
  size: number;
  parent: number;
  name: string;
  associationType?: number;
}) {
  const name = writePtpString(input.name);
  const empty = writePtpString("");
  const buf = Buffer.alloc(52 + name.length + empty.length * 3);
  buf.writeUInt32LE(input.storageId >>> 0, 0);
  buf.writeUInt16LE(input.format, 4);
  buf.writeUInt32LE(input.size >>> 0, 8);
  buf.writeUInt32LE(input.parent >>> 0, 38);
  buf.writeUInt16LE(input.associationType ?? 0, 42);
  name.copy(buf, 52);
  empty.copy(buf, 52 + name.length);
  empty.copy(buf, 52 + name.length + empty.length);
  empty.copy(buf, 52 + name.length + empty.length * 2);
  return buf;
}

function parseResponseParams(payload: Buffer) {
  const out: number[] = [];
  for (let offset = 0; offset + 4 <= payload.length; offset += 4) {
    out.push(payload.readUInt32LE(offset));
  }
  return out;
}

async function transact(
  send: TransferOut,
  recv: TransferIn,
  txn: number,
  code: number,
  params: number[],
  outgoing?: Buffer,
) {
  await send(command(code, txn, params));
  if (outgoing) await send(dataContainer(code, txn, outgoing));
  let data = Buffer.alloc(0);
  for (;;) {
    const packet = await recv();
    if (packet.length < 12) throw new Error("Short MTP packet");
    const type = packet.readUInt16LE(4);
    const pktCode = packet.readUInt16LE(6);
    const payload = packet.subarray(12, packet.readUInt32LE(0));
    if (type === TYPE_DATA) {
      data = payload;
      continue;
    }
    if (type !== TYPE_RESPONSE) continue;
    if (type === TYPE_RESPONSE) {
      if (pktCode !== RESP_OK && pktCode !== RESP_SESSION_ALREADY_OPEN) {
        throw new Error(`MTP error 0x${pktCode.toString(16)}`);
      }
      return { data, params: parseResponseParams(payload) };
    }
  }
}

class UsbMtpClient implements MtpClient {
  private txn = 10;
  private readonly cache = new Map<number, MtpObject[]>();
  constructor(
    readonly label: string,
    private readonly storageId: number,
    private readonly send: TransferOut,
    private readonly recv: TransferIn,
    private readonly drain: () => Promise<void>,
    private readonly locked: <T>(fn: () => Promise<T>) => Promise<T>,
    private readonly releaseRef: () => Promise<void>,
    private readonly usePropList: boolean,
  ) {}

  private inventory: Array<MtpObject & { parent: number }> | null = null;

  clearCache() {
    this.cache.clear();
    this.inventory = null;
  }

  private async op(code: number, params: number[], outgoing?: Buffer) {
    return (await transact(this.send, this.recv, this.txn++, code, params, outgoing)).data;
  }

  private opFull(code: number, params: number[], outgoing?: Buffer) {
    return transact(this.send, this.recv, this.txn++, code, params, outgoing);
  }

  async listChildren(parent: number): Promise<MtpObject[]> {
    return this.locked(async () => {
      const cached = this.cache.get(parent);
      if (cached?.length) return cached;
      try {
        let kids: MtpObject[] = [];
        if (this.usePropList && parent === 0) {
          kids = (await this.tryPropList(parent)) ?? [];
        }
        if (!kids.length) kids = await this.listByHandles(parent);
        if (!kids.length) kids = (await this.tryPropList(parent)) ?? [];
        if (kids.length) this.cache.set(parent, kids);
        return kids;
      } catch (error) {
        throw new Error(usbStallMessage(error));
      }
    });
  }

  private async listByHandles(parent: number) {
    const direct = await this.readInfos(await this.objectHandles(parent));
    let kids =
      parent === 0 ? direct.filter((row) => isRootParent(row.parent)) : filterNested(direct, parent);
    if (parent !== 0 && !kids.length) {
      const all = await this.loadInventory();
      kids = all.filter((row) => row.parent === parent);
    }
    return kids.map(({ parent: _parent, ...row }) => row);
  }

  private async readInfos(handles: number[]) {
    const out: Array<MtpObject & { parent: number }> = [];
    for (const handle of handles) {
      if (!handle || handle === ALL_HANDLES) continue;
      try {
        out.push(parseObjectInfo(handle, await this.op(OP_GET_OBJECT_INFO, [handle])));
      } catch {
        /* skip unreadable object */
      }
    }
    return out;
  }

  private async loadInventory() {
    if (this.inventory) return this.inventory;
    this.inventory = await this.readInfos(await this.objectHandles(ALL_HANDLES));
    return this.inventory;
  }

  private async objectHandles(parent: number) {
    const attempts =
      parent === 0
        ? [
            [this.storageId, 0, 0],
            [this.storageId, 0, ALL_HANDLES],
            [this.storageId, FMT_ASSOCIATION, 0],
            [this.storageId, FMT_ASSOCIATION, ALL_HANDLES],
          ]
        : parent === ALL_HANDLES
          ? [
              [this.storageId, 0, ALL_HANDLES],
              [this.storageId, FMT_ASSOCIATION, ALL_HANDLES],
            ]
          : [
              [this.storageId, 0, parent >>> 0],
              [this.storageId, FMT_ASSOCIATION, parent >>> 0],
              [0, 0, parent >>> 0],
              [ALL_HANDLES, 0, parent >>> 0],
            ];
    for (const params of attempts) {
      try {
        const handles = parseHandles(await this.op(OP_GET_OBJECT_HANDLES, params));
        if (handles.length) return handles;
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        if (/Short MTP|LIBUSB|TIMED_OUT|PIPE|0x2009/i.test(msg)) await this.drain();
      }
    }
    return [];
  }

  private async tryPropList(parent: number): Promise<MtpObject[] | null> {
    const objectHandle = parent === 0 ? ALL_HANDLES : parent;
    const format = parent === 0 ? FMT_ASSOCIATION : 0;
    const depth = parent === 0 ? 0 : 1;
    const attempts = [
      [objectHandle >>> 0, format, 0xffffffff, 0, depth],
      [this.storageId, objectHandle >>> 0, format, 0xffffffff, depth],
    ];
    for (const params of attempts) {
      try {
        const data = await this.op(OP_GET_OBJECT_PROP_LIST, params);
        const rows = parseObjectPropList(data);
        if (!rows.length) continue;
        const kids =
          parent === 0
            ? rows.filter((row) => isRootParent(row.parent))
            : rows.filter((row) => row.parent === parent && row.handle !== parent);
        return kids.map(({ parent: _parent, ...row }) => row);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        if (/Short MTP|LIBUSB|TIMED_OUT|PIPE|0x2009/i.test(msg)) await this.drain();
      }
    }
    return null;
  }

  async readObject(handle: number) {
    return this.locked(async () => {
      try {
        return await this.op(OP_GET_OBJECT, [handle]);
      } catch (error) {
        throw new Error(usbStallMessage(error));
      }
    });
  }

  async mkdir(parent: number, name: string) {
    return this.locked(async () => {
      try {
        const sent = await this.opFull(
          OP_SEND_OBJECT_INFO,
          [this.storageId, parent >>> 0],
          encodeObjectInfo({
            storageId: this.storageId,
            format: FMT_ASSOCIATION,
            size: 0,
            parent,
            name,
            associationType: 1,
          }),
        );
        this.clearCache();
        return sent.params[2] || 0;
      } catch (error) {
        throw new Error(usbStallMessage(error));
      }
    });
  }

  async sendObject(parent: number, name: string, bytes: Uint8Array) {
    return this.locked(async () => {
      try {
        const payload = Buffer.from(bytes);
        const sent = await this.opFull(
          OP_SEND_OBJECT_INFO,
          [this.storageId, parent >>> 0],
          encodeObjectInfo({
            storageId: this.storageId,
            format: 0x3000,
            size: payload.length,
            parent,
            name,
          }),
        );
        await this.opFull(OP_SEND_OBJECT, [], payload);
        this.clearCache();
        return sent.params[2] || 0;
      } catch (error) {
        throw new Error(usbStallMessage(error));
      }
    });
  }

  async deleteObject(handle: number) {
    return this.locked(async () => {
      try {
        await this.op(OP_DELETE_OBJECT, [handle >>> 0]);
        this.clearCache();
      } catch (error) {
        throw new Error(usbStallMessage(error));
      }
    });
  }

  async close() {
    await this.locked(() => this.releaseRef());
  }
}

export class UsbMtpHost implements MtpHost {
  private chain: Promise<unknown> = Promise.resolve();
  private live: LiveSession | null = null;
  private refs = 0;
  private readonly known = new Map<string, { serial: string | null; label: string }>();

  exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async listDevices(): Promise<MtpDeviceInfo[]> {
    return this.exclusive(async () => {
      let getDeviceList: () => UsbDevice[];
      try {
        ({ getDeviceList } = (await import("usb")) as unknown as { getDeviceList: () => UsbDevice[] });
      } catch {
        return this.live ? [this.live.info] : [];
      }
      const plugged = getDeviceList();
      if (this.live) {
        const { vendorId, productId } = this.live.info;
        const stillThere = plugged.some(
          (device) => device.deviceDescriptor.idVendor === vendorId && device.deviceDescriptor.idProduct === productId,
        );
        if (!stillThere) await this.dropLive();
        else return [this.live.info];
      }
      const found: MtpDeviceInfo[] = [];
      for (const device of plugged) {
        try {
          if (!hasMtpConfig(device)) continue;
        } catch {
          continue;
        }
        const { idVendor, idProduct } = device.deviceDescriptor;
        const remembered = this.known.get(`${idVendor}:${idProduct}`);
        found.push({
          vendorId: idVendor,
          productId: idProduct,
          serial: remembered?.serial ?? null,
          label: remembered?.label ?? "Android",
        });
      }
      const seen = new Set<string>();
      return found.filter((device) => {
        const key = `${device.vendorId}:${device.productId}:${device.serial ?? ""}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    });
  }

  async open(info: MtpDeviceInfo): Promise<MtpClient> {
    return this.exclusive(async () => {
      if (this.live && this.matches(this.live.info, info)) {
        this.refs += 1;
        return this.live.client;
      }
      if (this.live) await this.dropLive();
      this.live = await this.claim(info);
      this.refs = 1;
      return this.live.client;
    });
  }

  private matches(left: MtpDeviceInfo, right: MtpDeviceInfo) {
    return left.vendorId === right.vendorId && left.productId === right.productId;
  }

  private async releaseRef() {
    this.refs = Math.max(0, this.refs - 1);
  }

  private async dropLive() {
    const live = this.live;
    this.live = null;
    this.refs = 0;
    live?.client.clearCache();
    if (live) await live.drop();
  }

  private async claim(info: MtpDeviceInfo): Promise<LiveSession> {
    const { getDeviceList } = (await import("usb")) as unknown as { getDeviceList: () => UsbDevice[] };
    const device = getDeviceList().find(
      (item) => item.deviceDescriptor.idVendor === info.vendorId && item.deviceDescriptor.idProduct === info.productId,
    );
    if (!device) throw new Error("Android phone not connected. Unlock it and set USB to File transfer.");
    await releaseOtherMtpClients();
    device.open();
    const iface = mtpIface(device);
    if (!iface) {
      device.close();
      throw new Error("This phone is not in File transfer mode.");
    }
    try {
      if (iface.isKernelDriverActive?.()) iface.detachKernelDriver?.();
      iface.claim();
    } catch {
      device.close();
      throw new Error("Quit Android File Transfer, then plug the phone in again.");
    }
    const bulkOut = iface.endpoints.find((ep) => ep.direction === "out" && ep.transferType === 2);
    const bulkIn = iface.endpoints.find((ep) => ep.direction === "in" && ep.transferType === 2);
    if (bulkOut) bulkOut.timeout = USB_TIMEOUT_MS;
    if (bulkIn) bulkIn.timeout = USB_TIMEOUT_MS;
    if (!bulkOut || !bulkIn) {
      await promisify(iface.release.bind(iface))();
      device.close();
      throw new Error("This phone is not in File transfer mode.");
    }
    const send: TransferOut = (data) =>
      new Promise((resolve, reject) => {
        bulkOut.transfer(data, (error) => (error ? reject(error) : resolve()));
      });
    const recv: TransferIn = () =>
      readExact(
        (size) =>
          new Promise((resolve, reject) => {
            bulkIn.transfer(size, (error, data) => (error ? reject(error) : resolve(data ?? Buffer.alloc(0))));
          }),
        bulkIn.descriptor.wMaxPacketSize || 512,
      );
    const drain = async () => {
      const prev = bulkIn.timeout;
      bulkIn.timeout = 200;
      try {
        for (let i = 0; i < 8; i += 1) {
          try {
            const leftover = await new Promise<Buffer>((resolve, reject) => {
              bulkIn.transfer(bulkIn.descriptor.wMaxPacketSize || 512, (error, data) =>
                error ? reject(error) : resolve(data ?? Buffer.alloc(0)),
              );
            });
            if (!leftover.length) break;
          } catch {
            break;
          }
        }
      } finally {
        bulkIn.timeout = prev;
      }
    };
    const drop = async () => {
      try {
        await transact(send, recv, 0xfffffffe, OP_CLOSE_SESSION, []);
      } catch {
        /* already closed */
      }
      try {
        await promisify(iface.release.bind(iface))();
      } catch {
        /* already released */
      }
      try {
        device.close();
      } catch {
        /* already closed */
      }
    };
    let txn = 1;
    const begin = async () => {
      await transact(send, recv, txn++, OP_OPEN_SESSION, [1]);
      for (let i = 0; i < 8; i += 1) {
        const ids = parseStorageIds((await transact(send, recv, txn++, OP_GET_STORAGE_IDS, [])).data);
        if (ids[0]) return ids[0];
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      throw new Error("Phone storage is not available over USB. Unlock it and set File transfer.");
    };
    try {
      let storageId: number;
      try {
        storageId = await begin();
      } catch {
        await drain();
        try {
          await transact(send, recv, txn++, OP_CLOSE_SESSION, []);
        } catch {
          /* session may already be closed */
        }
        await new Promise((resolve) => setTimeout(resolve, 300));
        storageId = await begin();
      }
      const serial = info.serial ?? (await stringDesc(device, device.deviceDescriptor.iSerialNumber));
      const label =
        (await stringDesc(device, device.deviceDescriptor.iProduct))?.replaceAll("_", " ") || info.label || "Android";
      const resolved: MtpDeviceInfo = { vendorId: info.vendorId, productId: info.productId, serial, label };
      this.known.set(`${info.vendorId}:${info.productId}`, { serial, label });
      const client = new UsbMtpClient(
        label,
        storageId,
        send,
        recv,
        drain,
        (fn) => this.exclusive(fn),
        () => this.releaseRef(),
        info.vendorId === VENDOR_SAMSUNG,
      );
      return { info: resolved, client, drop };
    } catch (error) {
      await drop();
      throw new Error(usbStallMessage(error));
    }
  }
}
