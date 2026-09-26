import type { MemoriesClient } from "@memories/client";
import type {
  BackupJob,
  DirEntry,
  Drive,
  DriveKind,
  EventCluster,
  FileDetail,
  FileKind,
  LibraryFile,
  VirtualFolder,
  VolumePresence,
} from "@memories/core";
import { useCallback, useEffect, useMemo, useState } from "react";
import { applyTheme, chromePlatform, readThemePref, saveThemePref, type ThemePref } from "./theme.js";

type Screen = "browse" | "events" | "inbox" | "drives" | "backup" | "settings";

const TOUR = [
  {
    title: "This is a file manager.",
    body: "For the disks you already own — this computer, an SSD, a USB stick, a phone. A drive is a folder you choose, not the whole disk.",
  },
  {
    title: "Those files show up here.",
    body: "Images, videos, and documents, by date. Photos and videos also as events, by day and place.",
  },
  {
    title: "A drive is a folder you choose.",
    body: "Photos on this Mac. Camera on the phone. A folder on an SSD. Plug in, unlock, pick the folder. Memories remembers what’s in it. The files stay put.",
  },
  {
    title: "Backup is a separate step.",
    body: "Open folders on a drive, check the ones to copy, then pick a disk. Plug both in, then Start. Originals stay where they are.",
  },
  {
    title: "Unplug later. The catalog stays.",
    body: "Memories still shows what you have, and which folder it lives in. Plug the drive back in when you want to open or copy a file.",
  },
];

const TOUR_THUMBS = [
  "https://images.unsplash.com/photo-1519741497674-611481863552?w=240&q=70",
  "https://images.unsplash.com/photo-1502082553048-f009c37129b9?w=240&q=70",
  "https://images.unsplash.com/photo-1464349095431-e9a21285b5f3?w=240&q=70",
  "https://images.unsplash.com/photo-1414235077428-338989a2e8c0?w=240&q=70",
  "https://images.unsplash.com/photo-1556912173-46c336c7fd55?w=240&q=70",
  "https://images.unsplash.com/photo-1507525428034-b723cf961d3e?w=240&q=70",
];

function TourScene({ step }: { step: number }) {
  if (step === 0) {
    return (
      <div className="scene scene-welcome" aria-hidden="true">
        {TOUR_THUMBS.slice(0, 3).map((src, i) => (
          <figure className="print" style={{ ["--i" as string]: i }} key={src}>
            <img alt="" width={160} height={120} src={src} />
          </figure>
        ))}
      </div>
    );
  }
  if (step === 1) {
    const groups = [
      { name: "Images", n: 4 },
      { name: "Videos", n: 2 },
      { name: "Documents", n: 2 },
      { name: "Events", n: 3 },
    ];
    return (
      <div className="scene scene-files" aria-hidden="true">
        {groups.map((group, gi) => (
          <div className="g" style={{ ["--g" as string]: gi }} key={group.name}>
            <strong>{group.name}</strong>
            <div className="tiles">
              {Array.from({ length: group.n }, (_, i) =>
                group.name === "Documents" ? (
                  <i className="doc" style={{ ["--i" as string]: i }} key={i}>
                    PDF
                  </i>
                ) : (
                  <img
                    alt=""
                    width={56}
                    height={56}
                    style={{ ["--i" as string]: i }}
                    src={TOUR_THUMBS[(gi + i) % TOUR_THUMBS.length]}
                    key={i}
                  />
                ),
              )}
            </div>
          </div>
        ))}
      </div>
    );
  }
  if (step === 2) {
    const drives = [
      { name: "This Mac · Photos", on: true, color: "#3B82F6" },
      { name: "Android · Camera", on: true, color: "#10B981" },
      { name: "Summer SSD", on: false, color: "#F59E0B" },
      { name: "Travel USB", on: false, color: "#8B5CF6" },
    ];
    return (
      <div className="scene scene-drives" aria-hidden="true">
        {drives.map((drive, i) => (
          <div className={`drv${drive.on ? " live" : " wait"}`} style={{ ["--i" as string]: i }} key={drive.name}>
            <span className="dot" style={{ background: drive.color }} />
            <strong>{drive.name}</strong>
            <em className="st-off">Not connected</em>
            <em className="st-on">Connected</em>
          </div>
        ))}
      </div>
    );
  }
  if (step === 3) {
    return (
      <div className="scene scene-copy" aria-hidden="true">
        <div className="card">
          <img alt="" width={280} height={180} src={TOUR_THUMBS[0]} />
        <div className="meta">
          <b>First dance.jpg</b>
          <span>Wedding · 12 Aug 2025</span>
        </div>
        <div className="chips">
          <span className="c c1">Camera</span>
          <span className="c c2">Summer SSD</span>
          <span className="c c3">Copying 62%</span>
        </div>
        </div>
      </div>
    );
  }
  return (
    <div className="scene scene-cloud" aria-hidden="true">
      <div className="card">
        <img alt="" width={280} height={180} src={TOUR_THUMBS[0]} />
        <div className="meta">
          <b>First dance.jpg</b>
          <span>Same file. Still here after you unplug.</span>
        </div>
        <div className="chips">
          <span className="c">This Mac · Photos</span>
          <span className="c">Summer SSD</span>
          <span className="c optional">USB · when plugged in</span>
        </div>
      </div>
    </div>
  );
}

const KIND_LABEL: Record<FileKind, string> = {
  photo: "Images",
  video: "Videos",
  document: "Documents",
};

function monthLabel(iso: string | null) {
  if (!iso) return "Unknown date";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso.slice(0, 7);
  return date.toLocaleString("en-GB", { month: "long", year: "numeric" });
}

