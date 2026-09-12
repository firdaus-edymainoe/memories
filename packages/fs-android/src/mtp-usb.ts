import { execFile } from "node:child_process";
import { platform } from "node:os";
import { promisify } from "node:util";
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
const IDLE_MS = 20_000;
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

export function usbStallMessage(error: unknown) {
  const msg = error instanceof Error ? error.message : String(error);
  if (/TIMED_OUT|PIPE|LIBUSB/i.test(msg)) {
    return "The phone USB connection stalled. Unlock it, set File transfer, unplug and plug it back in.";
  }
  return msg;
}

async function releaseOtherMtpClients() {
  if (platform() !== "darwin") return;
  const run = promisify(execFile);
  await Promise.allSettled([
    run("killall", ["PTPCamera"], { timeout: 2000 }),
    run("killall", ["Android File Transfer"], { timeout: 2000 }),
  ]);
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

function parseStorageIds(payload: Buffer) {
  if (payload.length < 4) return [];
  const count = payload.readUInt32LE(0);
  if (count > 0 && count < 64 && payload.length >= 4 + count * 4) {
    const ids: number[] = [];
    for (let i = 0; i < count; i += 1) ids.push(payload.readUInt32LE(4 + i * 4));
    return ids;
  }
  return [payload.readUInt32LE(0)];
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

async function readExact(transfer: (size: number) => Promise<Buffer>, packetSize: number): Promise<Buffer> {
  const first = await transfer(packetSize);
  if (first.length < 12) throw new Error("Short MTP packet");
  const length = first.readUInt32LE(0);
  const chunks = [first];
  let got = first.length;
  while (got < length) {
    const next = await transfer(Math.min(CHUNK, Math.max(packetSize, length - got)));
    chunks.push(next);
    got += next.length;
  }
  return Buffer.concat(chunks, got).subarray(0, length);
}

async function transact(send: TransferOut, recv: TransferIn, txn: number, code: number, params: number[]) {
  await send(command(code, txn, params));
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
    if (type === TYPE_RESPONSE) {
      if (pktCode !== RESP_OK && pktCode !== RESP_SESSION_ALREADY_OPEN) {
        throw new Error(`MTP error 0x${pktCode.toString(16)}`);
      }
      return data;
    }
  }
}

class UsbMtpClient implements MtpClient {
  private txn = 10;
  constructor(
    readonly label: string,
    private readonly storageId: number,
    private readonly send: TransferOut,
    private readonly recv: TransferIn,
    private readonly locked: <T>(fn: () => Promise<T>) => Promise<T>,
    private readonly releaseRef: () => Promise<void>,
  ) {}

  private op(code: number, params: number[]) {
    return transact(this.send, this.recv, this.txn++, code, params);
  }

  async listChildren(parent: number): Promise<MtpObject[]> {
    return this.locked(async () => {
      try {
        const fromProps = await this.tryPropList(parent);
        if (fromProps) return fromProps;
        const format = parent === 0 ? FMT_ASSOCIATION : 0;
        const association = parent === 0 ? ALL_HANDLES : parent;
        const handles = parseHandles(await this.op(OP_GET_OBJECT_HANDLES, [this.storageId, format, association >>> 0]));
        const out: Array<MtpObject & { parent: number }> = [];
        for (const handle of handles) {
          try {
            out.push(parseObjectInfo(handle, await this.op(OP_GET_OBJECT_INFO, [handle])));
          } catch {
            /* skip unreadable object */
          }
        }
        const kids = parent === 0 ? out.filter((row) => isRootParent(row.parent)) : out;
        return kids.map(({ parent: _parent, ...row }) => row);
      } catch (error) {
        throw new Error(usbStallMessage(error));
      }
    });
  }

  private async tryPropList(parent: number): Promise<MtpObject[] | null> {
    try {
      const objectHandle = parent === 0 ? ALL_HANDLES : parent;
      const format = parent === 0 ? FMT_ASSOCIATION : 0;
      const depth = parent === 0 ? 0 : 1;
      const data = await this.op(OP_GET_OBJECT_PROP_LIST, [
        this.storageId,
        objectHandle >>> 0,
        format,
        0xffffffff,
        depth,
      ]);
      const rows = parseObjectPropList(data);
      if (!rows.length) return null;
      const kids = parent === 0 ? rows.filter((row) => isRootParent(row.parent)) : rows.filter((row) => row.handle !== parent);
      return kids.map(({ parent: _parent, ...row }) => row);
    } catch {
      return null;
    }
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

  async close() {
    await this.locked(() => this.releaseRef());
  }
}

export class UsbMtpHost implements MtpHost {
  private chain: Promise<unknown> = Promise.resolve();
  private live: LiveSession | null = null;
  private refs = 0;
  private idle: ReturnType<typeof setTimeout> | null = null;
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
      this.clearIdle();
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

  private clearIdle() {
    if (this.idle) {
      clearTimeout(this.idle);
      this.idle = null;
    }
  }

  private async releaseRef() {
    this.refs = Math.max(0, this.refs - 1);
    if (this.refs > 0) return;
    this.clearIdle();
    this.idle = setTimeout(() => {
      void this.exclusive(async () => {
        if (this.refs === 0) await this.dropLive();
      });
    }, IDLE_MS);
  }

  private async dropLive() {
    const live = this.live;
    this.live = null;
    this.refs = 0;
    this.clearIdle();
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
      try {
        await promisify((device.reset ?? ((cb: (err?: Error | null) => void) => cb())).bind(device))();
        iface.claim();
      } catch {
        device.close();
        throw new Error("Quit Android File Transfer, then plug the phone in again.");
      }
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
    const begin = async () => {
      await transact(send, recv, 1, OP_OPEN_SESSION, [1]);
      let ids = parseStorageIds(await transact(send, recv, 2, OP_GET_STORAGE_IDS, []));
      if (!ids[0]) {
        await new Promise((resolve) => setTimeout(resolve, 400));
        ids = parseStorageIds(await transact(send, recv, 3, OP_GET_STORAGE_IDS, []));
      }
      const storageId = ids[0];
      if (!storageId) throw new Error("Phone storage is not available over USB.");
      return storageId;
    };
    try {
      let storageId: number;
      try {
        storageId = await begin();
      } catch {
        try {
          await promisify((device.reset ?? ((cb: (err?: Error | null) => void) => cb())).bind(device))();
        } catch {
          /* reset optional */
        }
        if (iface.isKernelDriverActive?.()) iface.detachKernelDriver?.();
        try {
          iface.claim();
        } catch {
          /* still claimed */
        }
        storageId = await begin();
      }
      const serial = info.serial ?? (await stringDesc(device, device.deviceDescriptor.iSerialNumber));
      const label =
        (await stringDesc(device, device.deviceDescriptor.iProduct))?.replaceAll("_", " ") || info.label || "Android";
      const resolved: MtpDeviceInfo = { vendorId: info.vendorId, productId: info.productId, serial, label };
      this.known.set(`${info.vendorId}:${info.productId}`, { serial, label });
      const client = new UsbMtpClient(label, storageId, send, recv, (fn) => this.exclusive(fn), () => this.releaseRef());
      return { info: resolved, client, drop };
    } catch (error) {
      try {
        await promisify((device.reset ?? ((cb: (err?: Error | null) => void) => cb())).bind(device))();
      } catch {
        /* reset optional */
      }
      await drop();
      throw new Error(usbStallMessage(error));
    }
  }
}
