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

type Screen = "browse" | "events" | "inbox" | "drives" | "backup" | "settings";

const TOUR = [
  {
    title: "This is a file manager.",
    body: "For the disks you already own — this computer, an SSD, a USB stick. A drive is a folder you choose, not the whole disk.",
  },
  {
    title: "Start with your files.",
    body: "Images, videos, and documents, by date. Photos and videos also as events, by day and place.",
  },
  {
    title: "Register any drive you own.",
    body: "A folder on this computer, a plugged-in disk, or an Android phone. Plug the phone in, choose File transfer, unlock it. Unplug later — the catalog still knows.",
  },
  {
    title: "See every copy. Put files where you choose.",
    body: "Already on the SSD. Only here. Copying right now. Backup is plug in, then Start — onto a disk you trust.",
  },
  {
    title: "The catalog stays on this computer.",
    body: "Unplug a disk and Memories still shows what you have, and which folder it lives in.",
  },
];

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
  "Turning files into a catalog…",
  "Hashing over USB takes a while.",
  "Big folders are a slow river.",
  "Leave this screen if you like. Indexing continues.",
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
      <h2>{mode === "index" ? `Indexing ${name}` : `Reading ${name}`}</h2>
      <p>{line}</p>
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
  const [modal, setModal] = useState<"register" | "backup" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [regName, setRegName] = useState("This computer");
  const [regKind, setRegKind] = useState<DriveKind>("computer");
  const [regPath, setRegPath] = useState("");
  const [bkSource, setBkSource] = useState("");
  const [bkDest, setBkDest] = useState("");
  const [bkFolders, setBkFolders] = useState<string[]>([]);
  const [sourceFolders, setSourceFolders] = useState<string[]>([]);
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
      if (seen.has(drive.volumeId)) return false;
      seen.add(drive.volumeId);
      return true;
    });
  }, [drives]);
  const newPhones = useMemo(
    () =>
      phones.filter(
        (volume) =>
          !drives.some(
            (drive) =>
              drive.volumeId === volume.volumeId ||
              (drive.kind === "phone" &&
                drive.volumeId.split(":").slice(0, 3).join(":") === volume.volumeId.split(":").slice(0, 3).join(":")),
          ),
      ),
    [phones, drives],
  );

  useEffect(() => {
    if (screen !== "drives") {
      setBrowseDrive(null);
      setBrowsePath("");
      setBrowseEntries([]);
      setBrowseError(null);
      setBrowseBusy(false);
      setBrowseWait(null);
    }
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
      show(`Indexed ${drive.name}`);
      await refresh();
    } catch (err) {
      show(err instanceof Error ? err.message : "Could not register drive");
    }
  }

  async function onRegisterPhone(volume: VolumePresence) {
    setRegName(volume.label);
    setRegKind("phone");
    setRegPath(volume.mountPath);
    try {
      const drive = await client.registerDrive({
        name: volume.label,
        kind: "phone",
        rootPath: volume.mountPath,
        volumeId: volume.volumeId,
      });
      setModal(null);
      setScreen("drives");
      show(`Opened ${drive.name}`);
      await refresh();
      await openBrowse(drive);
    } catch (err) {
      show(err instanceof Error ? err.message : "Could not register phone");
    }
  }

  async function openBrowse(drive: Drive) {
    if (!drive.online) {
      show("Connect the drive to browse it");
      return;
    }
    setBrowseDrive(drive);
    setBrowseFile(null);
    setBrowseViewer(false);
    await loadBrowse(drive.id, "");
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

  async function onIndexFolder() {
    if (!browseDrive) return;
    setBrowseBusy(true);
    setBrowseWait("index");
    try {
      const result = await client.ingest(browseDrive.id, browsePath || undefined);
      show(`Indexed ${result.files} files`);
      await refresh();
    } catch (err) {
      show(err instanceof Error ? err.message : "Could not index folder");
    } finally {
      setBrowseBusy(false);
      setBrowseWait(null);
    }
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

  async function onSaveBackup() {
    try {
      await client.saveBackup({
        sourceDriveId: bkSource,
        destDriveId: bkDest,
        sourceRelativePaths: bkFolders,
      });
      setModal(null);
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
      <div className="app onboarding">
        <div className="tour" role="dialog" aria-modal="true" aria-labelledby="tour-title">
          <div className="tour-stage">
            <div className="scene scene-files">
              {["Images", "Videos", "Documents", "Events"].map((label, i) => (
                <div className="g" style={{ ["--g" as string]: i }} key={label}>
                  <strong>{label}</strong>
                </div>
              ))}
            </div>
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
      <div className="brand">Memories</div>
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
    <div className={`app${showInspector ? "" : " no-inspector"}`}>
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
          {screen === "drives" && browseDrive ? (
            <>
              <button type="button" onClick={() => setBrowseDrive(null)}>
                Drives
              </button>
              <span className="sep">/</span>
              <button
                type="button"
                className={!browsePath ? "cur" : ""}
                onClick={() => void loadBrowse(browseDrive.id, "")}
              >
                {browseDrive.name}
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
                        onClick={() => void loadBrowse(browseDrive.id, relativePath)}
                      >
                        {part}
                      </button>
                    </span>
                  );
                })}
            </>
          ) : (
            <button className="cur">
              {screen === "browse" ? KIND_LABEL[typeFilter] : screen[0]!.toUpperCase() + screen.slice(1)}
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
              <p>Register a folder as a drive to index files inside it.</p>
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
            {browseDrive ? (
              <>
                <div className="actionbar" style={{ border: 0, padding: "0 0 12px" }}>
                  <h1 style={{ flex: 1, margin: 0 }}>{browseDrive.name}</h1>
                  <button
                    className="btn btn-secondary"
                    onClick={() => {
                      setBrowseDrive(null);
                      setBrowseFile(null);
                      setBrowseViewer(false);
                    }}
                  >
                    Drives
                  </button>
                  {browseDrive.kind === "phone" && !browsePath ? null : (
                    <button className="btn btn-primary" disabled={browseBusy} onClick={() => void onIndexFolder()}>
                      Index this folder
                    </button>
                  )}
                </div>
                {browseDrive.kind === "phone" && !browsePath && !browseBusy ? (
                  <p className="muted">Open a folder, then click a file to preview it. Index Camera or Download when you want those files in Images.</p>
                ) : null}
                <div className="browse-body">
                  {browseBusy && browseWait === "read" ? (
                    <FolderWait name={folderLabel(browseDrive, browsePath)} mode="read" />
                  ) : (
                    <>
                      {browseEntries.map((entry) => (
                        <button
                          key={entry.relativePath}
                          className={`drive-row${browseFile?.relativePath === entry.relativePath ? " selected" : ""}`}
                          type="button"
                          disabled={browseBusy}
                          onClick={() => {
                            if (entry.directory && browseDrive) {
                              void loadBrowse(browseDrive.id, entry.relativePath);
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
                    <FolderWait name={folderLabel(browseDrive, browsePath)} mode="index" />
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
                {newPhones.length ? (
                  <div className="phone-banner">
                    <p>
                      {newPhones.length === 1
                        ? `${newPhones[0]!.label} is plugged in.`
                        : `${newPhones.length} Android phones are plugged in.`}{" "}
                      Open it to browse folders, then index Camera or Download when you want them in the library.
                    </p>
                    {newPhones.map((volume) => (
                      <button
                        key={volume.volumeId}
                        className="btn btn-primary"
                        onClick={() => void onRegisterPhone(volume)}
                      >
                        Register {volume.label}
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
                        {drive.kind === "phone" ? " · Android phone" : ` · ${drive.rootPath}`}
                      </div>
                    </div>
                  </button>
                ))}
                {!drives.length && !newPhones.length ? (
                  <div className="empty">
                    <h2>No drives yet</h2>
                    <p>Pick a folder, or plug in an Android phone. Unlock it and set USB to File transfer. Quit Android File Transfer if it opens.</p>
                  </div>
                ) : null}
              </>
            )}
          </div>
        ) : screen === "backup" ? (
          <div className="pad">
            <div className="actionbar" style={{ border: 0, padding: "0 0 12px" }}>
              <h1 style={{ flex: 1, margin: 0 }}>Backup</h1>
              <button className="btn btn-primary" onClick={() => setModal("backup")}>
                New backup
              </button>
            </div>
            {jobs.map((job) => {
              const source = drives.find((d) => d.id === job.sourceDriveId);
              const dest = drives.find((d) => d.id === job.destDriveId);
              const ready = source?.online && dest?.online;
              return (
                <div className="bk-card" key={job.id}>
                  <h3>
                    {source?.name ?? "Source"} → {dest?.name ?? "Destination"}
                  </h3>
                  <div className="bk-meta">
                    {job.sourceRelativePaths.length ? job.sourceRelativePaths.join(", ") : "Whole drive folder"}
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
                <p>Pick a source folder and a destination folder. We’ll remember that pair.</p>
              </div>
            ) : null}
          </div>
        ) : (
          <div className="pad">
            <h1>Settings</h1>
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
            <p>A folder on this computer, a disk, or an Android phone. We’ll only work inside that root.</p>
            {phones.length ? (
              <div className="drive-pick">
                {phones.map((volume) => (
                  <button key={volume.volumeId} type="button" onClick={() => void onRegisterPhone(volume)}>
                    <span className="dot" style={{ background: "#0071E3" }} />
                    <span>
                      <strong>{volume.label}</strong>
                      <div className="muted">Android phone</div>
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
                    Register and index
                  </button>
                </div>
              </>
            ) : (
              <p className="muted">Use a connected phone above. Unlock it and set USB to File transfer.</p>
            )}
          </div>
        </div>
      ) : null}

      {modal === "backup" ? (
        <div className="modal-bg" onClick={() => setModal(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>New backup</h2>
            <p>Source folder → destination folder. Next time: Start backup.</p>
            <label className="settings-row">
              <span>From</span>
              <select
                value={bkSource}
                onChange={(e) => {
                  setBkSource(e.target.value);
                  void client.driveFolders(e.target.value).then(setSourceFolders);
                }}
              >
                <option value="">Select</option>
                {uniqueDrives.map((drive) => (
                  <option key={drive.id} value={drive.id}>
                    {drive.name}
                  </option>
                ))}
              </select>
            </label>
            {sourceFolders.map((folder) => (
              <button
                key={folder}
                className={`check-row${bkFolders.includes(folder) ? " on" : ""}`}
                onClick={() =>
                  setBkFolders((current) =>
                    current.includes(folder) ? current.filter((f) => f !== folder) : [...current, folder],
                  )
                }
              >
                <span className="box">{bkFolders.includes(folder) ? "✓" : ""}</span>
                {folder}
              </button>
            ))}
            <label className="settings-row">
              <span>To</span>
              <select value={bkDest} onChange={(e) => setBkDest(e.target.value)}>
                <option value="">Select</option>
                {drives
                  .filter((drive) => drive.id !== bkSource)
                  .map((drive) => (
                    <option key={drive.id} value={drive.id}>
                      {drive.name}
                    </option>
                  ))}
              </select>
            </label>
            <button className="btn btn-primary" disabled={!bkSource || !bkDest} onClick={() => void onSaveBackup()}>
              Save backup
            </button>
          </div>
        </div>
      ) : null}

      {toast ? <div className="toast">{toast}</div> : null}
    </div>
  );
}
