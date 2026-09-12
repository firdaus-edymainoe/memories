import { relativeInsideRoot } from "@memories/core";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AndroidFileIO } from "./file-io.js";
import { MergeVolumes, SwitchFileIO } from "./switch.js";
import { AndroidVolumes } from "./volumes.js";
import type { Runner } from "./run.js";
import { FMT_ASSOCIATION, MtpFileIO, type MtpClient, type MtpHost, type MtpObject } from "./mtp.js";
import { mtpRoot, parseMtpRoot } from "./mtp-uri.js";
import { parseObjectPropList, usbStallMessage } from "./mtp-usb.js";
import { adbRoot, parseAdbRoot } from "./uri.js";

function fake(script: Record<string, string>): Runner {
  return async (_bin, args) => {
    const key = args.join(" ");
    const hit = Object.entries(script).find(([pattern]) => key.includes(pattern));
    if (!hit) throw new Error(`unexpected adb ${key}`);
    return { stdout: hit[1], stderr: "" };
  };
}

describe("parseAdbRoot", () => {
  it("splits serial and remote folder", () => {
    expect(parseAdbRoot("adb://ABC123/sdcard/DCIM")).toEqual({
      serial: "ABC123",
      remoteRoot: "/sdcard/DCIM",
    });
  });

  it("rejects traversal and injection", () => {
    expect(() => parseAdbRoot("adb://ABC123/sdcard/../etc")).toThrow(/escapes/);
    expect(() => parseAdbRoot("adb://ABC123/sdcard;rm")).toThrow(/escapes/);
    expect(() => parseAdbRoot("adb://bad serial/sdcard")).toThrow(/Invalid/);
  });
});

describe("AndroidVolumes", () => {
  it("lists authorized devices", async () => {
    const volumes = new AndroidVolumes(
      fake({
        "devices -l": "List of devices attached\nABC123 device product:oriole model:Pixel_6\n",
      }),
    );
    const list = await volumes.list();
    expect(list).toEqual([
      { volumeId: "ABC123", mountPath: adbRoot("ABC123", "/sdcard"), label: "Pixel 6" },
    ]);
    const id = await volumes.identify(adbRoot("ABC123", "/sdcard/DCIM"));
    expect(id.volumeId).toBe("ABC123");
  });
});

describe("AndroidFileIO", () => {
  it("walks DCIM and hashes on the phone", async () => {
    const io = new AndroidFileIO(
      fake({
        "find '/sdcard/DCIM'": "12 1700000000 /sdcard/DCIM/Camera/a.jpg\n",
        "sha256sum '/sdcard/DCIM/Camera/a.jpg'": "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef  /sdcard/DCIM/Camera/a.jpg\n",
      }),
    );
    const root = adbRoot("ABC123", "/sdcard/DCIM");
    const files = await io.walk(root);
    expect(files[0]?.relativePath).toBe("Camera/a.jpg");
    expect(await io.hash(root, "Camera/a.jpg")).toBe("deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef");
    expect(relativeInsideRoot("Camera/a.jpg")).toBe("Camera/a.jpg");
  });

  it("lists one folder level", async () => {
    const io = new AndroidFileIO(
      fake({
        "ls -1p '/sdcard'": "DCIM/\nDownload/\nnote.txt\n",
      }),
    );
    const entries = await io.list(adbRoot("ABC123", "/sdcard"));
    expect(entries.map((entry) => entry.name)).toEqual(["DCIM", "Download", "note.txt"]);
    expect(entries[0]?.directory).toBe(true);
    expect(entries[2]?.directory).toBe(false);
  });
});

describe("SwitchFileIO", () => {
  it("pulls from the phone onto a local folder", async () => {
    const dest = await mkdtemp(join(tmpdir(), "mem-adb-"));
    const io = new SwitchFileIO(
      {
        walk: async () => [],
        list: async () => [],
        hash: async () => "",
        read: async () => new Uint8Array(),
        exists: async () => false,
        mkdir: async () => undefined,
        copy: async () => undefined,
      },
      new AndroidFileIO(async (_bin, args) => {
        if (args.includes("pull")) {
          await writeFile(args.at(-1)!, "photo-bytes");
          return { stdout: "", stderr: "" };
        }
        throw new Error(`unexpected adb ${args.join(" ")}`);
      }),
    );
    await io.copy({
      fromRoot: adbRoot("ABC123", "/sdcard/DCIM"),
      fromRelative: "Camera/a.jpg",
      toRoot: dest,
      toRelative: "Camera/a.jpg",
    });
    expect(await readFile(join(dest, "Camera", "a.jpg"), "utf8")).toBe("photo-bytes");
  });
});

