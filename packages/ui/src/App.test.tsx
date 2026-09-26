import { MemoriesClient } from "@memories/client";
import type { VolumePresence } from "@memories/core";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoriesApp } from "./App.js";

function fakeClient(volumes: VolumePresence[] = [], delayMs = 0, extras: { drives?: boolean } = {}): MemoriesClient {
  const phone = {
    id: "drv_phone",
    name: "Pixel 6",
    kind: "phone" as const,
    rootPath: "mtp://18d1-4ee2",
    volumeId: "mtp:18d1:4ee2",
    online: true,
  };
  const ssd = {
    id: "drv_ssd",
    name: "Summer SSD",
    kind: "disk" as const,
    rootPath: "/Volumes/SSD",
    volumeId: "ssd",
    online: true,
  };
  let catalog = extras.drives ? [{ ...phone }, { ...ssd }] : [];
  let jobs: Array<{
    id: string;
    sourceDriveId: string;
    destDriveId: string;
    sourceRelativePaths: string[];
    lastRunAt: string | null;
  }> = [];

  async function entriesAt(relativePath: string) {
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
  }

  return {
    mediaUrl: (id: string) => `/media/${id}`,
    driveMediaUrl: (id: string, path: string) => `/drives/${id}/media?path=${encodeURIComponent(path)}`,
    drives: async () => catalog.map((drive) => ({ ...drive })),
    files: async () => [],
    events: async () => [],
    backups: async () => jobs,
    saveBackup: async (input: { sourceDriveId: string; destDriveId: string; sourceRelativePaths: string[] }) => {
      const job = { id: "job_1", lastRunAt: null, ...input };
      jobs = [job];
      return job;
    },
    folders: async () => [],
    volumes: async () => volumes,
    registerDrive: async (input?: { name?: string; rootPath?: string }) => {
      if (input?.name) phone.name = input.name;
      if (input?.rootPath) phone.rootPath = input.rootPath;
      const next = { ...phone };
      catalog = [next, ...catalog.filter((drive) => drive.id !== phone.id)];
      return next;
    },
    ingest: async () => ({ files: 0, replicas: 0 }),
    volumeEntries: async (_mount: string, relativePath = "") => entriesAt(relativePath),
    driveEntries: async (_id: string, relativePath = "") => {
      const prefix = phone.rootPath.replace(/^mtp:\/\/[^/]+\/?/, "");
      const full = [prefix, relativePath].filter(Boolean).join("/");
      const rows = await entriesAt(full);
      if (!prefix) return rows;
      return rows.map((entry) => ({
        ...entry,
        relativePath: entry.relativePath.startsWith(`${prefix}/`)
          ? entry.relativePath.slice(prefix.length + 1)
          : entry.name,
      }));
    },
  } as unknown as MemoriesClient;
}

