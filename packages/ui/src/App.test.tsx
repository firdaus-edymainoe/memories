import { MemoriesClient } from "@memories/client";
import type { VolumePresence } from "@memories/core";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoriesApp } from "./App.js";

function fakeClient(volumes: VolumePresence[] = [], delayMs = 0): MemoriesClient {
  const phone = {
    id: "drv_phone",
    name: "Pixel 6",
    kind: "phone" as const,
    rootPath: "mtp://18d1-4ee2",
    volumeId: "mtp:18d1:4ee2",
    online: true,
  };
  let registered = false;
  return {
    mediaUrl: (id: string) => `/media/${id}`,
    driveMediaUrl: (id: string, path: string) => `/drives/${id}/media?path=${encodeURIComponent(path)}`,
    drives: async () => (registered ? [phone] : []),
    files: async () => [],
    events: async () => [],
    backups: async () => [],
    folders: async () => [],
    volumes: async () => volumes,
    registerDrive: async () => {
      registered = true;
      return phone;
    },
    ingest: async () => ({ files: 0, replicas: 0 }),
    driveEntries: async (_id: string, relativePath = "") => {
      if (delayMs && relativePath) await new Promise((resolve) => setTimeout(resolve, delayMs));
      if (!relativePath) {
        return [
          { name: "DCIM", relativePath: "DCIM", directory: true, size: 0, kind: null },
          { name: "Download", relativePath: "Download", directory: true, size: 0, kind: null },
        ];
      }
      if (relativePath === "DCIM") {
        return [{ name: "Camera", relativePath: "DCIM/Camera", directory: true, size: 0, kind: null }];
      }
      if (relativePath === "DCIM/Camera") {
        return [
          { name: "IMG_0001.jpg", relativePath: "DCIM/Camera/IMG_0001.jpg", directory: false, size: 2400, kind: "photo" },
          { name: "VID_0001.mp4", relativePath: "DCIM/Camera/VID_0001.mp4", directory: false, size: 80_000_000, kind: "video" },
          { name: "notes.pdf", relativePath: "DCIM/Camera/notes.pdf", directory: false, size: 12000, kind: "document" },
        ];
      }
      return [];
    },
  } as unknown as MemoriesClient;
}

describe("MemoriesApp", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    cleanup();
  });

  it("skips welcome into Images", async () => {
    render(<MemoriesApp client={fakeClient()} />);
    screen.getByRole("button", { name: "Skip welcome" }).click();
    expect(await screen.findByText("Images")).toBeTruthy();
  });

  it("opens the sidebar as a drawer from the browse menu", async () => {
    render(<MemoriesApp client={fakeClient()} />);
    screen.getByRole("button", { name: "Skip welcome" }).click();
    expect(await screen.findByText("Images")).toBeTruthy();
    screen.getByRole("button", { name: "Browse menu" }).click();
    expect(await screen.findByRole("button", { name: "Browse menu", expanded: true })).toBeTruthy();
    expect(document.querySelector(".drawer-panel")).toBeTruthy();
  });

  it("offers a plugged-in Android phone on Drives", async () => {
    render(
      <MemoriesApp
        client={fakeClient([{ volumeId: "mtp:18d1:4ee2", mountPath: "mtp://18d1-4ee2", label: "Pixel 6" }])}
      />,
    );
    screen.getByRole("button", { name: "Skip welcome" }).click();
    (await screen.findByRole("button", { name: "Manage drives" })).click();
    expect(await screen.findByRole("button", { name: "Register Pixel 6" })).toBeTruthy();
  });

  it("opens the phone storage so you can browse folders", async () => {
    render(
      <MemoriesApp
        client={fakeClient([{ volumeId: "mtp:18d1:4ee2", mountPath: "mtp://18d1-4ee2", label: "Pixel 6" }])}
      />,
    );
    screen.getByRole("button", { name: "Skip welcome" }).click();
    (await screen.findByRole("button", { name: "Manage drives" })).click();
    (await screen.findByRole("button", { name: "Register Pixel 6" })).click();
    expect(await screen.findByRole("button", { name: /DCIM/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Download/ })).toBeTruthy();
    screen.getByRole("button", { name: /DCIM/ }).click();
    expect(await screen.findByRole("button", { name: /Camera/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Index this folder" })).toBeTruthy();
  });

  it("shows a waiting polaroid while a big folder lists", async () => {
    render(
      <MemoriesApp
        client={fakeClient([{ volumeId: "mtp:18d1:4ee2", mountPath: "mtp://18d1-4ee2", label: "Pixel 6" }], 400)}
      />,
    );
    screen.getByRole("button", { name: "Skip welcome" }).click();
    (await screen.findByRole("button", { name: "Manage drives" })).click();
    (await screen.findByRole("button", { name: "Register Pixel 6" })).click();
    (await screen.findByRole("button", { name: /DCIM/ })).click();
    expect(await screen.findByRole("status")).toBeTruthy();
    expect(screen.getByText("Reading DCIM")).toBeTruthy();
    expect(await screen.findByRole("button", { name: /Camera/ })).toBeTruthy();
  });

  it("previews a photo on the plugged-in drive without indexing", async () => {
    render(
      <MemoriesApp
        client={fakeClient([{ volumeId: "mtp:18d1:4ee2", mountPath: "mtp://18d1-4ee2", label: "Pixel 6" }])}
      />,
    );
    screen.getByRole("button", { name: "Skip welcome" }).click();
    (await screen.findByRole("button", { name: "Manage drives" })).click();
    (await screen.findByRole("button", { name: "Register Pixel 6" })).click();
    (await screen.findByRole("button", { name: /DCIM/ })).click();
    (await screen.findByRole("button", { name: /Camera/ })).click();
    (await screen.findByRole("button", { name: /IMG_0001/ })).click();
    expect(await screen.findByRole("heading", { name: "IMG_0001.jpg" })).toBeTruthy();
    const preview = document.querySelector(".insp-preview img");
    expect(preview?.getAttribute("src")).toBe("/drives/drv_phone/media?path=DCIM%2FCamera%2FIMG_0001.jpg");
    screen.getByRole("button", { name: "Open" }).click();
    expect(await screen.findByRole("img", { name: "IMG_0001.jpg" })).toBeTruthy();
  });

  it("asks before loading a large phone video over USB", async () => {
    render(
      <MemoriesApp
        client={fakeClient([{ volumeId: "mtp:18d1:4ee2", mountPath: "mtp://18d1-4ee2", label: "Pixel 6" }])}
      />,
    );
    screen.getByRole("button", { name: "Skip welcome" }).click();
    (await screen.findByRole("button", { name: "Manage drives" })).click();
    (await screen.findByRole("button", { name: "Register Pixel 6" })).click();
    (await screen.findByRole("button", { name: /DCIM/ })).click();
    (await screen.findByRole("button", { name: /Camera/ })).click();
    (await screen.findByRole("button", { name: /VID_0001/ })).click();
    expect(await screen.findByRole("button", { name: "Preview" })).toBeTruthy();
    expect(document.querySelector(".insp-preview video")).toBeNull();
    screen.getByRole("button", { name: "Preview" }).click();
    await waitFor(() => {
      expect(document.querySelector(".insp-preview video")?.getAttribute("src")).toContain("VID_0001.mp4");
    });
  });
});
