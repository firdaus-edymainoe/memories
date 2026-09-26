import { relativeInsideRoot } from "@memories/core";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AndroidFileIO } from "./file-io.js";
import { MergeVolumes, SwitchFileIO } from "./switch.js";
import { AndroidVolumes } from "./volumes.js";
import type { Runner } from "./run.js";
import { FMT_ASSOCIATION, MtpFileIO, MtpVolumes, isMtpFolder, unsupportedMtpWrites, type MtpClient, type MtpHost, type MtpObject } from "./mtp.js";
import { mtpRoot, parseMtpRoot } from "./mtp-uri.js";
import { encodeObjectInfo, parseObjectPropList, parseStorageIds, usbStallMessage, UsbMtpHost } from "./mtp-usb.js";
import { adbRoot, parseAdbRoot } from "./uri.js";
import { parseWpdPnpId, pickWpdRoot, WpdMtpHost, type WpdObject } from "./mtp-wpd.js";
import { LibmtpHost, type LibmtpFile } from "./mtp-libmtp.js";
import { createOsMtpHost, FallbackMtpHost } from "./mtp-host.js";

function fakeMtp(partial: Partial<MtpClient> & Pick<MtpClient, "listChildren">): MtpClient {
  return {
    label: "Pad",
    readObject: async () => new Uint8Array([1, 2, 3, 4]),
    close: async () => undefined,
    ...unsupportedMtpWrites(),
    ...partial,
  };
}

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
        remove: async () => undefined,
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
        fakeMtp({
          label: "Pixel 6",
          listChildren: async (parent) => children[parent] ?? [],
          readObject: async () => new Uint8Array([1, 2, 3, 4]),
        }),
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

  it("treats Android folders without Association format as directories", async () => {
    const children: Record<number, MtpObject[]> = {
      0: [{ handle: 1, name: "DCIM", size: 0, format: FMT_ASSOCIATION, takenAt: null }],
      1: [{ handle: 2, name: "Camera", size: 0, format: 0, takenAt: null }],
      2: [{ handle: 3, name: "a.jpg", size: 4, format: 0x3801, takenAt: null }],
    };
    const host: MtpHost = {
      listDevices: async () => [{ vendorId: 0x2717, productId: 0xff40, serial: null, label: "Pad" }],
      open: async () =>
        fakeMtp({
          label: "Pad",
          listChildren: async (parent) => children[parent] ?? [],
          readObject: async () => new Uint8Array([1]),
        }),
    };
    const io = new MtpFileIO(host);
    const listed = await io.list(mtpRoot(0x2717, 0xff40), "DCIM");
    expect(listed).toEqual([
      { name: "Camera", relativePath: "DCIM/Camera", directory: true, size: 0, kind: null },
    ]);
    expect(isMtpFolder({ format: 0, size: 0, name: "Camera" })).toBe(true);
    expect(isMtpFolder({ format: 0x3801, size: 0, name: "a.jpg" })).toBe(false);
  });

  it("reuses Download and sends a new file onto the phone", async () => {
    const children: Record<number, MtpObject[]> = {
      0: [{ handle: 1, name: "Download", size: 0, format: FMT_ASSOCIATION, takenAt: null }],
      1: [],
    };
    const mkdirs: string[] = [];
    const sent: Array<{ parent: number; name: string; bytes: number }> = [];
    const host: MtpHost = {
      listDevices: async () => [{ vendorId: 0x2717, productId: 0xff40, serial: null, label: "Pad" }],
      open: async () =>
        fakeMtp({
          listChildren: async (parent) => children[parent] ?? [],
          mkdir: async (parent, name) => {
            mkdirs.push(name);
            const handle = 40 + mkdirs.length;
            children[parent] = [...(children[parent] ?? []), { handle, name, size: 0, format: FMT_ASSOCIATION, takenAt: null }];
            children[handle] = [];
            return handle;
          },
          sendObject: async (parent, name, bytes) => {
            sent.push({ parent, name, bytes: bytes.byteLength });
            const handle = 80;
            children[parent] = [
              ...(children[parent] ?? []),
              { handle, name, size: bytes.byteLength, format: 0x3000, takenAt: null },
            ];
            return handle;
          },
        }),
    };
    const io = new MtpFileIO(host);
    const root = mtpRoot(0x2717, 0xff40);
    const local = await mkdtemp(join(tmpdir(), "mem-mtp-push-"));
    await writeFile(join(local, "e2e.txt"), "hello-pad");
    await io.mkdir(root, "Download");
    expect(mkdirs).toEqual([]);
    await io.push(join(local, "e2e.txt"), root, "Download/e2e.txt");
    expect(sent).toEqual([{ parent: 1, name: "e2e.txt", bytes: 9 }]);
    await io.mkdir(root, "MemoriesE2E");
    expect(mkdirs).toEqual(["MemoriesE2E"]);
  });
});