describe("MemoriesApp", () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute("data-theme");
    document.documentElement.style.colorScheme = "";
    Object.defineProperty(window, "matchMedia", {
      writable: true,
      configurable: true,
      value: (query: string) => ({
        matches: false,
        media: query,
        addEventListener() {},
        removeEventListener() {},
        addListener() {},
        removeListener() {},
        dispatchEvent() {
          return false;
        },
        onchange: null,
      }),
    });
  });

  afterEach(() => {
    cleanup();
    document.documentElement.removeAttribute("data-theme");
    document.documentElement.removeAttribute("data-chrome");
    delete window.memoriesChrome;
  });

  it("skips welcome into Images", async () => {
    render(<MemoriesApp client={fakeClient()} />);
    expect(document.querySelector(".scene-welcome .print")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Skip welcome" }));
    expect(await screen.findByRole("button", { name: "Browse menu" })).toBeTruthy();
  });

  it("plays a new welcome scene on each Continue", () => {
    render(<MemoriesApp client={fakeClient()} />);
    expect(document.querySelector(".scene-welcome .print")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(document.querySelector(".scene-files .tiles")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(document.querySelector(".scene-drives .drv.wait")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(document.querySelector(".scene-copy .c3")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(document.querySelector(".scene-cloud .optional")).toBeTruthy();
  });

  it("opens the sidebar as a drawer from the browse menu", async () => {
    render(<MemoriesApp client={fakeClient()} />);
    fireEvent.click(screen.getByRole("button", { name: "Skip welcome" }));
    expect(await screen.findByRole("button", { name: "Browse menu" })).toBeTruthy();
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
    expect(await screen.findByRole("button", { name: "Choose a folder on Pixel 6" })).toBeTruthy();
  });

  it("opens the phone storage so you can browse folders", async () => {
    render(
      <MemoriesApp
        client={fakeClient([{ volumeId: "mtp:18d1:4ee2", mountPath: "mtp://18d1-4ee2", label: "Pixel 6" }])}
      />,
    );
    screen.getByRole("button", { name: "Skip welcome" }).click();
    (await screen.findByRole("button", { name: "Manage drives" })).click();
    (await screen.findByRole("button", { name: "Choose a folder on Pixel 6" })).click();
    expect(await screen.findByRole("button", { name: /DCIM/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Download/ })).toBeTruthy();
    screen.getByRole("button", { name: /DCIM/ }).click();
    expect(await screen.findByRole("button", { name: /Camera/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Use this folder" })).toBeTruthy();
  });

  it("shows a waiting polaroid while a big folder lists", async () => {
    render(
      <MemoriesApp
        client={fakeClient([{ volumeId: "mtp:18d1:4ee2", mountPath: "mtp://18d1-4ee2", label: "Pixel 6" }], 400)}
      />,
    );
    screen.getByRole("button", { name: "Skip welcome" }).click();
    (await screen.findByRole("button", { name: "Manage drives" })).click();
    (await screen.findByRole("button", { name: "Choose a folder on Pixel 6" })).click();
    (await screen.findByRole("button", { name: /DCIM/ })).click();
    expect(await screen.findByRole("status")).toBeTruthy();
    expect(screen.getByText("Reading DCIM")).toBeTruthy();
    expect(await screen.findByRole("button", { name: /Camera/ })).toBeTruthy();
  });

  it("previews a photo after using Camera as a drive", async () => {
    render(
      <MemoriesApp
        client={fakeClient([{ volumeId: "mtp:18d1:4ee2", mountPath: "mtp://18d1-4ee2", label: "Pixel 6" }])}
      />,
    );
    screen.getByRole("button", { name: "Skip welcome" }).click();
    (await screen.findByRole("button", { name: "Manage drives" })).click();
    (await screen.findByRole("button", { name: "Choose a folder on Pixel 6" })).click();
    (await screen.findByRole("button", { name: /DCIM/ })).click();
    (await screen.findByRole("button", { name: /Camera/ })).click();
    expect(await screen.findByRole("button", { name: /IMG_0001/ })).toBeTruthy();
    screen.getByRole("button", { name: "Use this folder" }).click();
    expect(await screen.findByText("Pixel 6 · Camera is a drive")).toBeTruthy();
    (await screen.findByRole("button", { name: /IMG_0001/ })).click();
    expect(await screen.findByRole("heading", { name: "IMG_0001.jpg" })).toBeTruthy();
    const preview = document.querySelector(".insp-preview img");
    expect(preview?.getAttribute("src")).toBe("/drives/drv_phone/media?path=IMG_0001.jpg");
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
    (await screen.findByRole("button", { name: "Choose a folder on Pixel 6" })).click();
    (await screen.findByRole("button", { name: /DCIM/ })).click();
    (await screen.findByRole("button", { name: /Camera/ })).click();
    expect(await screen.findByRole("button", { name: /VID_0001/ })).toBeTruthy();
    screen.getByRole("button", { name: "Use this folder" }).click();
    expect(await screen.findByText("Pixel 6 · Camera is a drive")).toBeTruthy();
    (await screen.findByRole("button", { name: /VID_0001/ })).click();
    expect(await screen.findByRole("button", { name: "Preview" })).toBeTruthy();
    expect(document.querySelector(".insp-preview video")).toBeNull();
    screen.getByRole("button", { name: "Preview" }).click();
    await waitFor(() => {
      expect(document.querySelector(".insp-preview video")?.getAttribute("src")).toContain("VID_0001.mp4");
    });
  });

  it("switches appearance from Settings", async () => {
    render(<MemoriesApp client={fakeClient()} />);
    screen.getByRole("button", { name: "Skip welcome" }).click();
    (await screen.findByRole("button", { name: "Settings" })).click();
    const select = await screen.findByRole("combobox", { name: "Appearance" });
    fireEvent.change(select, { target: { value: "dark" } });
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(localStorage.getItem("memories-theme")).toBe("dark");
    fireEvent.change(select, { target: { value: "light" } });
    expect(document.documentElement.dataset.theme).toBe("light");
  });

  it("restores a saved dark theme", () => {
    localStorage.setItem("memories-theme", "dark");
    render(<MemoriesApp client={fakeClient()} />);
    expect(document.documentElement.dataset.theme).toBe("dark");
  });

  it("uses the window chrome inset when running in Electron", async () => {
    window.memoriesChrome = { platform: "darwin", setTitleBar() {} };
    render(<MemoriesApp client={fakeClient()} />);
    await waitFor(() => {
      expect(document.documentElement.dataset.chrome).toBe("darwin");
    });
    expect(document.querySelector(".app.chrome-darwin")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Minimize" })).toBeNull();
  });

  it("keeps the Mac inset from the chrome query when preload is missing", async () => {
    window.history.pushState({}, "", "/?chrome=darwin");
    try {
      render(<MemoriesApp client={fakeClient()} />);
      fireEvent.click(screen.getByRole("button", { name: "Skip welcome" }));
      await waitFor(() => {
        expect(document.documentElement.dataset.chrome).toBe("darwin");
      });
      expect(document.querySelector(".app.chrome-darwin")).toBeTruthy();
      expect((document.querySelector(".brand") as HTMLElement).style.paddingLeft).toBe("74px");
      expect(document.querySelector(".tabs")).toBeNull();
      expect(screen.queryByRole("button", { name: "You" })).toBeNull();
    } finally {
      window.history.pushState({}, "", "/");
    }
  });

  it("draws Windows caption buttons in the Memories header", async () => {
    const closed: string[] = [];
    const chrome = {
      platform: "win32",
      setTitleBar() {},
      minimize() {},
      toggleMaximize() {},
      close() {
        closed.push("close");
      },
      isMaximized: async () => false,
      onMaximized: () => () => {},
    };
    window.memoriesChrome = chrome;
    render(<MemoriesApp client={fakeClient()} />);
    await waitFor(() => {
      expect(document.documentElement.dataset.chrome).toBe("win32");
    });
    expect(screen.getByRole("button", { name: "Minimize" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Maximize" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(closed).toEqual(["close"]);
  });

  it("lets you open folders on a drive and backup only the ones you check", async () => {
    render(<MemoriesApp client={fakeClient([], 0, { drives: true })} />);
    screen.getByRole("button", { name: "Skip welcome" }).click();
    (await screen.findByRole("button", { name: "Backup" })).click();
    (await screen.findByRole("button", { name: "New backup" })).click();
    (await screen.findByRole("button", { name: "Pixel 6 Connected — tap to use" })).click();
    expect(await screen.findByRole("button", { name: "Open DCIM" })).toBeTruthy();
    screen.getByRole("button", { name: "Open DCIM" }).click();
    expect(await screen.findByRole("button", { name: "Select Camera" })).toBeTruthy();
    screen.getByRole("button", { name: "Select Camera" }).click();
    expect(await screen.findByText("DCIM / Camera")).toBeTruthy();
    screen.getByRole("button", { name: "Continue" }).click();
    (await screen.findByRole("button", { name: "Summer SSD Connected" })).click();
    await waitFor(() => {
      expect((screen.getByRole("button", { name: "Save backup" }) as HTMLButtonElement).disabled).toBe(false);
    });
    screen.getByRole("button", { name: "Save backup" }).click();
    expect(await screen.findByText("Pixel 6 → Summer SSD")).toBeTruthy();
    expect(screen.getByText(/DCIM \/ Camera/)).toBeTruthy();
  });
});
