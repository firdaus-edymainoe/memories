import { MemoriesClient } from "@memories/client";
import type { LibraryFile, VolumePresence } from "@memories/core";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoriesApp } from "./App.js";

function fakeClient(
  volumes: VolumePresence[] = [],
  delayMs = 0,
  extras: { drives?: boolean; files?: LibraryFile[] } = {},
): MemoriesClient {
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
    files: async () => extras.files ?? [],
    file: async () => null,
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

  const phoneVolume = [{ volumeId: "mtp:18d1:4ee2", mountPath: "mtp://18d1-4ee2", label: "Pixel 6" }];

  async function openTour() {
    fireEvent.click(screen.getByRole("button", { name: "Welcome tour" }));
    await waitFor(() => expect(screen.getByRole("dialog", { name: "Welcome to Memories" })).toBeTruthy());
  }

  async function closeTour() {
    fireEvent.click(screen.getByRole("button", { name: "Skip welcome" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Welcome to Memories" })).toBeNull());
  }

  async function openPhoneCamera(client: MemoriesClient) {
    render(<MemoriesApp client={client} />);
    fireEvent.click(screen.getByRole("button", { name: "Places" }));
    fireEvent.click(await screen.findByRole("button", { name: "Choose a folder on Pixel 6" }));
    fireEvent.click(await screen.findByRole("button", { name: /DCIM/ }));
    fireEvent.click(await screen.findByRole("button", { name: /Camera/ }));
  }

  it("opens the welcome tour from the sidebar", async () => {
    render(<MemoriesApp client={fakeClient()} />);
    expect(screen.queryByRole("dialog", { name: "Welcome to Memories" })).toBeNull();
    await openTour();
    expect(document.querySelector(".scene-table .scene-obj")).toBeTruthy();
    await closeTour();
    expect(screen.getByRole("button", { name: "Menu" })).toBeTruthy();
  });

  it("walks through a new welcome scene on each Next", async () => {
    render(<MemoriesApp client={fakeClient()} />);
    await openTour();
    const scenes = [".scene-places", ".scene-lens", ".scene-unplug", ".scene-backup"];
    for (const scene of scenes) {
      fireEvent.click(screen.getByRole("button", { name: "Next" }));
      await waitFor(() => expect(document.querySelector(scene)).toBeTruthy());
    }
    expect(await screen.findByRole("heading", { name: "Keep a spare with Backup" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Get started" }));
    expect(await screen.findByRole("heading", { name: "Add a place" })).toBeTruthy();
  });

  it("explains Type and Date as two ways to find without filing", async () => {
    render(<MemoriesApp client={fakeClient()} />);
    await openTour();
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(await screen.findByRole("heading", { name: "You don’t have to organize" })).toBeTruthy();
    expect(screen.getByText(/Looking for a photo or a receipt/)).toBeTruthy();
    expect(document.querySelector(".scene-lens-q")?.textContent).toMatch(/looking for/i);
  });

  it("opens the sidebar as a drawer from the menu", async () => {
    render(<MemoriesApp client={fakeClient()} />);
    fireEvent.click(screen.getByRole("button", { name: "Menu" }));
    expect(await screen.findByRole("button", { name: "Menu", expanded: true })).toBeTruthy();
    expect(document.querySelector(".drawer-panel")).toBeTruthy();
  });

  it("groups files by type or date, and lets you switch inside a group", async () => {
    const files: LibraryFile[] = [
      { id: "a", objectHash: "a", name: "Beach.jpg", kind: "photo", takenAt: "2025-08-12T10:00:00", place: null, inbox: false },
      { id: "b", objectHash: "b", name: "Invoice.pdf", kind: "document", takenAt: "2025-08-20T10:00:00", place: null, inbox: false },
      { id: "c", objectHash: "c", name: "Printer.dmg", kind: "document", takenAt: "2026-01-05T10:00:00", place: null, inbox: true },
    ];
    render(<MemoriesApp client={fakeClient([], 0, { files })} />);
    expect(await screen.findByRole("region", { name: "Photos" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "Documents" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "Apps & installers" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Music & audio" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Apps & installers" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Code" })).toBeNull();

    fireEvent.click(screen.getByRole("radio", { name: "Date" }));
    expect(await screen.findByRole("region", { name: "August 2025" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "January 2026" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /August 2025/ }));
    expect(await screen.findByRole("button", { name: "Remove August 2025" })).toBeTruthy();
    fireEvent.click(screen.getByRole("radio", { name: "Type" }));
    expect(await screen.findByRole("region", { name: "Photos" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "Documents" })).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Apps & installers" })).toBeNull();

    fireEvent.change(screen.getByRole("searchbox", { name: "Find by name" }), { target: { value: "invoice" } });
    await waitFor(() => expect(screen.queryByRole("region", { name: "Photos" })).toBeNull());
    expect(screen.getByRole("button", { name: /Invoice\.pdf/ })).toBeTruthy();
  });

  it("nests documents by format then date, or date then format", async () => {
    const files: LibraryFile[] = [
      { id: "a", objectHash: "a", name: "Invoice.pdf", kind: "document", takenAt: "2025-08-20T10:00:00", place: null, inbox: false },
      { id: "b", objectHash: "b", name: "Budget.xlsx", kind: "document", takenAt: "2025-08-05T10:00:00", place: null, inbox: false },
      { id: "c", objectHash: "c", name: "Report.pdf", kind: "document", takenAt: "2026-01-05T10:00:00", place: null, inbox: false },
      { id: "d", objectHash: "d", name: "Notes.docx", kind: "document", takenAt: "2026-01-12T10:00:00", place: null, inbox: false },
    ];
    render(<MemoriesApp client={fakeClient([], 0, { files })} />);
    fireEvent.click(await screen.findByRole("button", { name: "Documents" }));
    expect(await screen.findByText(/by format, then date/)).toBeTruthy();
    const pdfs = screen.getByRole("region", { name: "PDFs" });
    expect(pdfs).toBeTruthy();
    expect(within(pdfs).getByRole("region", { name: "August 2025" })).toBeTruthy();
    expect(within(pdfs).getByRole("region", { name: "January 2026" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "Spreadsheets" })).toBeTruthy();

    fireEvent.click(screen.getByRole("radio", { name: "Date" }));
    expect(await screen.findByText(/by date, then format/)).toBeTruthy();
    const august = screen.getByRole("region", { name: "August 2025" });
    expect(within(august).getByRole("region", { name: "PDFs" })).toBeTruthy();
    expect(within(august).getByRole("region", { name: "Spreadsheets" })).toBeTruthy();
    expect(within(screen.getByRole("region", { name: "January 2026" })).getByRole("region", { name: "Word documents" })).toBeTruthy();
  });

  it("hides specialty shelves from the sidebar until those files exist", async () => {
    const files: LibraryFile[] = [
      { id: "a", objectHash: "a", name: "Beach.jpg", kind: "photo", takenAt: "2025-08-12T10:00:00", place: null, inbox: false },
    ];
    render(<MemoriesApp client={fakeClient([], 0, { files })} />);
    expect(await screen.findByRole("button", { name: "Photos" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Videos" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Documents" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Music & audio" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Apps & installers" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Zip files" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Code" })).toBeNull();
  });

  it("expands Documents into formats so you can open all or one kind", async () => {
    const files: LibraryFile[] = [
      { id: "a", objectHash: "a", name: "Invoice.pdf", kind: "document", takenAt: "2025-08-20T10:00:00", place: null, inbox: false },
      { id: "b", objectHash: "b", name: "Budget.xlsx", kind: "document", takenAt: "2025-08-05T10:00:00", place: null, inbox: false },
      { id: "c", objectHash: "c", name: "Talk.pptx", kind: "document", takenAt: "2026-01-05T10:00:00", place: null, inbox: false },
    ];
    render(<MemoriesApp client={fakeClient([], 0, { files })} />);
    expect(screen.queryByRole("button", { name: "PDF" })).toBeNull();

    fireEvent.click(await screen.findByRole("button", { name: "Show document formats" }));
    expect(await screen.findByRole("button", { name: "PDF" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Spreadsheets" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "PowerPoint" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Word" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Documents" }));
    expect(await screen.findByRole("heading", { name: "Documents" })).toBeTruthy();
    expect(screen.getByText(/by format, then date/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "PDF" }));
    expect(await screen.findByRole("heading", { name: "PDFs" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Invoice\.pdf/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Budget\.xlsx/ })).toBeNull();
  });

  it("offers a plugged-in Android phone on Places", async () => {
    render(<MemoriesApp client={fakeClient(phoneVolume)} />);
    fireEvent.click(screen.getByRole("button", { name: "Places" }));
    expect(await screen.findByRole("button", { name: "Choose a folder on Pixel 6" })).toBeTruthy();
    expect(screen.getByText("Pixel 6 is plugged in")).toBeTruthy();
  });

  it("opens the phone storage so you can browse folders", async () => {
    await openPhoneCamera(fakeClient(phoneVolume));
    expect(await screen.findByRole("button", { name: /IMG_0001/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Add this folder" })).toBeTruthy();
  });

  it("shows a waiting polaroid while a big folder opens", async () => {
    render(<MemoriesApp client={fakeClient(phoneVolume, 400)} />);
    fireEvent.click(screen.getByRole("button", { name: "Places" }));
    fireEvent.click(await screen.findByRole("button", { name: "Choose a folder on Pixel 6" }));
    fireEvent.click(await screen.findByRole("button", { name: /DCIM/ }));
    expect(await screen.findByRole("status")).toBeTruthy();
    expect(screen.getByText("Opening DCIM")).toBeTruthy();
    expect(await screen.findByRole("button", { name: /Camera/ })).toBeTruthy();
  });

  it("previews a photo after adding Camera as a place", async () => {
    await openPhoneCamera(fakeClient(phoneVolume));
    await screen.findByRole("button", { name: /IMG_0001/ });
    fireEvent.click(screen.getByRole("button", { name: "Add this folder" }));
    expect(await screen.findByText("Added Pixel 6 · Camera")).toBeTruthy();
    fireEvent.click(await screen.findByRole("button", { name: /IMG_0001/ }));
    expect(await screen.findByRole("heading", { name: "IMG_0001.jpg" })).toBeTruthy();
    const preview = document.querySelector(".insp-preview img");
    expect(preview?.getAttribute("src")).toBe("/drives/drv_phone/media?path=IMG_0001.jpg");
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    expect(await screen.findByRole("img", { name: "IMG_0001.jpg" })).toBeTruthy();
  });

  it("asks before loading a large phone video over the cable", async () => {
    await openPhoneCamera(fakeClient(phoneVolume));
    await screen.findByRole("button", { name: /VID_0001/ });
    fireEvent.click(screen.getByRole("button", { name: "Add this folder" }));
    expect(await screen.findByText("Added Pixel 6 · Camera")).toBeTruthy();
    fireEvent.click(await screen.findByRole("button", { name: /VID_0001/ }));
    expect(await screen.findByRole("button", { name: "Preview" })).toBeTruthy();
    expect(document.querySelector(".insp-preview video")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    await waitFor(() => {
      expect(document.querySelector(".insp-preview video")?.getAttribute("src")).toContain("VID_0001.mp4");
    });
  });

  it("switches appearance from Settings", async () => {
    render(<MemoriesApp client={fakeClient()} />);
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    fireEvent.click(await screen.findByRole("radio", { name: "Dark" }));
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(localStorage.getItem("memories-theme")).toBe("dark");
    fireEvent.click(screen.getByRole("radio", { name: "Light" }));
    expect(document.documentElement.dataset.theme).toBe("light");
  });

  it("flips light and dark from the sidebar", async () => {
    render(<MemoriesApp client={fakeClient()} />);
    fireEvent.click(screen.getByRole("button", { name: "Switch to dark" }));
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(await screen.findByRole("button", { name: "Switch to light" })).toBeTruthy();
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
      await waitFor(() => {
        expect(document.documentElement.dataset.chrome).toBe("darwin");
      });
      expect(document.querySelector(".app.chrome-darwin")).toBeTruthy();
      expect((document.querySelector(".brand") as HTMLElement).style.paddingLeft).toBe("74px");
    } finally {
      window.history.pushState({}, "", "/");
    }
  });

  it("draws Windows caption buttons in the Memories header", async () => {
    const closed: string[] = [];
    window.memoriesChrome = {
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
    render(<MemoriesApp client={fakeClient()} />);
    await waitFor(() => {
      expect(document.documentElement.dataset.chrome).toBe("win32");
    });
    expect(screen.getByRole("button", { name: "Minimize" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Maximize" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(closed).toEqual(["close"]);
  });

  it("lets you open folders on a place and back up only the ones you tick", async () => {
    render(<MemoriesApp client={fakeClient([], 0, { drives: true })} />);
    fireEvent.click(screen.getByRole("button", { name: "Backup" }));
    fireEvent.click(await screen.findByRole("button", { name: "New backup" }));
    fireEvent.click(await screen.findByRole("button", { name: /^Pixel 6.*Plugged in/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Open DCIM" }));
    fireEvent.click(await screen.findByRole("button", { name: "Select Camera" }));
    expect(await screen.findByText("DCIM › Camera")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    fireEvent.click(await screen.findByRole("button", { name: /^Summer SSD.*Plugged in/ }));
    await waitFor(() => {
      expect((screen.getByRole("button", { name: "Save backup" }) as HTMLButtonElement).disabled).toBe(false);
    });
    fireEvent.click(screen.getByRole("button", { name: "Save backup" }));
    expect(await screen.findByRole("heading", { name: "Pixel 6 to Summer SSD" })).toBeTruthy();
    expect(screen.getByText("DCIM › Camera")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Back up now" })).toBeTruthy();
  });
});