function dayLabel(day: string) {
  const date = new Date(`${day}T00:00:00`);
  return date.toLocaleString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

function formatSize(bytes: number | undefined) {
  if (!bytes) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function isPhoneVolume(volume: VolumePresence) {
  return volume.mountPath.startsWith("adb://") || volume.mountPath.startsWith("mtp://");
}

function folderLabel(drive: Drive, path: string) {
  const parts = path.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? drive.name;
}

function pathLeaf(path: string) {
  const parts = path.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

function backupFolderCovered(selected: string[], path: string) {
  return selected.some((folder) => folder === "" || path === folder || path.startsWith(`${folder}/`));
}

function toggleBackupFolder(selected: string[], path: string) {
  if (selected.includes(path)) return selected.filter((item) => item !== path);
  return [
    ...selected.filter((item) => {
      if (path === "") return false;
      if (item === "") return false;
      if (item.startsWith(`${path}/`)) return false;
      if (path.startsWith(`${item}/`)) return false;
      return true;
    }),
    path,
  ];
}

function backupPathLabel(path: string, driveName: string) {
  return path ? path.split("/").filter(Boolean).join(" / ") : driveName;
}

function joinMount(mountPath: string, relativePath: string) {
  if (!relativePath) return mountPath;
  return `${mountPath.replace(/\/$/, "")}/${relativePath}`;
}

function phoneFolderLabel(rootPath: string) {
  const folder = rootPath.replace(/^mtp:\/\/[^/]+\/?/, "").replace(/^adb:\/\/[^/]+\/?/, "");
  return folder || "Android phone";
}

function fileExt(name: string) {
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : "";
}

function previewKind(name: string, kind: FileKind | null): "image" | "video" | "audio" | "pdf" | "text" | "file" {
  const ext = fileExt(name);
  if (kind === "photo" || ["jpg", "jpeg", "png", "gif", "webp", "heic", "heif"].includes(ext)) return "image";
  if (kind === "video" || ["mp4", "mov", "m4v", "webm"].includes(ext)) return "video";
  if (["mp3", "m4a", "wav", "aac", "ogg"].includes(ext)) return "audio";
  if (ext === "pdf") return "pdf";
  if (["txt", "md", "json", "csv"].includes(ext)) return "text";
  return "file";
}

function needsPhoneConfirm(drive: Drive, entry: DirEntry) {
  if (drive.kind !== "phone") return false;
  if (entry.kind === "video") return true;
  if (entry.size > 20 * 1024 * 1024) return true;
  return false;
}

function FilePreview({
  name,
  kind,
  src,
  fit,
}: {
  name: string;
  kind: FileKind | null;
  src: string | null;
  fit: "inspector" | "viewer";
}) {
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    setFailed(false);
  }, [src]);
  const mode = previewKind(name, kind);
  const label = mode === "pdf" ? "PDF" : (kind ?? "file").toUpperCase();
  if (!src) {
    return <div className="doc-preview">{label}</div>;
  }
  if (mode === "image") {
    return (
      <>
        <img src={src} alt={fit === "viewer" ? name : ""} onError={() => setFailed(true)} />
        {failed ? <div className="doc-preview">Can’t preview</div> : null}
      </>
    );
  }
  if (failed) {
    return <div className="doc-preview">Can’t preview</div>;
  }
  if (mode === "video") {
    return <video src={src} controls playsInline onError={() => setFailed(true)} />;
  }
  if (mode === "audio") {
    return (
      <div className="doc-preview">
        <audio src={src} controls onError={() => setFailed(true)} />
      </div>
    );
  }
  if (mode === "pdf" || mode === "text") {
    return <iframe title={name} src={src} />;
  }
  return <div className="doc-preview">{label}</div>;
}

const WAIT_READ = [
  "Waiting on the phone…",
  "Listing names over USB…",
  "This folder is large. Still reading.",
  "You can go back. We’ll keep the light on.",
];
const WAIT_INDEX = [
  "Files stay on this drive. Memories just remembers them.",
  "Hashing over USB takes a while.",
  "Big folders are a slow river.",
  "Leave this screen if you like. This continues.",
];

function FolderWait({ name, mode }: { name: string; mode: "read" | "index" }) {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => setTick((n) => n + 1), 4200);
    return () => window.clearInterval(id);
  }, []);
  const lines = mode === "index" ? WAIT_INDEX : WAIT_READ;
  const line = lines[Math.min(tick, lines.length - 1)]!;
  const egg = tick >= 3;
  return (
    <div
      className={`folder-wait${mode === "index" ? " overlay" : ""}`}
      role="status"
      aria-live="polite"
      aria-busy="true"
      data-testid="folder-wait"
    >
      <div className={`polaroids${egg ? " egg" : ""}`} aria-hidden="true">
        <div className="polaroid back" />
        <div className="polaroid mid" />
        <div className="polaroid front">
          <div className="develop">
            <svg viewBox="0 0 80 58" fill="none">
              <rect width="80" height="58" fill="#8fa4bc" />
              <circle cx="58" cy="16" r="8" fill="#f4e4b2" />
              <path d="M0 40l18-12 14 10 16-18 32 22v16H0z" fill="#5d6f82" />
              <path d="M0 48l22-8 12 6 20-14 26 12v14H0z" fill="#3f4d5c" />
            </svg>
          </div>
          {egg ? <span className="polaroid-note">still in the tray</span> : null}
        </div>
      </div>
      <div className="folder-wait-copy">
        <h2>{mode === "index" ? `Using ${name}` : `Reading ${name}`}</h2>
        <p>{line}</p>
      </div>
    </div>
  );
}

function icon(name: string) {
  const d: Record<string, string> = {
    photo: "M4 7h3l2-2h6l2 2h3v10H4z M12 16a3 3 0 1 0 0-6 3 3 0 0 0 0 6z",
    video: "M4 6h10v12H4z M14 10l6-3v10l-6-3z",
    doc: "M7 4h7l5 5v11H7z M14 4v5h5",
    folder: "M3 7h6l2 2h10v10H3z",
    events: "M5 5h14v14H5z M5 9h14 M9 5v4",
    inbox: "M4 6h16v12H4z M4 10h16",
    drive: "M4 8h16v10H4z M8 18v2 M16 18v2",
    user: "M12 12a4 4 0 1 0-4-4 4 4 0 0 0 4 4z M4 20a8 8 0 0 1 16 0",
  };
  return (
    <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d={d[name] || d.drive} />
    </svg>
  );
}

function WindowControls() {
  const chrome = window.memoriesChrome;
  const [maximized, setMaximized] = useState(false);
  useEffect(() => {
    if (!chrome?.isMaximized || !chrome.onMaximized) return;
    void chrome.isMaximized().then(setMaximized);
    return chrome.onMaximized(setMaximized);
  }, [chrome]);
  if (chromePlatform() !== "win32") return null;
  return (
    <div className="win-controls">
      <button type="button" aria-label="Minimize" onClick={() => chrome.minimize?.()}>
        <svg viewBox="0 0 10 10" aria-hidden="true">
          <path d="M1 5h8" />
        </svg>
      </button>
      <button
        type="button"
        aria-label={maximized ? "Restore" : "Maximize"}
        onClick={() => chrome.toggleMaximize?.()}
      >
        {maximized ? (
          <svg viewBox="0 0 10 10" aria-hidden="true">
            <path d="M3 3.5h5.5V9H3z M1.5 1h5.5v1.5" />
          </svg>
        ) : (
          <svg viewBox="0 0 10 10" aria-hidden="true">
            <rect x="1.5" y="1.5" width="7" height="7" />
          </svg>
        )}
      </button>
      <button type="button" className="win-close" aria-label="Close" onClick={() => chrome.close?.()}>
        <svg viewBox="0 0 10 10" aria-hidden="true">
          <path d="M2 2l6 6M8 2l-6 6" />
        </svg>
      </button>
    </div>
  );
}

