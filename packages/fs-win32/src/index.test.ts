import { DestinationExistsError } from "@memories/core";
import { describe, expect, it } from "vitest";
import { NodeFileIO } from "./file-io.js";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("fs-win32 FileIO", () => {
  it("sandboxes copies inside the registered folder", async () => {
    const io = new NodeFileIO();
    const root = await mkdtemp(join(tmpdir(), "mem-win-"));
    await writeFile(join(root, "a.jpg"), "x");
    await expect(io.copy({ fromRoot: root, fromRelative: "a.jpg", toRoot: root, toRelative: "../x.jpg" })).rejects.toThrow(
      /escapes drive root/,
    );
    await io.copy({ fromRoot: root, fromRelative: "a.jpg", toRoot: root, toRelative: "b.jpg" });
    expect(await io.exists(root, "b.jpg")).toBe(true);
  });
});

describe("NodeFileIO.copy", () => {
  it("refuses to overwrite and leaves no temp files behind", async () => {
    const io = new NodeFileIO();
    const source = await mkdtemp(join(tmpdir(), "mem-copy-src-"));
    const dest = await mkdtemp(join(tmpdir(), "mem-copy-dst-"));
    await writeFile(join(source, "a.jpg"), "new bytes");
    await mkdir(join(dest, "DCIM"), { recursive: true });
    await writeFile(join(dest, "DCIM", "a.jpg"), "precious bytes");

    await expect(
      io.copy({ fromRoot: source, fromRelative: "a.jpg", toRoot: dest, toRelative: "DCIM/a.jpg" }),
    ).rejects.toBeInstanceOf(DestinationExistsError);
    expect(await readFile(join(dest, "DCIM", "a.jpg"), "utf8")).toBe("precious bytes");

    await io.copy({ fromRoot: source, fromRelative: "a.jpg", toRoot: dest, toRelative: "DCIM/b.jpg" });
    expect(await readFile(join(dest, "DCIM", "b.jpg"), "utf8")).toBe("new bytes");
    expect((await readdir(join(dest, "DCIM"))).sort()).toEqual(["a.jpg", "b.jpg"]);
  });

  it("does not leave a file behind when the copy fails", async () => {
    const io = new NodeFileIO();
    const source = await mkdtemp(join(tmpdir(), "mem-copy-src-"));
    const dest = await mkdtemp(join(tmpdir(), "mem-copy-dst-"));
    await expect(
      io.copy({ fromRoot: source, fromRelative: "missing.jpg", toRoot: dest, toRelative: "x.jpg" }),
    ).rejects.toThrow();
    expect(await readdir(dest)).toEqual([]);
  });
});

describe("NodeFileIO.describe", () => {
  it("reads the capture date from a photo's EXIF and ignores files without one", async () => {
    const io = new NodeFileIO();
    const fixtures = join(import.meta.dirname, "..", "..", "..", "fixtures");
    const details = await io.describe(fixtures, "taken-2019-07-04.jpg");
    expect(new Date(details.takenAt!).getFullYear()).toBe(2019);
    expect(new Date(details.takenAt!).getMonth()).toBe(6);
    expect(await io.describe(fixtures, "notes.txt")).toEqual({});
  });
});
