import { describe, expect, it } from "vitest";
import { CloudApi } from "./api.js";
import { cloudRoot, parseCloudRoot } from "./file-io.js";

describe("signed uploads", () => {
  it("sends a stream in pieces of the size the provider asks for", async () => {
    const sent: Array<{ range: string | null; bytes: string; auth: string | null }> = [];
    const api = new CloudApi("https://cloud.test", () => "session", (async (_url: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      sent.push({ range: headers.get("content-range"), bytes: new TextDecoder().decode(init?.body as Uint8Array), auth: headers.get("authorization") });
      return new Response(null, { status: sent.length < 3 ? 202 : 201 });
    }) as typeof fetch);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const part of ["ab", "cdefg", "hij"]) controller.enqueue(new TextEncoder().encode(part));
        controller.close();
      },
    });
    await api.uploadSigned({ method: "PUT", url: "https://upload.test/s", headers: {}, expiresAt: "", chunked: { maxBytes: 4 } }, stream, 10);
    expect(sent).toEqual([
      { range: "bytes 0-3/10", bytes: "abcd", auth: null },
      { range: "bytes 4-7/10", bytes: "efgh", auth: null },
      { range: "bytes 8-9/10", bytes: "ij", auth: null },
    ]);
  });

  it("refuses a body that is not the size it promised", async () => {
    const api = new CloudApi("https://cloud.test", () => null, (async () => new Response(null, { status: 202 })) as typeof fetch);
    const request = { method: "PUT" as const, url: "https://upload.test/s", headers: {}, expiresAt: "", chunked: { maxBytes: 4 } };
    await expect(api.uploadSigned(request, new Uint8Array(3), 10)).rejects.toThrow(/changed/);
  });
});

describe("cloud roots", () => {
  it("tells Memories Cloud and connected drives apart", () => {
    expect(parseCloudRoot(cloudRoot("u1"))).toEqual({ userId: "u1", driveId: null });
    expect(parseCloudRoot(cloudRoot("u1", "drv_9"))).toEqual({ userId: "u1", driveId: "drv_9" });
    for (const bad of ["/Users/me", "cloud://", "cloud://u1/x", "cloud://u1/drives/", "cloud://u1/drives/a/b"]) expect(parseCloudRoot(bad)).toBeNull();
  });
});