describe("MtpVolumes", () => {
  it("identifies a phone after the serial appears on the volume", async () => {
    const volumes = new MtpVolumes({
      listDevices: async () => [
        { vendorId: 0x2717, productId: 0xff40, serial: "71f53f87", label: "Xiaomi Pad 6" },
      ],
      open: async () => {
        throw new Error("unused");
      },
    });
    const id = await volumes.identify("mtp://2717-ff40");
    expect(id.mountPath).toBe("mtp://2717-ff40");
    expect(id.volumeId).toBe("mtp:2717:ff40:71f53f87");
  });
});

describe("parseStorageIds", () => {
  it("treats a zero count as no storage", () => {
    const payload = Buffer.alloc(4);
    expect(parseStorageIds(payload)).toEqual([]);
  });
});

describe("encodeObjectInfo", () => {
  it("puts the name after the 52-byte header", () => {
    const buf = encodeObjectInfo({ storageId: 1, format: 0x3001, size: 0, parent: 0, name: "Download", associationType: 1 });
    expect(buf.readUInt32LE(0)).toBe(1);
    expect(buf.readUInt16LE(4)).toBe(0x3001);
    expect(buf.readUInt16LE(42)).toBe(1);
    expect(buf.readUInt8(52)).toBe(9);
    expect(buf.subarray(53, 53 + 16).toString("utf16le")).toBe("Download");
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

  it("turns Xiaomi invalid-handle and short packets into a recovery hint", () => {
    expect(usbStallMessage(new Error("MTP error 0x2009"))).toMatch(/File transfer/i);
    expect(usbStallMessage(new Error("Short MTP packet"))).toMatch(/DCIM\/Camera/i);
  });
});

describe("parseWpdPnpId", () => {
  it("reads vendor, product, and serial from a USB WPD id", () => {
    expect(
      parseWpdPnpId("\\\\?\\usb#vid_04e8&pid_6860#R5CY2232HMY#{6ac27878-a6fa-4155-ba85-f98f491d4f33}"),
    ).toEqual({ vendorId: 0x04e8, productId: 0x6860, serial: "R5CY2232HMY" });
  });
});

describe("pickWpdRoot", () => {
  it("flattens a single storage object so browse starts at DCIM", () => {
    expect(
      pickWpdRoot([
        { objectId: "s10001", name: "Internal shared storage", size: 0, folder: true, takenAt: null },
      ]),
    ).toBe("s10001");
  });

  it("keeps DEVICE when the phone has two storages", () => {
    expect(
      pickWpdRoot([
        { objectId: "s1", name: "Phone", size: 0, folder: true, takenAt: null },
        { objectId: "s2", name: "SD card", size: 0, folder: true, takenAt: null },
      ]),
    ).toBe("DEVICE");
  });
});

describe("WpdMtpHost", () => {
  it("browses and reads through mapped WPD object ids", async () => {
    const children: Record<string, WpdObject[]> = {
      DEVICE: [{ objectId: "s1", name: "Xiaomi Pad 6", size: 0, folder: true, takenAt: null }],
      s1: [{ objectId: "dcim", name: "DCIM", size: 0, folder: true, takenAt: null }],
      dcim: [{ objectId: "cam", name: "Camera", size: 0, folder: true, takenAt: null }],
      cam: [{ objectId: "pic", name: "a.jpg", size: 4, folder: false, takenAt: "2026-01-01T00:00:00.000Z" }],
    };
    const host = new WpdMtpHost({
      listDevices: async () => [
        {
          pnpId: "\\\\?\\usb#vid_2717&pid_ff40#ABCD#{6ac27878-a6fa-4155-ba85-f98f491d4f33}",
          vendorId: 0x2717,
          productId: 0xff40,
          serial: "ABCD",
          label: "Xiaomi Pad 6",
        },
      ],
      open: async () => ({
        listChildren: async (parent) => children[parent] ?? [],
        readObject: async (id) => {
          if (id !== "pic") throw new Error("MTP error 0x2009");
          return new Uint8Array([1, 2, 3, 4]);
        },
        close: async () => undefined,
      }),
    });
    const io = new MtpFileIO(host);
    const root = mtpRoot(0x2717, 0xff40, "ABCD");
    const listed = await io.list(root);
    expect(listed.map((entry) => entry.name)).toEqual(["DCIM"]);
    expect(await io.hash(root, "DCIM/Camera/a.jpg")).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("LibmtpHost", () => {
  it("lists Camera through libmtp handles", async () => {
    const children: Record<number, LibmtpFile[]> = {
      0xffffffff: [{ itemId: 1, name: "DCIM", size: 0, folder: true, modified: 0 }],
      1: [{ itemId: 2, name: "Camera", size: 0, folder: true, modified: 0 }],
      2: [
        { itemId: 3, name: "ok.jpg", size: 4, folder: false, modified: 1_700_000_000 },
        { itemId: 4, name: "bad.jpg", size: 4, folder: false, modified: 1_700_000_000 },
      ],
    };
    const host = new LibmtpHost({
      detect: async () => [{ vendorId: 0x18d1, productId: 0x4ee2, serial: "PIXEL", label: "Pixel 6" }],
      open: async () => ({
        label: "Pixel 6",
        listChildren: async (parent) => children[parent] ?? [],
        readObject: async (handle) => {
          if (handle === 4) throw new Error("Could not read that file from the phone.");
          return new Uint8Array([9, 8, 7, 6]);
        },
        close: async () => undefined,
      }),
    });
    const io = new MtpFileIO(host);
    const root = mtpRoot(0x18d1, 0x4ee2, "PIXEL");
    const files = await io.walk(root, "DCIM/Camera");
    expect(files.map((file) => file.relativePath)).toEqual(["DCIM/Camera/ok.jpg", "DCIM/Camera/bad.jpg"]);
    expect(await io.hash(root, "DCIM/Camera/ok.jpg")).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("createOsMtpHost", () => {
  it("selects WPD on Windows and USB MTP on macOS", () => {
    expect(createOsMtpHost("win32")).toBeInstanceOf(WpdMtpHost);
    expect(createOsMtpHost("darwin")).toBeInstanceOf(UsbMtpHost);
  });
});

describe("FallbackMtpHost", () => {
  it("uses the secondary host when the primary cannot open", async () => {
    const host = new FallbackMtpHost(
      {
        listDevices: async () => [{ vendorId: 0x2717, productId: 0xff40, serial: null, label: "Pad" }],
        open: async () => {
          throw new Error("libmtp storage unavailable");
        },
      },
      {
        listDevices: async () => [],
        open: async () =>
          fakeMtp({
            label: "Pad",
            listChildren: async () => [{ handle: 1, name: "DCIM", size: 0, format: FMT_ASSOCIATION, takenAt: null }],
            readObject: async () => new Uint8Array([1]),
          }),
      },
    );
    const client = await host.open({ vendorId: 0x2717, productId: 0xff40, serial: null, label: "Pad" });
    expect((await client.listChildren(0)).map((row) => row.name)).toEqual(["DCIM"]);
  });
});

