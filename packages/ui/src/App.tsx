import type { MemoriesClient } from "@memories/client";
import type { BackupJob, DirEntry, Drive, DriveKind, EventCluster, FileDetail, LibraryFile, VolumePresence } from "@memories/core";
import { AnimatePresence, LayoutGroup, motion, MotionConfig } from "motion/react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { BackupHome, BackupWizard, toggleFolder, type BackupResult } from "./Backup.js";
import {
  dayLabel,
  DOC_NAV,
  EXTRA_SHELVES,
  FAMILY,
  familyOf,
  formatSize,
  isPhonePath,
  monthLabel,
  pathLeaf,
  placeStatus,
  plural,
  PRIMARY_SHELVES,
  SHELF,
  shortDate,
  type Family,
  type Shelf,
} from "./files.js";
import { Icon, type IconName } from "./icons.js";
import { Library, type Lens, type Scope } from "./Library.js";
import { AddPlaceDialog, PlaceBrowser, PlacesHome, type BrowseLens } from "./Places.js";
import { CopyToMenu, Facts, FilePreview, Inspector, kindLine, Viewer } from "./Preview.js";
import { Settings } from "./Settings.js";
import { applyTheme, chromePlatform, readThemePref, resolvedTheme, saveThemePref, type ThemePref } from "./theme.js";
import { Welcome } from "./Welcome.js";

type Screen = "library" | "places" | "backup" | "settings";
type View = "tiles" | "list";

const spring = { type: "spring", duration: 0.4, bounce: 0.15 } as const;

function readPref<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try {
    const value = localStorage.getItem(key) as T | null;
    return value && allowed.includes(value) ? value : fallback;
  } catch {
    return fallback;
  }
}

function joinMount(mountPath: string, relativePath: string) {
  if (!relativePath) return mountPath;
  return `${mountPath.replace(/\/$/, "")}/${relativePath}`;
}

function needsPhoneConfirm(drive: Drive, entry: DirEntry) {
  if (drive.kind !== "phone") return false;
  return entry.kind === "video" || entry.size > 20 * 1024 * 1024;
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
      <button type="button" aria-label="Minimize" onClick={() => chrome?.minimize?.()}>
        <svg viewBox="0 0 10 10" aria-hidden="true">
          <path d="M1 5h8" />
        </svg>
      </button>
      <button type="button" aria-label={maximized ? "Restore" : "Maximize"} onClick={() => chrome?.toggleMaximize?.()}>
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
      <button type="button" className="win-close" aria-label="Close" onClick={() => chrome?.close?.()}>
        <svg viewBox="0 0 10 10" aria-hidden="true">
          <path d="M2 2l6 6M8 2l-6 6" />
        </svg>
      </button>
    </div>
  );
}

function Segmented<T extends string>({
  id,
  label,
  value,
  options,
  onChange,
}: {
  id: string;
  label: string;
  value: T;
  options: { value: T; label: string; icon?: IconName }[];
  onChange: (value: T) => void;
}) {
  return (
    <div className="seg" role="radiogroup" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={value === option.value}
          aria-label={option.icon ? option.label : undefined}
          title={option.icon ? option.label : undefined}
          className={value === option.value ? "on" : ""}
          onClick={() => onChange(option.value)}
        >
          {value === option.value ? <motion.i layoutId={`seg-${id}`} className="seg-pill" transition={spring} /> : null}
          <span>{option.icon ? <Icon name={option.icon} size={16} /> : option.label}</span>
        </button>
      ))}
    </div>
  );
}

function NavItem({
  active,
  icon,
  label,
  badge,
  onClick,
  children,
}: {
  active: boolean;
  icon?: IconName;
  label: string;
  badge?: number;
  onClick: () => void;
  children?: ReactNode;
}) {
  return (
    <button type="button" className={`nav-item${active ? " active" : ""}`} aria-current={active ? "page" : undefined} onClick={onClick}>
      {active ? <motion.i layoutId="nav-pill" className="nav-pill" transition={spring} /> : null}
      {children ?? (icon ? <Icon name={icon} size={18} /> : null)}
      <span className="nav-text">{label}</span>
      <AnimatePresence>
        {badge ? (
          <motion.span
            className="badge"
            initial={{ opacity: 0, scale: 0.6 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.6 }}
            transition={spring}
          >
            {badge}
          </motion.span>
        ) : null}
      </AnimatePresence>
    </button>
  );
}

