import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { JsonFileStateStore, type SecretBox } from "./index.js";

const reverse: SecretBox = {
  encrypt: (plain) => `sealed:${[...plain].reverse().join("")}`,
  decrypt: (sealed) => {
    if (!sealed.startsWith("sealed:")) throw new Error("not ours");
    return [...sealed.slice(7)].reverse().join("");
  },
};

const user = { id: "u1", email: "a@example.com", name: "A", role: "user" as const, emailVerified: true, image: null };

describe("JsonFileStateStore", () => {
  it("makes a device id once and keeps the token sealed on disk", async () => {
    const path = join(await mkdtemp(join(tmpdir(), "mem-cloud-")), "cloud.json");
    const store = new JsonFileStateStore(path, reverse);
    const first = await store.load();
    expect(first.deviceId).toMatch(/^dev_/);
    await store.save({ ...first, session: { token: "secret-token", user }, syncEnabled: true });

    expect(await readFile(path, "utf8")).not.toContain("secret-token");
    const again = await new JsonFileStateStore(path, reverse).load();
    expect(again).toMatchObject({ deviceId: first.deviceId, syncEnabled: true, session: { token: "secret-token", user } });
  });

  it("asks to sign in again when the token can't be unsealed", async () => {
    const path = join(await mkdtemp(join(tmpdir(), "mem-cloud-")), "cloud.json");
    await writeFile(path, JSON.stringify({ deviceId: "dev_x", session: { sealedToken: "other-machine", user }, syncEnabled: true }));
    expect(await new JsonFileStateStore(path, reverse).load()).toMatchObject({ deviceId: "dev_x", session: null, syncEnabled: true });
  });
});
