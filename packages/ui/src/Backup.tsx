import type { BackupJob, DirEntry, Drive } from "@memories/core";
import { AnimatePresence, motion } from "motion/react";
import { friendlySince, pathLeaf, placeStatus, plural } from "./files.js";
import { Icon } from "./icons.js";
import { FolderWait } from "./Preview.js";

const spring = { type: "spring", duration: 0.45, bounce: 0.15 } as const;

export function folderCovered(selected: string[], path: string) {
  return selected.some((folder) => folder === "" || path === folder || path.startsWith(`${folder}/`));
}

export function toggleFolder(selected: string[], path: string) {
  if (selected.includes(path)) return selected.filter((item) => item !== path);
  return [
    ...selected.filter((item) => {
      if (path === "" || item === "") return false;
      if (item.startsWith(`${path}/`) || path.startsWith(`${item}/`)) return false;
      return true;
    }),
    path,
  ];
}

export function folderLabel(path: string, driveName: string) {
  return path ? path.split("/").filter(Boolean).join(" › ") : `All of ${driveName}`;
}

export type BackupResult = { id: string; copied: number; skipped: number };

export function BackupHome({
  jobs,
  drives,
  running,
  result,
  onNew,
  onRun,
}: {
  jobs: BackupJob[];
  drives: Drive[];
  running: string | null;
  result: BackupResult | null;
  onNew: () => void;
  onRun: (id: string) => void;
}) {
  return (
    <div className="pad backup">
      <div className="page-head">
        <div>
          <h1>Backup</h1>
          <p>Keep a spare copy of your folders on another drive. Your originals never move.</p>
        </div>
        {jobs.length ? (
          <button type="button" className="btn btn-primary" onClick={onNew}>
            <Icon name="plus" size={16} /> New backup
          </button>
        ) : null}
      </div>
      {jobs.length ? (
        <div className="stack">
          {jobs.map((job, i) => {
            const source = drives.find((d) => d.id === job.sourceDriveId);
            const dest = drives.find((d) => d.id === job.destDriveId);
            const ready = !!source?.online && !!dest?.online;
            const missing = [source, dest].filter((d) => d && !d.online).map((d) => d!.name);
            const folders =
              !job.sourceRelativePaths.length || job.sourceRelativePaths.every((path) => !path)
                ? `All of ${source?.name ?? "this place"}`
                : job.sourceRelativePaths.map((path) => folderLabel(path, source?.name ?? "")).join(", ");
            const isRunning = running === job.id;
            const done = result?.id === job.id ? result : null;
            return (
              <motion.article
                key={job.id}
                className={`backup-card${isRunning ? " running" : ""}`}
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ ...spring, delay: i * 0.05 }}
              >
                <div className="flow" aria-hidden="true">
                  <span className={`flow-end${source?.online ? " on" : ""}`}>
                    <Icon name={source?.kind ?? "disk"} size={22} />
                  </span>
                  <span className="flow-line">
                    <i />
                  </span>
                  <span className={`flow-end${dest?.online ? " on" : ""}`}>
                    <Icon name={dest?.kind ?? "disk"} size={22} />
                  </span>
                </div>
                <div className="backup-text">
                  <h3>
                    {source?.name ?? "A place"} <span className="to">to</span> {dest?.name ?? "a drive"}
                  </h3>
                  <p>{folders}</p>
                  <AnimatePresence mode="wait" initial={false}>
                    <motion.p
                      key={isRunning ? "run" : done ? "done" : ready ? "ready" : "wait"}
                      className={`backup-state${done ? " ok" : !ready && !isRunning ? " wait" : ""}`}
                      initial={{ opacity: 0, y: 4 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: -4 }}
                      transition={{ duration: 0.18 }}
                    >
                      {isRunning ? (
                        "Copying… you can keep using Memories."
                      ) : done ? (
                        <>
                          <svg className="tick" viewBox="0 0 24 24" aria-hidden="true">
                            <path d="M5 12.5l4.5 4.5L19 7.5" />
                          </svg>
                          {done.copied ? `All done. ${plural(done.copied, "new file")} copied.` : "All done. Everything was already safe."}
                        </>
                      ) : ready ? (
                        friendlySince(job.lastRunAt)
                      ) : (
                        `Plug in ${missing.join(" and ") || "both places"} to back up.`
                      )}
                    </motion.p>
                  </AnimatePresence>
                </div>
                <button type="button" className="btn btn-primary" disabled={!ready || isRunning} onClick={() => onRun(job.id)}>
                  {isRunning ? "Backing up…" : "Back up now"}
                </button>
                {isRunning ? <span className="backup-progress" aria-hidden="true" /> : null}
              </motion.article>
            );
          })}
        </div>
      ) : (
        <div className="empty">
          <div className="empty-art big">
            <Icon name="backup" size={34} />
          </div>
          <h2>No backups yet</h2>
          <p>Pick some folders, like your phone’s Camera, and a drive to keep a spare copy on. We’ll remember your choice for next time.</p>
          <button type="button" className="btn btn-primary" onClick={onNew}>
            <Icon name="plus" size={16} /> New backup
          </button>
        </div>
      )}
    </div>
  );
}

