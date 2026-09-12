import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { kindFromName, mimeFromName, relativeInsideRoot, type DirEntry, type FileIO, type FileStat } from "@memories/core";
import { mtpRoot, parseMtpRoot } from "./mtp-uri.js";

export const FMT_ASSOCIATION = 0x3001;

export type MtpObject = {
  handle: number;
  name: string;
  size: number;
  format: number;
  takenAt: string | null;
};

export type MtpClient = {
  label: string;
  listChildren(parent: number): Promise<MtpObject[]>;
  readObject(handle: number): Promise<Uint8Array>;
  close(): Promise<void>;
};

export type MtpDeviceInfo = {
  vendorId: number;
  productId: number;
  serial: string | null;
  label: string;
};

export type MtpHost = {
  listDevices(): Promise<MtpDeviceInfo[]>;
  open(device: MtpDeviceInfo): Promise<MtpClient>;
};

function joinRoot(remoteRoot: string, relativePath: string) {
  const rel = relativeInsideRoot(relativePath);
  if (!rel) return remoteRoot.replace(/\/$/, "") || "/";
  return `${remoteRoot.replace(/\/$/, "")}/${rel}`;
}

async function findDir(client: MtpClient, parent: number, names: string[]): Promise<MtpObject | null> {
  const want = new Set(names.map((n) => n.toLowerCase()));
  const kids = await client.listChildren(parent);
  return kids.find((row) => row.format === FMT_ASSOCIATION && want.has(row.name.toLowerCase())) ?? null;
}

async function resolveStart(client: MtpClient, remoteRoot: string): Promise<number> {
  const parts = relativeInsideRoot(remoteRoot.replace(/^\//, "")).split("/").filter(Boolean);
  let handle = 0;
  for (const part of parts) {
    const dir = await findDir(client, handle, [part]);
    if (!dir) throw new Error(`No ${remoteRoot} folder on the phone. Set USB to File transfer.`);
    handle = dir.handle;
  }
  return handle;
}

async function walkFrom(client: MtpClient, handle: number, folder: string, out: FileStat[]): Promise<void> {
  const kids = await client.listChildren(handle);
  for (const row of kids) {
    const relativePath = folder ? `${folder}/${row.name}` : row.name;
    if (row.format === FMT_ASSOCIATION) {
      if (row.name.startsWith(".")) continue;
      await walkFrom(client, row.handle, relativePath, out);
      continue;
    }
    if (row.name.startsWith(".")) continue;
    out.push({
      relativePath,
      size: row.size,
      mime: mimeFromName(row.name),
      kind: kindFromName(row.name),
      takenAt: row.takenAt,
      place: null,
    });
  }
}

export class MtpFileIO implements FileIO {
  constructor(private readonly host: MtpHost) {}

  private async session(rootPath: string) {
    const target = parseMtpRoot(rootPath);
    const client = await this.host.open({
      vendorId: target.vendorId,
      productId: target.productId,
      serial: target.serial,
      label: "Android",
    });
    return { client, target };
  }

  async walk(rootPath: string, subPath = ""): Promise<FileStat[]> {
    const { client, target } = await this.session(rootPath);
    try {
      const start = await resolveStart(client, joinRoot(target.remoteRoot, subPath));
      const out: FileStat[] = [];
      await walkFrom(client, start, relativeInsideRoot(subPath), out);
      return out;
    } finally {
      await client.close();
    }
  }

  async list(rootPath: string, subPath = ""): Promise<DirEntry[]> {
    const { client, target } = await this.session(rootPath);
    try {
      const start = await resolveStart(client, joinRoot(target.remoteRoot, subPath));
      const prefix = relativeInsideRoot(subPath);
      const kids = await client.listChildren(start);
      return kids
        .filter((row) => row.name && !row.name.startsWith("."))
        .map((row) => {
          const directory = row.format === FMT_ASSOCIATION;
          return {
            name: row.name,
            relativePath: prefix ? `${prefix}/${row.name}` : row.name,
            directory,
            size: row.size,
            kind: directory ? null : kindFromName(row.name),
          };
        })
        .sort((a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name));
    } finally {
      await client.close();
    }
  }

  async hash(rootPath: string, relativePath: string) {
    const bytes = await this.read(rootPath, relativePath);
    return createHash("sha256").update(bytes).digest("hex");
  }

  async read(rootPath: string, relativePath: string) {
    const { client, target } = await this.session(rootPath);
    try {
      const handle = await this.lookup(client, joinRoot(target.remoteRoot, relativePath));
      return await client.readObject(handle);
    } finally {
      await client.close();
    }
  }

  async exists(rootPath: string, relativePath: string) {
    try {
      const { client, target } = await this.session(rootPath);
      try {
        await this.lookup(client, joinRoot(target.remoteRoot, relativePath));
        return true;
      } finally {
        await client.close();
      }
    } catch {
      return false;
    }
  }

  async mkdir(_rootPath: string, _relativePath: string) {
    throw new Error("Creating folders on the phone is not supported");
  }

  async copy(_args: Parameters<FileIO["copy"]>[0]) {
    throw new Error("Copy on the phone itself is not supported");
  }

  async pull(rootPath: string, relativePath: string, localAbs: string) {
    const bytes = await this.read(rootPath, relativePath);
    await mkdir(dirname(localAbs), { recursive: true });
    await writeFile(localAbs, bytes);
    return localAbs;
  }

  async push(_localAbs: string, _rootPath: string, _relativePath: string) {
    throw new Error("Copying onto the phone is not supported");
  }

  private async lookup(client: MtpClient, absPath: string) {
    const parts = relativeInsideRoot(absPath.replace(/^\//, "")).split("/").filter(Boolean);
    let handle = 0;
    let row: MtpObject | undefined;
    for (const part of parts) {
      const kids = await client.listChildren(handle);
      row = kids.find((item) => item.name === part);
      if (!row) throw new Error(`Missing ${absPath}`);
      handle = row.handle;
    }
    if (!row || row.format === FMT_ASSOCIATION) throw new Error(`Missing ${absPath}`);
    return row.handle;
  }
}

export class MtpVolumes {
  constructor(private readonly host: MtpHost) {}

  async list() {
    const devices = await this.host.listDevices();
    return devices.map((device) => ({
      volumeId: `mtp:${device.vendorId.toString(16)}:${device.productId.toString(16)}${device.serial ? `:${device.serial}` : ""}`,
      mountPath: mtpRoot(device.vendorId, device.productId, device.serial),
      label: device.label,
    }));
  }

  async identify(rootPath: string) {
    parseMtpRoot(rootPath);
    const volumes = await this.list();
    const match = volumes.find(
      (volume) => rootPath === volume.mountPath || rootPath.startsWith(`${volume.mountPath}/`),
    );
    if (!match) throw new Error("Android phone not connected. Unlock it and set USB to File transfer.");
    return { ...match, mountPath: rootPath };
  }
}