export function MemoriesApp({ client }: { client: MemoriesClient }) {
  const [onboarded, setOnboarded] = useState(() => localStorage.getItem("memories-tour") === "1");
  const [step, setStep] = useState(0);
  const [screen, setScreen] = useState<Screen>("browse");
  const [typeFilter, setTypeFilter] = useState<FileKind>("photo");
  const [drives, setDrives] = useState<Drive[]>([]);
  const [volumes, setVolumes] = useState<VolumePresence[]>([]);
  const [files, setFiles] = useState<LibraryFile[]>([]);
  const [events, setEvents] = useState<EventCluster[]>([]);
  const [jobs, setJobs] = useState<BackupJob[]>([]);
  const [folders, setFolders] = useState<VirtualFolder[]>([]);
  const [inboxCount, setInboxCount] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<FileDetail | null>(null);
  const [viewer, setViewer] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [modal, setModal] = useState<"register" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [regName, setRegName] = useState("This computer");
  const [regKind, setRegKind] = useState<DriveKind>("computer");
  const [regPath, setRegPath] = useState("");
  const [bkSetup, setBkSetup] = useState(false);
  const [bkStep, setBkStep] = useState(0);
  const [bkSource, setBkSource] = useState("");
  const [bkDest, setBkDest] = useState("");
  const [bkFolders, setBkFolders] = useState<string[]>([]);
  const [bkPath, setBkPath] = useState("");
  const [bkEntries, setBkEntries] = useState<DirEntry[]>([]);
  const [bkBusy, setBkBusy] = useState(false);
  const [bkError, setBkError] = useState<string | null>(null);
  const [drawer, setDrawer] = useState(false);
  const [browseDrive, setBrowseDrive] = useState<Drive | null>(null);
  const [browsePath, setBrowsePath] = useState("");
  const [browseEntries, setBrowseEntries] = useState<DirEntry[]>([]);
  const [browseBusy, setBrowseBusy] = useState(false);
  const [browseWait, setBrowseWait] = useState<"read" | "index" | null>(null);
  const [browseError, setBrowseError] = useState<string | null>(null);
  const [browseFile, setBrowseFile] = useState<DirEntry | null>(null);
  const [browseViewer, setBrowseViewer] = useState(false);
  const [browseLoad, setBrowseLoad] = useState(false);
  const [pickerVolume, setPickerVolume] = useState<VolumePresence | null>(null);
  const [themePref, setThemePref] = useState<ThemePref>(readThemePref);
  const windowChrome = chromePlatform();

  useEffect(() => {
    applyTheme(themePref);
    if (themePref !== "system") return;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => applyTheme("system");
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, [themePref]);

  const show = useCallback((message: string) => {
    setToast(message);
    window.setTimeout(() => setToast((current) => (current === message ? null : current)), 2200);
  }, []);

  const refresh = useCallback(async () => {
    try {
      const [nextDrives, nextVolumes, nextFiles, nextEvents, nextJobs, nextFolders, inboxFiles] = await Promise.all([
        client.drives(),
        client.volumes(),
        client.files(screen === "inbox" ? { inbox: true } : screen === "browse" ? { kind: typeFilter } : {}),
        client.events(),
        client.backups(),
        client.folders(),
        client.files({ inbox: true }),
      ]);
      setDrives(nextDrives);
      setVolumes(nextVolumes);
      setFiles(nextFiles);
      setEvents(nextEvents);
      setJobs(nextJobs);
      setFolders(nextFolders);
      setInboxCount(inboxFiles.length);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not reach Memories");
    }
  }, [client, screen, typeFilter]);

  useEffect(() => {
    if (!onboarded) return;
    let cancelled = false;
    void (async () => {
      try {
        const [nextDrives, nextVolumes, nextFiles, nextEvents, nextJobs, nextFolders, inboxFiles] = await Promise.all([
          client.drives(),
          client.volumes(),
          client.files(screen === "inbox" ? { inbox: true } : screen === "browse" ? { kind: typeFilter } : {}),
          client.events(),
          client.backups(),
          client.folders(),
          client.files({ inbox: true }),
        ]);
        if (cancelled) return;
        setDrives(nextDrives);
        setVolumes(nextVolumes);
        setFiles(nextFiles);
        setEvents(nextEvents);
        setJobs(nextJobs);
        setFolders(nextFolders);
        setInboxCount(inboxFiles.length);
        setError(null);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Could not reach Memories");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [onboarded, client, screen, typeFilter]);

  useEffect(() => {
    if (!selected) {
      setDetail(null);
      return;
    }
    void client.file(selected).then(setDetail).catch(() => setDetail(null));
  }, [client, selected, files]);

  const phones = useMemo(() => volumes.filter(isPhoneVolume), [volumes]);
  const uniqueDrives = useMemo(() => {
    const seen = new Set<string>();
    return drives.filter((drive) => {
      const key = `${drive.volumeId}::${drive.rootPath}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }, [drives]);

  useEffect(() => {
    if (screen !== "drives") {
      setBrowseDrive(null);
      setPickerVolume(null);
      setBrowsePath("");
      setBrowseEntries([]);
      setBrowseError(null);
      setBrowseBusy(false);
      setBrowseWait(null);
    }
    if (screen !== "backup") setBkSetup(false);
  }, [screen]);

  useEffect(() => {
    if (!onboarded || (screen !== "drives" && screen !== "backup") || browseDrive) return;
    const timer = window.setInterval(() => void refresh(), 4000);
    return () => window.clearInterval(timer);
  }, [onboarded, screen, refresh, browseDrive]);

  useEffect(() => {
    const close = () => {
      if (window.innerWidth >= 960) setDrawer(false);
    };
    window.addEventListener("resize", close);
    return () => window.removeEventListener("resize", close);
  }, []);

  const grouped = useMemo(() => {
    const map = new Map<string, LibraryFile[]>();
    for (const file of files) {
      const key = monthLabel(file.takenAt);
      const list = map.get(key) ?? [];
      list.push(file);
      map.set(key, list);
    }
    return [...map.entries()];
  }, [files]);

  const finishTour = () => {
    localStorage.setItem("memories-tour", "1");
    setOnboarded(true);
  };

  async function onRegister() {
    try {
      const drive = await client.registerDrive({ name: regName, kind: regKind, rootPath: regPath });
      await client.ingest(drive.id);
      setModal(null);
      show(`${drive.name} is a drive`);
      await refresh();
    } catch (err) {
      show(err instanceof Error ? err.message : "Could not register drive");
    }
  }

  async function openPicker(volume: VolumePresence) {
    setModal(null);
    setPickerVolume(volume);
    setBrowseDrive(null);
    setBrowseFile(null);
    setBrowseViewer(false);
    setScreen("drives");
    await loadPicker(volume, "");
  }

  async function onUseFolder() {
    if (!pickerVolume) return;
    const rootPath = joinMount(pickerVolume.mountPath, browsePath);
    const name = browsePath ? `${pickerVolume.label} · ${pathLeaf(browsePath)}` : pickerVolume.label;
    setBrowseBusy(true);
    setBrowseWait("index");
    try {
      const drive = await client.registerDrive({
        name,
        kind: "phone",
        rootPath,
        volumeId: pickerVolume.volumeId,
      });
      await client.ingest(drive.id);
      setPickerVolume(null);
      show(`${drive.name} is a drive`);
      await refresh();
      await openBrowse(drive);
    } catch (err) {
      show(err instanceof Error ? err.message : "Could not use this folder");
    } finally {
      setBrowseBusy(false);
      setBrowseWait(null);
    }
  }

  async function openBrowse(drive: Drive) {
    if (!drive.online) {
      show("Connect the drive to browse it");
      return;
    }
    setPickerVolume(null);
    setBrowseDrive(drive);
    setBrowseFile(null);
    setBrowseViewer(false);
    await loadBrowse(drive.id, "");
  }

  async function loadPicker(volume: VolumePresence, relativePath: string) {
    setBrowseBusy(true);
    setBrowseWait("read");
    setBrowsePath(relativePath);
    setBrowseError(null);
    setBrowseEntries([]);
    setBrowseFile(null);
    setBrowseViewer(false);
    setBrowseLoad(false);
    try {
      setBrowseEntries(await client.volumeEntries(volume.mountPath, relativePath));
    } catch (err) {
      const message = err instanceof Error ? err.message : "Could not list folder";
      setBrowseError(message);
      show(message);
      setBrowseEntries([]);
    } finally {
      setBrowseBusy(false);
      setBrowseWait(null);
    }
  }

  async function loadBrowse(driveId: string, relativePath: string) {
    setBrowseBusy(true);
    setBrowseWait("read");
    setBrowsePath(relativePath);
    setBrowseError(null);
    setBrowseEntries([]);
    setBrowseFile(null);
    setBrowseViewer(false);
    setBrowseLoad(false);
    try {
      setBrowseEntries(await client.driveEntries(driveId, relativePath));
    } catch (err) {
      const message = err instanceof Error ? err.message : "Could not list folder";
      setBrowseError(message);
      show(message);
      setBrowseEntries([]);
    } finally {
      setBrowseBusy(false);
      setBrowseWait(null);
    }
  }

  function pickBrowseFile(entry: DirEntry) {
    if (!browseDrive) return;
    setBrowseFile(entry);
    setBrowseViewer(false);
    setBrowseLoad(!needsPhoneConfirm(browseDrive, entry));
  }

  function openBrowseFile(entry: DirEntry) {
    if (!browseDrive) return;
    setBrowseFile(entry);
    setBrowseLoad(true);
    setBrowseViewer(true);
  }

  async function onPickFolder() {
    try {
      const picked = await client.pickFolder();
      if (picked) setRegPath(picked);
    } catch {
      const typed = window.prompt("Folder to register as a drive", regPath);
      if (typed) setRegPath(typed);
    }
  }

  async function loadBkFolders(driveId: string, relativePath: string) {
    setBkBusy(true);
    setBkPath(relativePath);
    setBkError(null);
    setBkEntries([]);
    try {
      const entries = await client.driveEntries(driveId, relativePath);
      setBkEntries(entries.filter((entry) => entry.directory));
    } catch (err) {
      const message = err instanceof Error ? err.message : "Could not list folder";
      setBkError(message);
      show(message);
    } finally {
      setBkBusy(false);
    }
  }

  function startBackup(sourceId = "") {
    setBkSetup(true);
    setBkStep(sourceId ? 1 : 0);
    setBkSource(sourceId);
    setBkDest("");
    setBkFolders([]);
    setBkPath("");
    setBkEntries([]);
    setBkError(null);
    if (sourceId) void loadBkFolders(sourceId, "");
  }

  async function pickBkSource(drive: Drive) {
    if (!drive.online) {
      show("Connect the drive to list folders");
      return;
    }
    setBkSource(drive.id);
    setBkFolders([]);
    setBkDest("");
    setBkStep(1);
    await loadBkFolders(drive.id, "");
  }

  async function onSaveBackup() {
    try {
      await client.saveBackup({
        sourceDriveId: bkSource,
        destDriveId: bkDest,
        sourceRelativePaths: bkFolders,
      });
      setBkSetup(false);
      show("Backup saved");
      setScreen("backup");
      await refresh();
    } catch (err) {
      show(err instanceof Error ? err.message : "Could not save backup");
    }
  }

  async function onRunBackup(id: string) {
    try {
      const result = await client.runBackup(id);
      show(`Copied ${result.copied}, skipped ${result.skipped}`);
      await refresh();
    } catch (err) {
      show(err instanceof Error ? err.message : "Backup failed");
    }
  }

  async function onPlace() {
    if (!selected) return;
    await client.placeFile(selected);
    show("Placed");
    await refresh();
  }

  if (!onboarded) {
    const current = TOUR[step]!;
    const last = step === TOUR.length - 1;
    return (
      <div className={`app onboarding${windowChrome ? ` chrome-${windowChrome}` : ""}`}>
        <div className="tour" role="dialog" aria-modal="true" aria-labelledby="tour-title">
          <div className="tour-stage">
            <TourScene key={step} step={step} />
          </div>
          <div className="tour-panel">
            <p className="tour-brand">Memories</p>
            <h1 id="tour-title">{current.title}</h1>
            <p>{current.body}</p>
            <div className="tour-actions">
              {step > 0 ? (
                <button className="btn btn-ghost" onClick={() => setStep((s) => s - 1)}>
                  Back
                </button>
              ) : null}
              <button className="btn btn-primary" onClick={() => (last ? finishTour() : setStep((s) => s + 1))}>
                {last ? "Open Images" : "Continue"}
              </button>
            </div>
            <button className="tour-skip" onClick={finishTour}>
              Skip welcome
            </button>
            <div className="tour-bar" aria-hidden="true">
              <i style={{ width: `${((step + 1) / TOUR.length) * 100}%` }} />
            </div>
          </div>
        </div>
        <WindowControls />
      </div>
    );
  }

  const showInspector = screen === "browse" || screen === "events" || screen === "inbox" || (screen === "drives" && !!browseDrive);

  const go = (fn: () => void) => {
    fn();
    setDrawer(false);
  };

  const renderSidebar = () => (
    <>
      <div className="brand" style={windowChrome === "darwin" ? { paddingLeft: 74 } : undefined}>
        Memories
      </div>
      <div className="nav-label">Library</div>
      {(["photo", "video", "document"] as FileKind[]).map((kind) => (
        <button
          key={kind}
          className={`nav-item${screen === "browse" && typeFilter === kind ? " active" : ""}`}
          onClick={() =>
            go(() => {
              setScreen("browse");
              setTypeFilter(kind);
            })
          }
        >
          {icon(kind === "document" ? "doc" : kind)} {KIND_LABEL[kind]}
        </button>
      ))}
      <button className={`nav-item${screen === "events" ? " active" : ""}`} onClick={() => go(() => setScreen("events"))}>
        {icon("events")} Events
      </button>
      <button className={`nav-item${screen === "inbox" ? " active" : ""}`} onClick={() => go(() => setScreen("inbox"))}>
        {icon("inbox")} Inbox
        {inboxCount ? <span className="badge">{inboxCount}</span> : null}
      </button>
      <div className="nav-label">Your folders</div>
      {folders.length ? (
        folders.map((folder) => (
          <button key={folder.id} className="nav-item">
            {icon("doc")} {folder.name}
          </button>
        ))
      ) : (
        <p className="nav-empty">Optional. Create one, then Move to… Bytes stay put.</p>
      )}
      <div className="nav-label">Locations</div>
      {uniqueDrives.map((drive) => (
        <button key={drive.id} className="nav-item" onClick={() => go(() => setScreen("drives"))}>
          <span className={`dot${drive.online ? "" : " off"}`} style={{ background: "#0071E3" }} />
          {drive.name}
        </button>
      ))}
      <button className={`nav-item${screen === "drives" ? " active" : ""}`} onClick={() => go(() => setScreen("drives"))}>
        {icon("drive")} Manage drives
      </button>
      <button className={`nav-item${screen === "backup" ? " active" : ""}`} onClick={() => go(() => setScreen("backup"))}>
        {icon("drive")} Backup
      </button>
      <button
        className={`nav-item${screen === "settings" ? " active" : ""}`}
        onClick={() => go(() => setScreen("settings"))}
      >
        {icon("user")} Settings
      </button>
    </>
  );

  return (
    <div className={`app${showInspector ? "" : " no-inspector"}${windowChrome ? ` chrome-${windowChrome}` : ""}`}>
      <aside className="sidebar">{renderSidebar()}</aside>

      <header className="topbar">
        <button
          className="menu-btn"
          aria-label="Browse menu"
          aria-expanded={drawer}
          title="Browse"
          onClick={() => setDrawer((open) => !open)}
        >
          <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
            <path d="M3 5h12M3 9h12M3 13h12" />
          </svg>
        </button>
        <div className="path">
          {screen === "drives" && (browseDrive || pickerVolume) ? (
            <>
              <button
                type="button"
                onClick={() => {
                  setBrowseDrive(null);
                  setPickerVolume(null);
                }}
              >
                Drives
              </button>
              <span className="sep">/</span>
              <button
                type="button"
                className={!browsePath ? "cur" : ""}
                onClick={() =>
                  pickerVolume ? void loadPicker(pickerVolume, "") : browseDrive && void loadBrowse(browseDrive.id, "")
                }
              >
                {pickerVolume ? pickerVolume.label : browseDrive?.name}
              </button>
              {browsePath
                .split("/")
                .filter(Boolean)
                .map((part, index, parts) => {
                  const relativePath = parts.slice(0, index + 1).join("/");
                  return (
                    <span key={relativePath} style={{ display: "contents" }}>
                      <span className="sep">/</span>
                      <button
                        type="button"
                        className={index === parts.length - 1 ? "cur" : ""}
                        onClick={() =>
                          pickerVolume
                            ? void loadPicker(pickerVolume, relativePath)
                            : browseDrive && void loadBrowse(browseDrive.id, relativePath)
                        }
                      >
                        {part}
                      </button>
                    </span>
                  );
                })}
            </>
          ) : (
            <button className="cur">
              {screen === "browse"
                ? KIND_LABEL[typeFilter]
                : screen === "backup" && bkSetup
                  ? "New backup"
                  : screen[0]!.toUpperCase() + screen.slice(1)}
            </button>
          )}
        </div>
      </header>

      <main className="main">
        {error ? (
          <div className="empty">
            <h2>Waiting for the local app</h2>
            <p>{error}</p>
          </div>
        ) : screen === "browse" || screen === "inbox" ? (
          files.length ? (
            <div className="fm">
              <div className="colhead">
                <span />
                <button>Name</button>
                <span className="hide-sm">Date</span>
                <span className="hide-sm">Kind</span>
                <span className="hide-sm">Size</span>
                <span className="hide-sm">Where</span>
              </div>
              {grouped.map(([month, rows]) => (
                <section key={month}>
                  <div className="group-head">
                    <span>{month}</span>
                    <span>{rows.length}</span>
                  </div>
                  {rows.map((file) => (
                    <button
                      key={file.id}
                      className={`fm-row${selected === file.id ? " selected" : ""}`}
                      onClick={() => setSelected(file.id)}
                      onDoubleClick={() => setViewer(file.id)}
                    >
                      <span />
                      <div className="name">
                        {file.kind === "photo" ? (
                          <img className="fm-ico" src={client.mediaUrl(file.id)} alt="" />
                        ) : (
                          <div className={`fm-ico ${file.kind === "video" ? "vid" : "doc"}`}>
                            {file.kind === "video" ? "VID" : "DOC"}
                          </div>
                        )}
                        <span>{file.name}</span>
                      </div>
                      <span className="dt hide-sm">{file.takenAt ? file.takenAt.slice(0, 10) : "—"}</span>
                      <span className="kind hide-sm">{file.kind}</span>
                      <span className="sz hide-sm">—</span>
                      <span className="where hide-sm">{file.inbox ? "Inbox" : "Placed"}</span>
                    </button>
                  ))}
                </section>
              ))}
            </div>
          ) : (
            <div className="empty">
              <h2>{screen === "inbox" ? "Inbox is empty" : `No ${KIND_LABEL[typeFilter].toLowerCase()} yet`}</h2>
              <p>Register a folder as a drive. Those files will show up here.</p>
            </div>
          )
        ) : screen === "events" ? (
          events.length ? (
            <div className="events">
              {events.map((cluster) => (
                <article className="event" key={`${cluster.day}-${cluster.place}`}>
                  <div className="event-head">
                    <h2>
                      {dayLabel(cluster.day)}
                      {cluster.place ? ` · ${cluster.place}` : ""}
                    </h2>
                    <span>{cluster.fileIds.length}</span>
                  </div>
                  <div className="event-grid">
                    {cluster.fileIds.map((id) => (
                      <button
                        key={id}
                        className={`event-tile${selected === id ? " selected" : ""}`}
                        onClick={() => setSelected(id)}
                        onDoubleClick={() => setViewer(id)}
                      >
                        <img className="event-img" src={client.mediaUrl(id)} alt="" />
                      </button>
                    ))}
                  </div>
                </article>
              ))}
            </div>
          ) : (
            <div className="empty">
              <h2>No events yet</h2>
              <p>Events appear when photos or videos have a date.</p>
            </div>
          )
        ) : screen === "drives" ? (
          <div className="pad">
            {browseDrive || pickerVolume ? (
              <>
                <div className="actionbar" style={{ border: 0, padding: "0 0 12px" }}>
                  <h1 style={{ flex: 1, margin: 0 }}>{pickerVolume ? pickerVolume.label : browseDrive?.name}</h1>
                  <button
                    className="btn btn-secondary"
                    onClick={() => {
                      setBrowseDrive(null);
                      setPickerVolume(null);
                      setBrowseFile(null);
                      setBrowseViewer(false);
                    }}
                  >
                    Drives
                  </button>
                  {pickerVolume ? (
                    <button className="btn btn-primary" disabled={browseBusy} onClick={() => void onUseFolder()}>
                      Use this folder
                    </button>
                  ) : null}
                </div>
                {pickerVolume && !browseBusy ? (
                  <p className="muted">
                    This folder becomes a Memories drive. Files stay on the phone. Backup is a separate step.
                  </p>
                ) : null}
                <div className="browse-body">
                  {browseBusy && browseWait === "read" ? (
                    <FolderWait
                      name={
                        pickerVolume
                          ? browsePath
                            ? pathLeaf(browsePath)
                            : pickerVolume.label
                          : folderLabel(browseDrive!, browsePath)
                      }
                      mode="read"
                    />
                  ) : (
                    <>
                      {browseEntries.map((entry) => (
                        <button
                          key={entry.relativePath}
                          className={`drive-row${browseFile?.relativePath === entry.relativePath ? " selected" : ""}`}
                          type="button"
                          disabled={browseBusy}
                          onClick={() => {
                            if (entry.directory) {
                              if (pickerVolume) {
                                void loadPicker(pickerVolume, entry.relativePath);
                                return;
                              }
                              if (browseDrive) void loadBrowse(browseDrive.id, entry.relativePath);
                              return;
                            }
                            pickBrowseFile(entry);
                          }}
                          onDoubleClick={() => {
                            if (!entry.directory) openBrowseFile(entry);
                          }}
                        >
                          {icon(entry.directory ? "folder" : entry.kind === "photo" ? "photo" : entry.kind === "video" ? "video" : "doc")}
                          <div style={{ flex: 1, textAlign: "left" }}>
                            <strong>{entry.name}</strong>
                            <div className="muted">
                              {entry.directory ? "Folder" : `${entry.kind ?? "File"} · ${formatSize(entry.size)}`}
                            </div>
                          </div>
                        </button>
                      ))}
                      {browseError ? (
                        <div className="empty">
                          <h2>Could not read this folder</h2>
                          <p>{browseError}</p>
                        </div>
                      ) : !browseBusy && !browseEntries.length ? (
                        <div className="empty">
                          <h2>Empty folder</h2>
                          <p>Nothing to show here.</p>
                        </div>
                      ) : null}
                    </>
                  )}
                  {browseBusy && browseWait === "index" ? (
                    <FolderWait
                      name={browsePath ? pathLeaf(browsePath) : pickerVolume?.label ?? folderLabel(browseDrive!, browsePath)}
                      mode="index"
                    />
                  ) : null}
                </div>
              </>
            ) : (
              <>
                <div className="actionbar" style={{ border: 0, padding: "0 0 12px" }}>
                  <h1 style={{ flex: 1, margin: 0 }}>Drives</h1>
                  <button className="btn btn-primary" onClick={() => setModal("register")}>
                    Register a drive
                  </button>
                </div>
                {phones.length ? (
                  <div className="phone-banner">
                    <p>
                      {phones.length === 1
                        ? `${phones[0]!.label} is plugged in.`
                        : `${phones.length} Android phones are plugged in.`}{" "}
                      Choose a folder to use as a drive. Backup is a separate step.
                    </p>
                    {phones.map((volume) => (
                      <button
                        key={volume.volumeId}
                        className="btn btn-primary"
                        onClick={() => void openPicker(volume)}
                      >
                        Choose a folder on {volume.label}
                      </button>
                    ))}
                  </div>
                ) : null}
                {uniqueDrives.map((drive) => (
                  <button key={drive.id} className="drive-row" onClick={() => void openBrowse(drive)}>
                    <span className={`dot${drive.online ? "" : " off"}`} style={{ background: "#0071E3" }} />
                    <div style={{ flex: 1, textAlign: "left" }}>
                      <strong>{drive.name}</strong>
                      <div className="muted">
                        {drive.online ? "Connected" : "Not connected"}
                        {drive.kind === "phone" ? ` · ${phoneFolderLabel(drive.rootPath)}` : ` · ${drive.rootPath}`}
                      </div>
                    </div>
                  </button>
                ))}
                {!drives.length && !phones.length ? (
                  <div className="empty">
                    <h2>No drives yet</h2>
                    <p>A drive is a folder you choose. Pick one on this computer, or a folder on a plugged-in phone.</p>
                  </div>
                ) : null}
              </>
            )}
          </div>
        ) : screen === "backup" ? (
          <div className="pad">
            {bkSetup ? (
              <>
                <div className="actionbar" style={{ border: 0, padding: "0 0 8px" }}>
                  <h1 style={{ flex: 1, margin: 0 }}>New backup</h1>
                </div>
                {(() => {
                  const source = uniqueDrives.find((drive) => drive.id === bkSource);
                  const canNext = bkStep === 0 ? !!bkSource : bkStep === 1 ? bkFolders.length > 0 : !!bkDest;
                  return (
                    <>
                      <div className="bk-steps">
                        {["Source", "Folders", "Drive"].map((label, index) => (
                          <span className={index === bkStep ? "on" : ""} key={label}>
                            {index + 1}. {label}
                          </span>
                        ))}
                      </div>
                      {bkStep === 0 ? (
                        <>
                          <p className="hello" style={{ marginBottom: 14 }}>
                            Pick the drive that has the folders you want to copy. You will choose folders next.
                          </p>
                          {uniqueDrives.map((drive) => (
                            <button
                              key={drive.id}
                              className={`pick${bkSource === drive.id ? " on" : ""}`}
                              type="button"
                              onClick={() => void pickBkSource(drive)}
                            >
                              <span className={`dot${drive.online ? "" : " off"}`} style={{ background: "#0071E3" }} />
                              <div>
                                <strong>{drive.name}</strong>
                                <div className="muted">
                                  {drive.online ? "Connected — tap to use" : "Not connected — plug in to list folders"}
                                </div>
                              </div>
                            </button>
                          ))}
                          {!uniqueDrives.length ? (
                            <div className="empty" style={{ padding: "24px 8px" }}>
                              <h2>No drives yet</h2>
                              <p>Register a folder as a drive first. Backup copies from that folder onto another drive.</p>
                            </div>
                          ) : null}
                        </>
                      ) : bkStep === 1 && source ? (
                        <>
                          <p className="hello" style={{ marginBottom: 10 }}>
                            Folders on {source.name}. Open a folder to look inside. Check the ones to copy. Only these
                            copy when you start backup.
                          </p>
                          <nav className="path" style={{ flex: "none", height: "auto", marginBottom: 10 }}>
                            <button
                              type="button"
                              className={!bkPath ? "cur" : ""}
                              onClick={() => void loadBkFolders(source.id, "")}
                            >
                              {source.name}
                            </button>
                            {bkPath
                              .split("/")
                              .filter(Boolean)
                              .map((part, index, parts) => {
                                const relativePath = parts.slice(0, index + 1).join("/");
                                return (
                                  <span key={relativePath} style={{ display: "contents" }}>
                                    <span className="sep">/</span>
                                    <button
                                      type="button"
                                      className={index === parts.length - 1 ? "cur" : ""}
                                      onClick={() => void loadBkFolders(source.id, relativePath)}
                                    >
                                      {part}
                                    </button>
                                  </span>
                                );
                              })}
                          </nav>
                          {bkBusy ? (
                            <FolderWait name={bkPath ? pathLeaf(bkPath) : source.name} mode="read" />
                          ) : (
                            <>
                              <div className={`check-row${backupFolderCovered(bkFolders, bkPath) ? " on" : ""}`}>
                                <button
                                  type="button"
                                  className="box"
                                  aria-pressed={backupFolderCovered(bkFolders, bkPath)}
                                  aria-label={`Select ${bkPath ? pathLeaf(bkPath) : source.name}`}
                                  onClick={() => setBkFolders((current) => toggleBackupFolder(current, bkPath))}
                                >
                                  {backupFolderCovered(bkFolders, bkPath) ? "✓" : ""}
                                </button>
                                <div>
                                  <strong>This folder</strong>
                                  <div className="muted">
                                    {backupPathLabel(bkPath, source.name)} — everything in it
                                  </div>
                                </div>
                              </div>
                              {bkEntries.map((entry) => {
                                const on = backupFolderCovered(bkFolders, entry.relativePath);
                                return (
                                  <div className={`check-row${on ? " on" : ""}`} key={entry.relativePath}>
                                    <button
                                      type="button"
                                      className="box"
                                      aria-pressed={on}
                                      aria-label={`Select ${entry.name}`}
                                      onClick={() =>
                                        setBkFolders((current) => toggleBackupFolder(current, entry.relativePath))
                                      }
                                    >
                                      {on ? "✓" : ""}
                                    </button>
                                    <div style={{ flex: 1, minWidth: 0, textAlign: "left" }}>
                                      <strong>{entry.name}</strong>
                                      <div className="muted">
                                        {on && !bkFolders.includes(entry.relativePath)
                                          ? "Included with a folder above"
                                          : "Folder"}
                                      </div>
                                    </div>
                                    <button
                                      type="button"
                                      className="open"
                                      aria-label={`Open ${entry.name}`}
                                      onClick={() => void loadBkFolders(source.id, entry.relativePath)}
                                    >
                                      Open
                                    </button>
                                  </div>
                                );
                              })}
                              {bkError ? (
                                <div className="empty">
                                  <h2>Could not read this folder</h2>
                                  <p>{bkError}</p>
                                </div>
                              ) : !bkEntries.length ? (
                                <p className="muted">No folders inside. Select this folder to copy it.</p>
                              ) : null}
                            </>
                          )}
                          {bkFolders.length ? (
                            <div className="bk-picks">
                              {bkFolders.map((path) => (
                                <span key={path || source.name}>{backupPathLabel(path, source.name)}</span>
                              ))}
                            </div>
                          ) : null}
                        </>
                      ) : (
                        <>
                          <p className="hello" style={{ marginBottom: 14 }}>
                            Where should copies land? Originals stay on {source?.name || "the source"}.
                          </p>
                          {uniqueDrives
                            .filter((drive) => drive.id !== bkSource)
                            .map((drive) => (
                              <button
                                key={drive.id}
                                className={`pick${bkDest === drive.id ? " on" : ""}`}
                                type="button"
                                onClick={() => setBkDest(drive.id)}
                              >
                                <span className={`dot${drive.online ? "" : " off"}`} style={{ background: "#0071E3" }} />
                                <div>
                                  <strong>{drive.name}</strong>
                                  <div className="muted">
                                    {drive.online ? "Connected" : "Offline — we’ll wait until you plug it in"}
                                  </div>
                                </div>
                              </button>
                            ))}
                        </>
                      )}
                      <div className="bk-wizard-nav">
                        <button className="btn btn-secondary" type="button" onClick={() => setBkSetup(false)}>
                          Cancel
                        </button>
                        {bkStep > 0 ? (
                          <button
                            className="btn btn-secondary"
                            type="button"
                            onClick={() => setBkStep((step) => (step > 0 ? step - 1 : 0))}
                          >
                            Back
                          </button>
                        ) : null}
                        {bkStep < 2 ? (
                          <button
                            className="btn btn-primary"
                            type="button"
                            disabled={!canNext}
                            onClick={() => setBkStep((step) => (step < 2 ? step + 1 : step))}
                          >
                            Continue
                          </button>
                        ) : (
                          <button
                            className="btn btn-primary"
                            type="button"
                            disabled={!canNext}
                            onClick={() => void onSaveBackup()}
                          >
                            Save backup
                          </button>
                        )}
                      </div>
                    </>
                  );
                })()}
              </>
            ) : (
              <>
                <div className="actionbar" style={{ border: 0, padding: "0 0 12px" }}>
                  <h1 style={{ flex: 1, margin: 0 }}>Backup</h1>
                  <button className="btn btn-primary" onClick={() => startBackup()}>
                    New backup
                  </button>
                </div>
                <p className="hello" style={{ marginBottom: 14 }}>
                  Backup copies selected folders onto another drive. Plug both in, then Start. It is not how you add a
                  drive.
                </p>
                {jobs.map((job) => {
                  const source = drives.find((d) => d.id === job.sourceDriveId);
                  const dest = drives.find((d) => d.id === job.destDriveId);
                  const ready = source?.online && dest?.online;
                  const folders =
                    !job.sourceRelativePaths.length || job.sourceRelativePaths.every((path) => !path)
                      ? "This drive folder"
                      : job.sourceRelativePaths.map((path) => backupPathLabel(path, source?.name ?? "Drive")).join(", ");
                  return (
                    <div className="bk-card" key={job.id}>
                      <h3>
                        {source?.name ?? "Source"} → {dest?.name ?? "Destination"}
                      </h3>
                      <div className="bk-meta">
                        {folders}
                        {job.lastRunAt ? ` · Last run ${job.lastRunAt.slice(0, 16).replace("T", " ")}` : ""}
                      </div>
                      <div className="bk-actions">
                        <button className="btn btn-primary" disabled={!ready} onClick={() => void onRunBackup(job.id)}>
                          Start backup
                        </button>
                      </div>
                      {!ready ? <div className="bk-wait">Connect both drives to start.</div> : null}
                    </div>
                  );
                })}
                {!jobs.length ? (
                  <div className="empty">
                    <h2>No saved backup yet</h2>
                    <p>Pick folders on a drive, then a drive to copy onto. We keep that selection.</p>
                  </div>
                ) : null}
              </>
            )}
          </div>
        ) : (
          <div className="pad">
            <h1>Settings</h1>
            <h2>Appearance</h2>
            <div className="settings-row">
              <span>Theme</span>
              <select
                aria-label="Appearance"
                value={themePref}
                onChange={(event) => {
                  const next = event.target.value as ThemePref;
                  setThemePref(next);
                  saveThemePref(next);
                }}
              >
                <option value="system">Match system</option>
                <option value="light">Light</option>
                <option value="dark">Dark</option>
              </select>
            </div>
            <h2>Demo</h2>
            <button
              className="btn btn-secondary"
              onClick={() => {
                localStorage.removeItem("memories-tour");
                setOnboarded(false);
                setStep(0);
              }}
            >
              Replay welcome
            </button>
          </div>
        )}
      </main>

      {showInspector ? (
        <aside className="inspector">
          {screen === "drives" && browseDrive && browseFile ? (
            <>
              <div className="insp-preview">
                {browseLoad ? (
                  <FilePreview
                    name={browseFile.name}
                    kind={browseFile.kind}
                    src={client.driveMediaUrl(browseDrive.id, browseFile.relativePath)}
                    fit="inspector"
                  />
                ) : (
                  <div className="doc-preview">
                    <button className="btn btn-primary" type="button" onClick={() => setBrowseLoad(true)}>
                      Preview
                    </button>
                  </div>
                )}
              </div>
              <h3>{browseFile.name}</h3>
              <p className="muted">
                {browseFile.kind ?? "file"} · {formatSize(browseFile.size)}
              </p>
              <p className="muted">{browseFile.relativePath}</p>
              {!browseLoad ? (
                <p className="muted">Large phone files load over USB when you preview them.</p>
              ) : null}
              <button className="btn btn-primary" style={{ marginTop: 12 }} type="button" onClick={() => openBrowseFile(browseFile)}>
                Open
              </button>
            </>
          ) : detail ? (
            <>
              <div className="insp-preview">
                <FilePreview
                  name={detail.file.name}
                  kind={detail.file.kind}
                  src={client.mediaUrl(detail.file.id)}
                  fit="inspector"
                />
              </div>
              <h3>{detail.file.name}</h3>
              <p className="muted">
                {detail.file.kind} · {formatSize(detail.object?.size ?? undefined)}
              </p>
              <h2>Where</h2>
              {detail.replicas.map(({ replica, drive }) => (
                <div className="settings-row" key={`${drive.id}-${replica.relativePath}`}>
                  <span>
                    {drive.name}
                    {drive.online ? "" : " · offline"}
                  </span>
                  <span className={`chip ${replica.status === "copying" ? "go" : "ok"}`}>
                    {replica.status === "copying" ? `${replica.progress}%` : "Ready"}
                  </span>
                </div>
              ))}
              {detail.file.inbox ? (
                <button className="btn btn-primary" style={{ marginTop: 12 }} onClick={() => void onPlace()}>
                  Place
                </button>
              ) : null}
            </>
          ) : (
            <p className="muted">Select a file</p>
          )}
        </aside>
      ) : null}

      <footer className="dock">
        <span>
          {files.length} items · {drives.filter((d) => d.online).length} drives connected
        </span>
      </footer>

      {windowChrome ? null : (
        <nav className="tabs">
          <button className={screen === "events" ? "active" : ""} onClick={() => setScreen("events")}>
            Events
          </button>
          <button
            className={screen === "browse" && typeFilter === "photo" ? "active" : ""}
            onClick={() => {
              setScreen("browse");
              setTypeFilter("photo");
            }}
          >
            Images
          </button>
          <button aria-label="Copy to…" title="Copy to…">
            <span className="fab">+</span>
          </button>
          <button className={screen === "inbox" ? "active" : ""} onClick={() => setScreen("inbox")}>
            Inbox
          </button>
          <button className={screen === "settings" ? "active" : ""} onClick={() => setScreen("settings")}>
            You
          </button>
        </nav>
      )}

      {drawer ? (
        <div className="drawer-bg" onClick={() => setDrawer(false)}>
          <aside className="sidebar drawer-panel" onClick={(e) => e.stopPropagation()}>
            {renderSidebar()}
          </aside>
        </div>
      ) : null}

      {browseViewer && browseDrive && browseFile ? (
        <div className="viewer">
          <div className="vbar top">
            <button type="button" onClick={() => setBrowseViewer(false)}>
              Back
            </button>
            <strong style={{ flex: 1 }}>{browseFile.name}</strong>
          </div>
          <FilePreview
            name={browseFile.name}
            kind={browseFile.kind}
            src={client.driveMediaUrl(browseDrive.id, browseFile.relativePath)}
            fit="viewer"
          />
          <div className="vbar bot" />
        </div>
      ) : viewer && detail?.file.id === viewer ? (
        <div className="viewer">
          <div className="vbar top">
            <button type="button" onClick={() => setViewer(null)}>
              Back
            </button>
            <strong style={{ flex: 1 }}>{detail.file.name}</strong>
          </div>
          <FilePreview name={detail.file.name} kind={detail.file.kind} src={client.mediaUrl(detail.file.id)} fit="viewer" />
          <div className="vbar bot" />
        </div>
      ) : null}

      {modal === "register" ? (
        <div className="modal-bg" onClick={() => setModal(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>Register a drive</h2>
            <p>A folder you choose — on this computer, a disk, or a phone. We’ll remember the files in it. Backup is a separate step.</p>
            {phones.length ? (
              <div className="drive-pick">
                {phones.map((volume) => (
                  <button key={volume.volumeId} type="button" onClick={() => void openPicker(volume)}>
                    <span className="dot" style={{ background: "#0071E3" }} />
                    <span>
                      <strong>{volume.label}</strong>
                      <div className="muted">Choose a folder on this phone</div>
                    </span>
                  </button>
                ))}
              </div>
            ) : (
              <p>No Android phone yet. Plug it in, unlock the screen, and set USB to File transfer. You do not need Developer options. Quit Android File Transfer if macOS opens it.</p>
            )}
            <label className="settings-row">
              <span>Name</span>
              <input className="search-mini" value={regName} onChange={(e) => setRegName(e.target.value)} />
            </label>
            <label className="settings-row">
              <span>Kind</span>
              <select value={regKind} onChange={(e) => setRegKind(e.target.value as DriveKind)}>
                <option value="computer">This computer</option>
                <option value="disk">External disk</option>
                <option value="usb">USB</option>
                <option value="phone">Android phone</option>
              </select>
            </label>
            {regKind !== "phone" ? (
              <>
                <label className="settings-row">
                  <span>Folder</span>
                  <input className="search-mini" value={regPath} onChange={(e) => setRegPath(e.target.value)} />
                </label>
                <div className="bk-wizard-nav">
                  <button className="btn btn-secondary" onClick={() => void onPickFolder()}>
                    Choose folder
                  </button>
                  <button className="btn btn-primary" disabled={!regPath} onClick={() => void onRegister()}>
                    Use this folder
                  </button>
                </div>
              </>
            ) : (
              <p className="muted">Choose a folder on a connected phone above. Unlock it and set USB to File transfer.</p>
            )}
          </div>
        </div>
      ) : null}

      {toast ? <div className="toast">{toast}</div> : null}
      <WindowControls />
    </div>
  );
}