const STEPS = ["What to back up", "Which folders", "Where to keep it"];

export function BackupWizard({
  step,
  drives,
  sourceId,
  destId,
  folders,
  path,
  entries,
  busy,
  error,
  onPickSource,
  onOpenFolder,
  onToggle,
  onPickDest,
  onStep,
  onCancel,
  onSave,
}: {
  step: number;
  drives: Drive[];
  sourceId: string;
  destId: string;
  folders: string[];
  path: string;
  entries: DirEntry[];
  busy: boolean;
  error: string | null;
  onPickSource: (drive: Drive) => void;
  onOpenFolder: (path: string) => void;
  onToggle: (path: string) => void;
  onPickDest: (id: string) => void;
  onStep: (step: number) => void;
  onCancel: () => void;
  onSave: () => void;
}) {
  const source = drives.find((drive) => drive.id === sourceId);
  const canNext = step === 0 ? !!sourceId : step === 1 ? folders.length > 0 : !!destId;
  const crumbs = path.split("/").filter(Boolean);

  return (
    <div className="pad backup">
      <div className="page-head">
        <div>
          <h1>New backup</h1>
        </div>
      </div>
      <ol className="steps">
        {STEPS.map((label, i) => (
          <li key={label} className={i === step ? "on" : i < step ? "done" : ""}>
            <span className="step-dot">
              {i < step ? <Icon name="check" size={12} /> : i + 1}
              {i === step ? <motion.i layoutId="step-ring" transition={spring} /> : null}
            </span>
            {label}
          </li>
        ))}
      </ol>

      <AnimatePresence mode="wait" initial={false}>
        <motion.div
          key={step}
          initial={{ opacity: 0, x: 20 }}
          animate={{ opacity: 1, x: 0 }}
          exit={{ opacity: 0, x: -20 }}
          transition={{ duration: 0.22, ease: [0.23, 1, 0.32, 1] }}
        >
          {step === 0 ? (
            <>
              <p className="lede">Which place has the files you want a spare copy of?</p>
              <div className="stack">
                {drives.map((drive) => (
                  <button
                    key={drive.id}
                    type="button"
                    className={`pick${sourceId === drive.id ? " on" : ""}${drive.online ? "" : " off"}`}
                    onClick={() => onPickSource(drive)}
                  >
                    <span className="pick-icon">
                      <Icon name={drive.kind} size={20} />
                    </span>
                    <span className="pick-text">
                      <strong>{drive.name}</strong>
                      <span>{placeStatus(drive)}</span>
                    </span>
                  </button>
                ))}
              </div>
              {!drives.length ? (
                <div className="empty small">
                  <h2>Add a place first</h2>
                  <p>Backup copies folders from one place onto another, so you’ll need at least two.</p>
                </div>
              ) : null}
            </>
          ) : step === 1 && source ? (
            <>
              <p className="lede">Tick the folders to copy. Open a folder to look inside.</p>
              <nav className="crumbs" aria-label="Folder">
                <button type="button" className={!path ? "cur" : ""} onClick={() => onOpenFolder("")}>
                  {source.name}
                </button>
                {crumbs.map((part, index) => {
                  const rel = crumbs.slice(0, index + 1).join("/");
                  return (
                    <span key={rel} className="crumb">
                      <Icon name="chevron" size={12} />
                      <button type="button" className={index === crumbs.length - 1 ? "cur" : ""} onClick={() => onOpenFolder(rel)}>
                        {part}
                      </button>
                    </span>
                  );
                })}
              </nav>
              {busy ? (
                <FolderWait name={path ? pathLeaf(path) : source.name} mode="open" />
              ) : (
                <div className="stack tight">
                  <CheckRow
                    on={folderCovered(folders, path)}
                    label={path ? pathLeaf(path) : source.name}
                    title="Everything in this folder"
                    sub={folderLabel(path, source.name)}
                    onToggle={() => onToggle(path)}
                  />
                  {entries.map((entry) => {
                    const on = folderCovered(folders, entry.relativePath);
                    return (
                      <CheckRow
                        key={entry.relativePath}
                        on={on}
                        label={entry.name}
                        title={entry.name}
                        sub={on && !folders.includes(entry.relativePath) ? "Included with a folder above" : "Folder"}
                        onToggle={() => onToggle(entry.relativePath)}
                        onOpen={() => onOpenFolder(entry.relativePath)}
                      />
                    );
                  })}
                  {error ? <p className="hint">This folder didn’t open. {error}</p> : !entries.length ? <p className="hint">No folders inside. Tick this folder to copy it.</p> : null}
                </div>
              )}
              <div className="chosen" aria-live="polite">
                <AnimatePresence initial={false}>
                  {folders.map((folder) => (
                    <motion.span
                      key={folder || "root"}
                      layout
                      initial={{ opacity: 0, scale: 0.9 }}
                      animate={{ opacity: 1, scale: 1 }}
                      exit={{ opacity: 0, scale: 0.9 }}
                      transition={spring}
                    >
                      {folderLabel(folder, source.name)}
                    </motion.span>
                  ))}
                </AnimatePresence>
              </div>
            </>
          ) : (
            <>
              <p className="lede">Where should the spare copy go? Your originals stay on {source?.name ?? "the first place"}.</p>
              <div className="stack">
                {drives
                  .filter((drive) => drive.id !== sourceId)
                  .map((drive) => (
                    <button
                      key={drive.id}
                      type="button"
                      className={`pick${destId === drive.id ? " on" : ""}`}
                      onClick={() => onPickDest(drive.id)}
                    >
                      <span className="pick-icon">
                        <Icon name={drive.kind} size={20} />
                      </span>
                      <span className="pick-text">
                        <strong>{drive.name}</strong>
                        <span>{drive.online ? placeStatus(drive) : "Unplugged, that’s fine. We’ll wait for it."}</span>
                      </span>
                    </button>
                  ))}
              </div>
            </>
          )}
        </motion.div>
      </AnimatePresence>

      <div className="wizard-nav">
        <button type="button" className="btn btn-quiet" onClick={onCancel}>
          Cancel
        </button>
        <span className="grow" />
        {step > 0 ? (
          <button type="button" className="btn btn-soft" onClick={() => onStep(step - 1)}>
            Back
          </button>
        ) : null}
        {step < 2 ? (
          <button type="button" className="btn btn-primary" disabled={!canNext} onClick={() => onStep(step + 1)}>
            Continue
          </button>
        ) : (
          <button type="button" className="btn btn-primary" disabled={!canNext} onClick={onSave}>
            Save backup
          </button>
        )}
      </div>
    </div>
  );
}

function CheckRow({
  on,
  label,
  title,
  sub,
  onToggle,
  onOpen,
}: {
  on: boolean;
  label: string;
  title: string;
  sub: string;
  onToggle: () => void;
  onOpen?: () => void;
}) {
  return (
    <div className={`check-row${on ? " on" : ""}`}>
      <button type="button" className="check" aria-pressed={on} aria-label={`Select ${label}`} onClick={onToggle}>
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M5 12.5l4.5 4.5L19 7.5" />
        </svg>
      </button>
      <span className="check-icon">
        <Icon name="folder" size={18} />
      </span>
      <span className="pick-text" onClick={onToggle}>
        <strong>{title}</strong>
        <span>{sub}</span>
      </span>
      {onOpen ? (
        <button type="button" className="open-btn" aria-label={`Open ${label}`} onClick={onOpen}>
          Open <Icon name="chevron" size={14} />
        </button>
      ) : null}
    </div>
  );
}