export function MemoriesApp({ client }: { client: MemoriesClient }) {
  const [showWelcome, setShowWelcome] = useState(false);
  const [welcomeKey, setWelcomeKey] = useState(0);
  const [screen, setScreen] = useState<Screen>("library");
  const [lens, setLens] = useState<Lens>(() => readPref("memories-lens", ["type", "date", "moments"] as const, "type"));
  const [view, setView] = useState<View>(() => readPref("memories-view", ["tiles", "list"] as const, "tiles"));
  const [scope, setScope] = useState<Scope>({});
  const [search, setSearch] = useState("");
  const [drives, setDrives] = useState<Drive[]>([]);
  const [volumes, setVolumes] = useState<VolumePresence[]>([]);
  const [files, setFiles] = useState<LibraryFile[]>([]);
  const [events, setEvents] = useState<EventCluster[]>([]);
  const [jobs, setJobs] = useState<BackupJob[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<FileDetail | null>(null);
  const [viewer, setViewer] = useState<string | null>(null);
  const [toast, setToast] = useState<{ id: number; text: string } | null>(null);
  const [adding, setAdding] = useState(false);
  const [drawer, setDrawer] = useState(false);
  const [themePref, setThemePref] = useState<ThemePref>(readThemePref);

  const [browseDrive, setBrowseDrive] = useState<Drive | null>(null);
  const [pickerVolume, setPickerVolume] = useState<VolumePresence | null>(null);
  const [browsePath, setBrowsePath] = useState("");
  const [browseEntries, setBrowseEntries] = useState<DirEntry[]>([]);
  const [browseBusy, setBrowseBusy] = useState(false);
  const [browseAdding, setBrowseAdding] = useState(false);
  const [browseError, setBrowseError] = useState<string | null>(null);
  const [browseFile, setBrowseFile] = useState<DirEntry | null>(null);
  const [browseLoad, setBrowseLoad] = useState(false);
  const [browseViewer, setBrowseViewer] = useState(false);
  const [browseLens, setBrowseLens] = useState<BrowseLens>("folders");

  const [bkSetup, setBkSetup] = useState(false);
  const [bkStep, setBkStep] = useState(0);
  const [bkSource, setBkSource] = useState("");
  const [bkDest, setBkDest] = useState("");
  const [bkFolders, setBkFolders] = useState<string[]>([]);
  const [bkPath, setBkPath] = useState("");
  const [bkEntries, setBkEntries] = useState<DirEntry[]>([]);
  const [bkBusy, setBkBusy] = useState(false);
  const [bkError, setBkError] = useState<string | null>(null);
  const [bkRunning, setBkRunning] = useState<string | null>(null);
  const [bkResult, setBkResult] = useState<BackupResult | null>(null);
  const [docsOpen, setDocsOpen] = useState(false);

  const searchRef = useRef<HTMLInputElement>(null);
  const windowChrome = chromePlatform();

  useEffect(() => {
    applyTheme(themePref);
    if (themePref !== "system") return;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => applyTheme("system");
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, [themePref]);

  const show = useCallback((text: string) => {
    const id = Date.now();
    setToast({ id, text });
    window.setTimeout(() => setToast((current) => (current?.id === id ? null : current)), 2600);
  }, []);

  const refresh = useCallback(async () => {
    try {
      const [nextDrives, nextVolumes, nextFiles, nextEvents, nextJobs] = await Promise.all([
        client.drives(),
        client.volumes(),
        client.files({}),
        client.events(),
        client.backups(),
      ]);
      setDrives(nextDrives);
      setVolumes(nextVolumes);
      setFiles(nextFiles);
      setEvents(nextEvents);
      setJobs(nextJobs);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Memories isn’t responding");
    } finally {
      setLoaded(true);
    }
  }, [client]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if ((screen !== "places" && screen !== "backup") || browseDrive || pickerVolume) return;
    const timer = window.setInterval(() => void refresh(), 4000);
    return () => window.clearInterval(timer);
  }, [screen, refresh, browseDrive, pickerVolume]);

  useEffect(() => {
    if (!selected) {
      setDetail(null);
      return;
    }
    let live = true;
    void client
      .file(selected)
      .then((next) => live && setDetail(next))
      .catch(() => live && setDetail(null));
    return () => {
      live = false;
    };
  }, [client, selected, files]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f" && screen === "library") {
        event.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [screen]);

  useEffect(() => {
    const close = () => window.innerWidth >= 860 && setDrawer(false);
    window.addEventListener("resize", close);
    return () => window.removeEventListener("resize", close);
  }, []);

  const phones = useMemo(() => volumes.filter((volume) => isPhonePath(volume.mountPath)), [volumes]);
  const places = useMemo(() => {
    const seen = new Set<string>();
    return drives.filter((drive) => {
      const key = `${drive.volumeId}::${drive.rootPath}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }, [drives]);
  const shelfCounts = useMemo(() => {
    const counts: Partial<Record<Shelf, number>> = {};
    for (const file of files) {
      const shelf = FAMILY[familyOf(file.name, file.kind)].shelf;
      counts[shelf] = (counts[shelf] ?? 0) + 1;
    }
    return counts;
  }, [files]);
  const familyCounts = useMemo(() => {
    const counts: Partial<Record<Family, number>> = {};
    for (const file of files) {
      const family = familyOf(file.name, file.kind);
      counts[family] = (counts[family] ?? 0) + 1;
    }
    return counts;
  }, [files]);

  useEffect(() => {
    if (screen === "library" && scope.shelf === "documents") setDocsOpen(true);
  }, [screen, scope.shelf]);

  function resetBrowse() {
    setBrowseDrive(null);
    setPickerVolume(null);
    setBrowsePath("");
    setBrowseEntries([]);
    setBrowseError(null);
    setBrowseBusy(false);
    setBrowseAdding(false);
    setBrowseFile(null);
    setBrowseViewer(false);
  }

  function go(next: Screen) {
    setScreen(next);
    setDrawer(false);
    setSelected(null);
    if (next !== "places") resetBrowse();
    if (next !== "backup") setBkSetup(false);
  }

  function openLibrary(nextScope: Scope, nextLens?: Lens) {
    go("library");
    setScope(nextScope);
    setSearch("");
    if (nextLens) changeLens(nextLens);
    else if (lens === "moments") changeLens("type");
  }

  function changeLens(next: Lens) {
    setLens(next);
    try {
      localStorage.setItem("memories-lens", next);
    } catch {
      /* private mode */
    }
  }

  function changeView(next: View) {
    setView(next);
    try {
      localStorage.setItem("memories-view", next);
    } catch {
      /* private mode */
    }
  }

  function openWelcomeTour() {
    setWelcomeKey((key) => key + 1);
    setShowWelcome(true);
    setDrawer(false);
  }

  function finishWelcome(start: boolean) {
    setShowWelcome(false);
    if (start && !places.length) setAdding(true);
  }

  async function listEntries(load: () => Promise<DirEntry[]>, path: string) {
    setBrowseBusy(true);
    setBrowsePath(path);
    setBrowseError(null);
    setBrowseEntries([]);
    setBrowseFile(null);
    setBrowseViewer(false);
    setBrowseLoad(false);
    try {
      setBrowseEntries(await load());
    } catch (err) {
      setBrowseError(err instanceof Error ? err.message : "Something got in the way.");
    } finally {
      setBrowseBusy(false);
    }
  }

  const loadPicker = (volume: VolumePresence, path: string) => listEntries(() => client.volumeEntries(volume.mountPath, path), path);
  const loadBrowse = (drive: Drive, path: string) => listEntries(() => client.driveEntries(drive.id, path), path);

  async function openPicker(volume: VolumePresence) {
    setAdding(false);
    go("places");
    setPickerVolume(volume);
    setBrowseDrive(null);
    await loadPicker(volume, "");
  }

  async function openPlace(drive: Drive) {
    if (!drive.online) {
      show(drive.kind === "computer" ? `Can’t find ${drive.name} right now` : `Plug in ${drive.name} to open it`);
      return;
    }
    go("places");
    setPickerVolume(null);
    setBrowseDrive(drive);
    await loadBrowse(drive, "");
  }

  async function onUsePhoneFolder() {
    if (!pickerVolume) return;
    const rootPath = joinMount(pickerVolume.mountPath, browsePath);
    const name = browsePath ? `${pickerVolume.label} · ${pathLeaf(browsePath)}` : pickerVolume.label;
    setBrowseBusy(true);
    setBrowseAdding(true);
    try {
      const drive = await client.registerDrive({ name, kind: "phone", rootPath, volumeId: pickerVolume.volumeId });
      await client.ingest(drive.id);
      setPickerVolume(null);
      show(`Added ${drive.name}`);
      await refresh();
      setBrowseAdding(false);
      setBrowseDrive(drive);
      await loadBrowse(drive, "");
    } catch (err) {
      show(err instanceof Error ? err.message : "Couldn’t add this folder");
    } finally {
      setBrowseBusy(false);
      setBrowseAdding(false);
    }
  }

  async function onAddPlace(input: { name: string; kind: DriveKind; rootPath: string }) {
    try {
      setAdding(false);
      show(`Adding ${input.name}…`);
      const drive = await client.registerDrive(input);
      await client.ingest(drive.id);
      show(`Added ${drive.name}`);
      await refresh();
    } catch (err) {
      show(err instanceof Error ? err.message : "Couldn’t add this place");
    }
  }

  async function pickFolder() {
    try {
      return await client.pickFolder();
    } catch {
      return null;
    }
  }

  async function loadBkFolders(driveId: string, path: string) {
    setBkBusy(true);
    setBkPath(path);
    setBkError(null);
    setBkEntries([]);
    try {
      const entries = await client.driveEntries(driveId, path);
      setBkEntries(entries.filter((entry) => entry.directory));
    } catch (err) {
      setBkError(err instanceof Error ? err.message : "");
    } finally {
      setBkBusy(false);
    }
  }

  function startBackup(source?: Drive) {
    go("backup");
    setBkSetup(true);
    setBkStep(0);
    setBkSource("");
    setBkDest("");
    setBkFolders([]);
    setBkPath("");
    setBkEntries([]);
    if (source) void pickBkSource(source);
  }

  async function pickBkSource(drive: Drive) {
    if (!drive.online) {
      show(`Plug in ${drive.name} to choose its folders`);
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
      await client.saveBackup({ sourceDriveId: bkSource, destDriveId: bkDest, sourceRelativePaths: bkFolders });
      setBkSetup(false);
      show("Backup saved");
      await refresh();
    } catch (err) {
      show(err instanceof Error ? err.message : "Couldn’t save this backup");
    }
  }

  async function onRunBackup(id: string) {
    setBkRunning(id);
    setBkResult(null);
    try {
      const result = await client.runBackup(id);
      setBkResult({ id, ...result });
      await refresh();
    } catch (err) {
      show(err instanceof Error ? err.message : "The backup stopped part way");
    } finally {
      setBkRunning(null);
    }
  }

  async function onSorted() {
    if (!selected) return;
    await client.placeFile(selected);
    show("Marked as sorted");
    await refresh();
  }

  async function onCopy(drive: Drive) {
    if (!selected) return;
    try {
      show(`Copying to ${drive.name}…`);
      await client.copyFile(selected, { destDriveId: drive.id });
      show(`Copied to ${drive.name}`);
      await refresh();
    } catch (err) {
      show(err instanceof Error ? err.message : `Couldn’t copy to ${drive.name}`);
    }
  }

  const browsing = screen === "places" && (!!browseDrive || !!pickerVolume);
  const browseTitle = pickerVolume?.label ?? browseDrive?.name ?? "";
  const libFile = screen === "library" && detail && detail.file.id === selected ? detail : null;
  const inspectorOpen = !!libFile || (browsing && !!browseFile && !!browseDrive);

  const scopeParts: { key: keyof Scope; label: string }[] = [];
  if (scope.inbox) scopeParts.push({ key: "inbox", label: "New" });
  if (scope.shelf) scopeParts.push({ key: "shelf", label: SHELF[scope.shelf].label });
  if (scope.family && SHELF[FAMILY[scope.family].shelf].families.length > 1) scopeParts.push({ key: "family", label: FAMILY[scope.family].label });
  if (scope.month) scopeParts.push({ key: "month", label: monthLabel(scope.month) });
  if (scope.day) scopeParts.push({ key: "day", label: dayLabel(scope.day) });

  function dropScope(key: keyof Scope) {
    const next = { ...scope };
    delete next[key];
    if (key === "shelf") delete next.family;
    if (key === "month") delete next.day;
    setScope(next);
    setSelected(null);
  }

  const libraryEmpty = !places.length ? (
    <div className="empty hero">
      <div className="hero-prints" aria-hidden="true">
        <span className="obj print">
          <span className="print-img" />
        </span>
        <span className="obj sheet" style={{ ["--tint" as string]: "#C8433A" }}>
          <span className="sheet-tab">PDF</span>
          <span className="lines" />
        </span>
        <span className="obj parcel" style={{ ["--tint" as string]: "#A87A4C" }}>
          <span className="parcel-lid" />
          <span className="parcel-tape" />
          <span className="parcel-label">DMG</span>
        </span>
      </div>
      <h2>Let’s fill your cabinet</h2>
      <p>Add a place, like the Pictures folder on this computer or the Camera on your phone. Everything inside shows up here, sorted for you.</p>
      <button type="button" className="btn btn-primary big" onClick={() => setAdding(true)}>
        <Icon name="plus" size={18} /> Add a place
      </button>
    </div>
  ) : (
    <div className="empty">
      <div className="empty-art big">
        <Icon name="sparkle" size={30} />
      </div>
      <h2>Nothing found yet</h2>
      <p>Your places don’t have any files Memories can show yet. Try adding another folder.</p>
      <button type="button" className="btn btn-soft" onClick={() => setAdding(true)}>
        <Icon name="plus" size={16} /> Add a place
      </button>
    </div>
  );

  const sidebar = (
    <LayoutGroup id="nav">
      <div className="brand" style={windowChrome === "darwin" ? { paddingLeft: 74 } : undefined}>
        <span className="brand-mark" aria-hidden="true">
          <i />
          <i />
        </span>
        Memories
      </div>
      <nav className="nav" aria-label="Main">
        <div className="nav-group">
          <NavItem
            active={screen === "library" && !scope.shelf && lens !== "moments"}
            icon="all"
            label="Everything"
            onClick={() => openLibrary({})}
          />
          {PRIMARY_SHELVES.map((shelf) => {
            if (shelf === "documents") {
              const docsActive = screen === "library" && scope.shelf === "documents";
              const allDocsActive = docsActive && !scope.family;
              const formats = DOC_NAV.filter((item) => familyCounts[item.family]);
              return (
                <div key={shelf} className="nav-accordion">
                  <div className={`nav-accordion-head${docsActive ? " current" : ""}`}>
                    <button
                      type="button"
                      className={`nav-item${allDocsActive ? " active" : ""}`}
                      aria-current={allDocsActive ? "page" : undefined}
                      onClick={() => {
                        setDocsOpen(true);
                        openLibrary({ shelf: "documents" });
                      }}
                    >
                      {allDocsActive ? <motion.i layoutId="nav-pill" className="nav-pill" transition={spring} /> : null}
                      <Icon name="doc" size={18} />
                      <span className="nav-text">Documents</span>
                    </button>
                    <button
                      type="button"
                      className={`nav-disclose${docsOpen ? " open" : ""}`}
                      aria-label={docsOpen ? "Hide document formats" : "Show document formats"}
                      aria-expanded={docsOpen}
                      onClick={() => setDocsOpen((open) => !open)}
                    >
                      <Icon name="chevron" size={14} />
                    </button>
                  </div>
                  <AnimatePresence initial={false}>
                    {docsOpen ? (
                      <motion.div
                        className="nav-sub"
                        role="group"
                        aria-label="Document formats"
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: "auto", opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        transition={{ duration: 0.22, ease: [0.23, 1, 0.32, 1] }}
                      >
                        {formats.map((item) => {
                          const active = docsActive && scope.family === item.family;
                          return (
                            <button
                              key={item.family}
                              type="button"
                              className={`nav-item sub${active ? " active" : ""}`}
                              aria-label={item.label}
                              aria-current={active ? "page" : undefined}
                              onClick={() => openLibrary({ shelf: "documents", family: item.family })}
                            >
                              {active ? <motion.i layoutId="nav-pill" className="nav-pill" transition={spring} /> : null}
                              <span className="nav-text">{item.label}</span>
                              <span className="nav-count" aria-hidden="true">
                                {(familyCounts[item.family] ?? 0).toLocaleString("en-GB")}
                              </span>
                            </button>
                          );
                        })}
                        {!formats.length ? <p className="nav-sub-empty">No documents yet</p> : null}
                      </motion.div>
                    ) : null}
                  </AnimatePresence>
                </div>
              );
            }
            return (
              <NavItem
                key={shelf}
                active={screen === "library" && scope.shelf === shelf}
                icon={shelf === "photos" ? "photo" : shelf === "videos" ? "video" : shelf === "music" ? "music" : "doc"}
                label={SHELF[shelf].label}
                onClick={() => openLibrary({ shelf })}
              />
            );
          })}
          {EXTRA_SHELVES.filter((shelf) => shelfCounts[shelf]).map((shelf) => (
            <NavItem
              key={shelf}
              active={screen === "library" && scope.shelf === shelf}
              icon={shelf === "apps" ? "download" : "doc"}
              label={SHELF[shelf].label}
              onClick={() => openLibrary({ shelf })}
            />
          ))}
          <NavItem
            active={screen === "library" && lens === "moments" && !scope.shelf}
            icon="moments"
            label="Moments"
            onClick={() => openLibrary({}, "moments")}
          />
          <NavItem active={showWelcome} icon="sparkle" label="Welcome tour" onClick={openWelcomeTour} />
        </div>

        <div className="nav-group">
          <NavItem active={screen === "places" && !browsing} icon="place" label="Places" onClick={() => go("places")} />
          {places.map((drive) => (
            <NavItem
              key={drive.id}
              active={browsing && browseDrive?.id === drive.id}
              label={drive.name}
              onClick={() => void openPlace(drive)}
            >
              <span className={`nav-dot${drive.online ? " on" : ""}`} title={placeStatus(drive)} />
            </NavItem>
          ))}
          <button type="button" className="nav-item quiet" onClick={() => setAdding(true)}>
            <Icon name="plus" size={16} />
            <span className="nav-text">Add a place</span>
          </button>
        </div>

        <div className="nav-group">
          <NavItem active={screen === "backup"} icon="backup" label="Backup" onClick={() => go("backup")} />
          <NavItem active={screen === "settings"} icon="settings" label="Settings" onClick={() => go("settings")} />
        </div>
      </nav>
      <div className="sidebar-foot">
        <span>
          {plural(files.length, "file")}
          <br />
          {places.length ? `${places.filter((d) => d.online).length} of ${plural(places.length, "place")} ready` : "No places yet"}
        </span>
        <button
          type="button"
          className="icon-btn theme-btn"
          aria-label={resolvedTheme(themePref) === "dark" ? "Switch to light" : "Switch to dark"}
          onClick={(event) => {
            const next = resolvedTheme(themePref) === "dark" ? "light" : "dark";
            setThemePref(next);
            saveThemePref(next, { x: event.clientX, y: event.clientY });
          }}
        >
          <AnimatePresence mode="wait" initial={false}>
            <motion.span
              key={resolvedTheme(themePref)}
              initial={{ opacity: 0, rotate: -90, scale: 0.6 }}
              animate={{ opacity: 1, rotate: 0, scale: 1 }}
              exit={{ opacity: 0, rotate: 90, scale: 0.6 }}
              transition={{ duration: 0.25, ease: [0.23, 1, 0.32, 1] }}
            >
              <Icon name={resolvedTheme(themePref) === "dark" ? "moon" : "sun"} size={17} />
            </motion.span>
          </AnimatePresence>
        </button>
      </div>
    </LayoutGroup>
  );

  let main: ReactNode;
  if (error && !files.length && !drives.length) {
    main = (
      <div className="empty">
        <div className="empty-art big spin">
          <Icon name="sparkle" size={30} />
        </div>
        <h2>Memories is getting ready</h2>
        <p>This usually takes a second. If it keeps showing, quit Memories and open it again.</p>
        <p className="hint">{error}</p>
      </div>
    );
  } else if (screen === "library") {
    main = loaded ? (
      <Library
        key={JSON.stringify(scope)}
        files={files}
        events={events}
        lens={lens}
        scope={scope}
        search={search}
        view={view}
        selected={selected}
        mediaUrl={(id) => client.mediaUrl(id)}
        onDrill={(next) => {
          setScope(next);
          setSelected(null);
        }}
        onSelect={setSelected}
        onOpen={(id) => {
          setSelected(id);
          setViewer(id);
        }}
        empty={libraryEmpty}
      />
    ) : null;
  } else if (screen === "places") {
    main = browsing ? (
      <PlaceBrowser
        title={browseTitle}
        path={browsePath}
        entries={browseEntries}
        busy={browseBusy}
        adding={browseAdding}
        error={browseError}
        lens={browseLens}
        selected={browseFile?.relativePath ?? null}
        picking={!!pickerVolume}
        thumbUrl={browseDrive && browseDrive.kind !== "phone" ? (entry) => client.driveMediaUrl(browseDrive.id, entry.relativePath) : null}
        onEnter={(entry) => (pickerVolume ? void loadPicker(pickerVolume, entry.relativePath) : browseDrive && void loadBrowse(browseDrive, entry.relativePath))}
        onSelect={(entry) => {
          if (!browseDrive) return;
          setBrowseFile(entry);
          setBrowseViewer(false);
          setBrowseLoad(!needsPhoneConfirm(browseDrive, entry));
        }}
        onOpen={(entry) => {
          if (!browseDrive) return;
          setBrowseFile(entry);
          setBrowseLoad(true);
          setBrowseViewer(true);
        }}
        onUse={() => void onUsePhoneFolder()}
      />
    ) : (
      <PlacesHome
        drives={places}
        phones={phones}
        onOpen={(drive) => void openPlace(drive)}
        onAdd={() => setAdding(true)}
        onPhone={(volume) => void openPicker(volume)}
        onBackup={(drive) => startBackup(drive)}
      />
    );
  } else if (screen === "backup") {
    main = bkSetup ? (
      <BackupWizard
        step={bkStep}
        drives={places}
        sourceId={bkSource}
        destId={bkDest}
        folders={bkFolders}
        path={bkPath}
        entries={bkEntries}
        busy={bkBusy}
        error={bkError}
        onPickSource={(drive) => void pickBkSource(drive)}
        onOpenFolder={(path) => void loadBkFolders(bkSource, path)}
        onToggle={(path) => setBkFolders((current) => toggleFolder(current, path))}
        onPickDest={setBkDest}
        onStep={setBkStep}
        onCancel={() => setBkSetup(false)}
        onSave={() => void onSaveBackup()}
      />
    ) : (
      <BackupHome jobs={jobs} drives={drives} running={bkRunning} result={bkResult} onNew={() => startBackup()} onRun={(id) => void onRunBackup(id)} />
    );
  } else {
    main = (
      <Settings
        theme={themePref}
        onTheme={(next, origin) => {
          setThemePref(next);
          saveThemePref(next, origin);
        }}
      />
    );
  }

  const crumbs = browsePath.split("/").filter(Boolean);

  return (
    <MotionConfig reducedMotion="user">
      <div className={`app${windowChrome ? ` chrome-${windowChrome}` : ""}`}>
        <aside className="sidebar">{sidebar}</aside>

        <div className="workspace">
          <header className="topbar">
            <button type="button" className="icon-btn menu-btn" aria-label="Menu" aria-expanded={drawer} onClick={() => setDrawer((open) => !open)}>
              <Icon name="menu" size={18} />
            </button>

            <nav className="crumbs" aria-label="You are here">
              {screen === "library" ? (
                <>
                  <button type="button" className={scopeParts.length ? "" : "cur"} onClick={() => openLibrary({}, lens)}>
                    {lens === "moments" && !scopeParts.length ? "Moments" : "Everything"}
                  </button>
                  <AnimatePresence initial={false}>
                    {scopeParts.map((part) => (
                      <motion.span
                        key={part.key}
                        className="scope-chip"
                        layout
                        initial={{ opacity: 0, scale: 0.9 }}
                        animate={{ opacity: 1, scale: 1 }}
                        exit={{ opacity: 0, scale: 0.9 }}
                        transition={spring}
                      >
                        {part.label}
                        <button type="button" aria-label={`Remove ${part.label}`} onClick={() => dropScope(part.key)}>
                          <Icon name="close" size={12} />
                        </button>
                      </motion.span>
                    ))}
                  </AnimatePresence>
                </>
              ) : browsing ? (
                <>
                  <button type="button" onClick={() => go("places")}>
                    Places
                  </button>
                  <Icon name="chevron" size={12} />
                  <button
                    type="button"
                    className={!browsePath ? "cur" : ""}
                    onClick={() => (pickerVolume ? void loadPicker(pickerVolume, "") : browseDrive && void loadBrowse(browseDrive, ""))}
                  >
                    {browseTitle}
                  </button>
                  {crumbs.map((part, index) => {
                    const rel = crumbs.slice(0, index + 1).join("/");
                    return (
                      <span key={rel} className="crumb">
                        <Icon name="chevron" size={12} />
                        <button
                          type="button"
                          className={index === crumbs.length - 1 ? "cur" : ""}
                          onClick={() => (pickerVolume ? void loadPicker(pickerVolume, rel) : browseDrive && void loadBrowse(browseDrive, rel))}
                        >
                          {part}
                        </button>
                      </span>
                    );
                  })}
                </>
              ) : (
                <span className="cur">{screen === "places" ? "Places" : screen === "backup" ? (bkSetup ? "New backup" : "Backup") : "Settings"}</span>
              )}
            </nav>

            {screen === "library" && files.length ? (
              <div className="tools">
                <label className={`search${search ? " filled" : ""}`}>
                  <Icon name="search" size={15} />
                  <input
                    ref={searchRef}
                    type="search"
                    placeholder="Find by name"
                    aria-label="Find by name"
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                    onKeyDown={(event) => event.key === "Escape" && setSearch("")}
                  />
                </label>
                <Segmented
                  id="lens"
                  label="View by"
                  value={lens}
                  onChange={(next) => {
                    changeLens(next);
                    setSelected(null);
                  }}
                  options={[
                    { value: "type", label: "Type" },
                    { value: "date", label: "Date" },
                    { value: "moments", label: "Moments" },
                  ]}
                />
                <Segmented
                  id="view"
                  label="Layout"
                  value={view}
                  onChange={changeView}
                  options={[
                    { value: "tiles", label: "Tiles", icon: "grid" },
                    { value: "list", label: "List", icon: "list" },
                  ]}
                />
              </div>
            ) : browsing && !pickerVolume && browseEntries.length ? (
              <div className="tools">
                <Segmented
                  id="browse"
                  label="View by"
                  value={browseLens}
                  onChange={setBrowseLens}
                  options={[
                    { value: "folders", label: "Folders" },
                    { value: "type", label: "Type" },
                  ]}
                />
              </div>
            ) : null}
          </header>

          <main className={`main${inspectorOpen ? " with-inspector" : ""}`}>
            <AnimatePresence mode="wait" initial={false}>
              <motion.div
                key={`${screen}-${browsing ? "b" : ""}-${bkSetup ? "w" : ""}`}
                className="screen"
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, transition: { duration: 0.1 } }}
                transition={{ duration: 0.22, ease: [0.23, 1, 0.32, 1] }}
              >
                {main}
              </motion.div>
            </AnimatePresence>
          </main>

          <Inspector
            open={inspectorOpen}
            title={libFile?.file.name ?? browseFile?.name ?? ""}
            onClose={() => {
              setSelected(null);
              setBrowseFile(null);
            }}
          >
            {libFile ? (
              <>
                <button type="button" className="insp-preview" aria-label={`Open ${libFile.file.name}`} onClick={() => setViewer(libFile.file.id)}>
                  <FilePreview name={libFile.file.name} kind={libFile.file.kind} src={client.mediaUrl(libFile.file.id)} fit="inspector" />
                </button>
                <h3>{libFile.file.name}</h3>
                <Facts
                  rows={[
                    ["Kind", kindLine(libFile.file.name, libFile.file.kind)],
                    ["Date", shortDate(libFile.file.takenAt)],
                    ["Where", libFile.file.place ?? ""],
                    ["Size", formatSize(libFile.object?.size)],
                  ]}
                />
                <h4>Kept on</h4>
                <ul className="kept">
                  {libFile.replicas.map(({ replica, drive }) => (
                    <li key={`${drive.id}-${replica.relativePath}`}>
                      <Icon name={drive.kind} size={16} />
                      <span>{drive.name}</span>
                      <span className={`chip ${replica.status === "copying" ? "go" : drive.online ? "ok" : "off"}`}>
                        {replica.status === "copying" ? `Copying ${replica.progress ?? 0}%` : drive.online ? "Ready" : "Unplugged"}
                      </span>
                    </li>
                  ))}
                </ul>
                <div className="insp-actions">
                  <button type="button" className="btn btn-primary" onClick={() => setViewer(libFile.file.id)}>
                    <Icon name="open" size={16} /> Open
                  </button>
                  <CopyToMenu
                    places={places.filter((drive) => !libFile.replicas.some((row) => row.drive.id === drive.id))}
                    onPick={(drive) => void onCopy(drive)}
                  />
                  {libFile.file.inbox ? (
                    <button type="button" className="btn btn-soft" onClick={() => void onSorted()}>
                      <Icon name="check" size={16} /> Mark as sorted
                    </button>
                  ) : null}
                </div>
              </>
            ) : browseDrive && browseFile ? (
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
                    <div className="still">
                      <button type="button" className="btn btn-primary" onClick={() => setBrowseLoad(true)}>
                        Preview
                      </button>
                      <span>Big files take a moment to come over the cable.</span>
                    </div>
                  )}
                </div>
                <h3>{browseFile.name}</h3>
                <Facts
                  rows={[
                    ["Kind", kindLine(browseFile.name, browseFile.kind)],
                    ["Size", formatSize(browseFile.size)],
                    ["Folder", browseFile.relativePath.split("/").slice(0, -1).join(" › ") || browseDrive.name],
                  ]}
                />
                <div className="insp-actions">
                  <button
                    type="button"
                    className="btn btn-primary"
                    onClick={() => {
                      setBrowseLoad(true);
                      setBrowseViewer(true);
                    }}
                  >
                    <Icon name="open" size={16} /> Open
                  </button>
                </div>
              </>
            ) : null}
          </Inspector>
        </div>

        <AnimatePresence>
          {drawer ? (
            <motion.div className="drawer-bg" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => setDrawer(false)}>
              <motion.aside
                className="sidebar drawer-panel"
                initial={{ transform: "translateX(-100%)" }}
                animate={{ transform: "translateX(0%)" }}
                exit={{ transform: "translateX(-100%)" }}
                transition={{ duration: 0.35, ease: [0.32, 0.72, 0, 1] }}
                onClick={(event) => event.stopPropagation()}
              >
                {sidebar}
              </motion.aside>
            </motion.div>
          ) : null}
        </AnimatePresence>

        <AnimatePresence>
          {browseViewer && browseDrive && browseFile ? (
            <Viewer name={browseFile.name} onClose={() => setBrowseViewer(false)}>
              <FilePreview name={browseFile.name} kind={browseFile.kind} src={client.driveMediaUrl(browseDrive.id, browseFile.relativePath)} fit="viewer" />
            </Viewer>
          ) : viewer && detail?.file.id === viewer ? (
            <Viewer name={detail.file.name} onClose={() => setViewer(null)}>
              <FilePreview name={detail.file.name} kind={detail.file.kind} src={client.mediaUrl(detail.file.id)} fit="viewer" />
            </Viewer>
          ) : null}
        </AnimatePresence>

        <AnimatePresence>
          {adding ? (
            <AddPlaceDialog
              phones={phones}
              onClose={() => setAdding(false)}
              onPhone={(volume) => void openPicker(volume)}
              onPickFolder={pickFolder}
              onAdd={(input) => void onAddPlace(input)}
            />
          ) : null}
        </AnimatePresence>

        <AnimatePresence>
          {showWelcome ? <Welcome key={welcomeKey} onDone={finishWelcome} /> : null}
        </AnimatePresence>

        <div className="toast-zone" aria-live="polite">
          <AnimatePresence>
            {toast ? (
              <motion.div
                key={toast.id}
                className="toast"
                initial={{ opacity: 0, transform: "translateY(16px) scale(0.96)" }}
                animate={{ opacity: 1, transform: "translateY(0px) scale(1)" }}
                exit={{ opacity: 0, transform: "translateY(8px) scale(0.98)", transition: { duration: 0.15 } }}
                transition={{ type: "spring", duration: 0.4, bounce: 0.2 }}
              >
                <Icon name="check" size={15} />
                {toast.text}
              </motion.div>
            ) : null}
          </AnimatePresence>
        </div>

      <WindowControls />
      {import.meta.env.DEV && import.meta.env.VITE_MEMORIES_DEMO === "true" && !new URLSearchParams(window.location.search).has("live") ? (
        <div className="demo-flag" aria-hidden="true">
          Sample data
        </div>
      ) : null}
    </div>
    </MotionConfig>
  );
}
