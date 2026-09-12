import { describe, expect, it } from "vitest";
import { NodeFileIO } from "./file-io.js";
import { mkdtemp, writeFile } from "node:fs/promises";
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