describe("MergeVolumes", () => {
  it("routes adb paths to the Android adapter", async () => {
    const merged = new MergeVolumes(
      {
        list: async () => [{ volumeId: "mac", mountPath: "/", label: "Mac" }],
        identify: async () => ({ volumeId: "mac", mountPath: "/", label: "Mac" }),
      },
      new AndroidVolumes(
        fake({
          "devices -l": "List of devices attached\nABC123 device model:Pixel_6\n",
        }),
      ),
    );
    const list = await merged.list();
    expect(list.map((v) => v.volumeId)).toEqual(["mac", "ABC123"]);
    expect((await merged.identify(adbRoot("ABC123", "/sdcard/DCIM"))).volumeId).toBe("ABC123");
    expect((await merged.identify("/Users/me")).volumeId).toBe("mac");
  });
});

describe("parseMtpRoot", () => {
  it("defaults to the storage root", () => {
    expect(parseMtpRoot("mtp://18d1-4ee2")).toEqual({
      vendorId: 0x18d1,
      productId: 0x4ee2,
      serial: null,
      remoteRoot: "/",
    });
  });

  it("splits vendor, product, and Camera folder", () => {
    expect(parseMtpRoot("mtp://18d1-4ee2/DCIM")).toEqual({
      vendorId: 0x18d1,
      productId: 0x4ee2,
      serial: null,
      remoteRoot: "/DCIM",
    });
  });
});

describe("MtpFileIO", () => {
  it("walks Camera without adb", async () => {
    const children: Record<number, MtpObject[]> = {
      0: [{ handle: 1, name: "DCIM", size: 0, format: FMT_ASSOCIATION, takenAt: null }],
      1: [{ handle: 2, name: "Camera", size: 0, format: FMT_ASSOCIATION, takenAt: null }],
      2: [{ handle: 3, name: "a.jpg", size: 4, format: 0x3801, takenAt: "2026-01-01T00:00:00.000Z" }],
    };
    const host: MtpHost = {
      listDevices: async () => [{ vendorId: 0x18d1, productId: 0x4ee2, serial: null, label: "Pixel 6" }],
      open: async () =>
        ({
          label: "Pixel 6",
          listChildren: async (parent) => children[parent] ?? [],
          readObject: async () => new Uint8Array([1, 2, 3, 4]),
          close: async () => undefined,
        }) satisfies MtpClient,
    };
    const io = new MtpFileIO(host);
    const root = mtpRoot(0x18d1, 0x4ee2, null, "/DCIM");
    const files = await io.walk(root);
    expect(files[0]?.relativePath).toBe("Camera/a.jpg");
    expect(await io.hash(root, "Camera/a.jpg")).toMatch(/^[0-9a-f]{64}$/);
    const listed = await io.list(mtpRoot(0x18d1, 0x4ee2));
    expect(listed.map((entry) => entry.name)).toEqual(["DCIM"]);
    expect(listed[0]?.directory).toBe(true);
  });
});

describe("parseObjectPropList", () => {
  it("reads name, parent, and format from one object", () => {
    const name = Buffer.alloc(1 + 10);
    name.writeUInt8(5, 0);
    Buffer.from("DCIM", "utf16le").copy(name, 1);
    const fileName = Buffer.alloc(8 + name.length);
    fileName.writeUInt32LE(10, 0);
    fileName.writeUInt16LE(0xdc07, 4);
    fileName.writeUInt16LE(0xffff, 6);
    name.copy(fileName, 8);
    const parent = Buffer.alloc(12);
    parent.writeUInt32LE(10, 0);
    parent.writeUInt16LE(0xdc0b, 4);
    parent.writeUInt16LE(0x0006, 6);
    parent.writeUInt32LE(0, 8);
    const format = Buffer.alloc(10);
    format.writeUInt32LE(10, 0);
    format.writeUInt16LE(0xdc02, 4);
    format.writeUInt16LE(0x0004, 6);
    format.writeUInt16LE(0x3001, 8);
    const payload = Buffer.alloc(4 + fileName.length + parent.length + format.length);
    payload.writeUInt32LE(3, 0);
    fileName.copy(payload, 4);
    parent.copy(payload, 4 + fileName.length);
    format.copy(payload, 4 + fileName.length + parent.length);
    expect(parseObjectPropList(payload)).toEqual([
      { handle: 10, name: "DCIM", size: 0, format: 0x3001, takenAt: null, parent: 0 },
    ]);
  });
});

describe("usbStallMessage", () => {
  it("turns a libusb timeout into a recovery hint", () => {
    expect(usbStallMessage(new Error("LIBUSB_TRANSFER_TIMED_OUT"))).toMatch(/unplug/i);
  });
});
