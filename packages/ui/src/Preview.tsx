import type { Drive, FileKind } from "@memories/core";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { fileExt, FAMILY, familyOf } from "./files.js";
import { Icon } from "./icons.js";
import { FileObject } from "./Tile.js";

type Mode = "image" | "video" | "audio" | "pdf" | "text" | "file";

function previewMode(name: string, kind: FileKind | null): Mode {
  const family = familyOf(name, kind);
  if (family === "photo") return "image";
  if (family === "video") return "video";
  if (family === "music") return "audio";
  if (family === "pdf") return "pdf";
  if (["txt", "md", "json", "csv", "log"].includes(fileExt(name))) return "text";
  return "file";
}

export function FilePreview({
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
  useEffect(() => setFailed(false), [src]);
  const mode = previewMode(name, kind);
  const still = (
    <div className="still">
      <FileObject name={name} kind={kind} />
      {failed ? <span>This file can’t be shown here. Try Open.</span> : null}
    </div>
  );
  if (!src || mode === "file" || failed) return still;
  if (mode === "image") return <img src={src} alt={fit === "viewer" ? name : ""} onError={() => setFailed(true)} />;
  if (mode === "video") return <video src={src} controls playsInline onError={() => setFailed(true)} />;
  if (mode === "audio") {
    return (
      <div className="still">
        <FileObject name={name} kind={kind} />
        <audio src={src} controls onError={() => setFailed(true)} />
      </div>
    );
  }
  return <iframe title={name} src={src} />;
}

export function Inspector({
  open,
  title,
  onClose,
  children,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <AnimatePresence>
      {open ? (
        <motion.aside
          className="inspector"
          aria-label="Details"
          initial={{ opacity: 0, transform: "translateX(24px)" }}
          animate={{ opacity: 1, transform: "translateX(0px)" }}
          exit={{ opacity: 0, transform: "translateX(24px)", transition: { duration: 0.15 } }}
          transition={{ type: "spring", duration: 0.4, bounce: 0.1 }}
        >
          <div className="insp-head">
            <span>Details</span>
            <button type="button" className="icon-btn" aria-label={`Close details for ${title}`} onClick={onClose}>
              <Icon name="close" size={16} />
            </button>
          </div>
          <motion.div
            key={title}
            className="insp-body"
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.2 }}
          >
            {children}
          </motion.div>
        </motion.aside>
      ) : null}
    </AnimatePresence>
  );
}

export function Facts({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <dl className="facts">
      {rows
        .filter(([, value]) => value !== "" && value !== null && value !== undefined)
        .map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
    </dl>
  );
}

export function kindLine(name: string, kind: FileKind | null) {
  return FAMILY[familyOf(name, kind)].one;
}

export function CopyToMenu({ places, onPick }: { places: Drive[]; onPick: (drive: Drive) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    };
    const esc = (event: KeyboardEvent) => event.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);
  return (
    <div className="menu-wrap" ref={ref}>
      <button type="button" className="btn btn-soft" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <Icon name="copy" size={16} /> Copy to…
      </button>
      <AnimatePresence>
        {open ? (
          <motion.div
            className="menu"
            role="menu"
            initial={{ opacity: 0, transform: "translateY(-4px) scale(0.97)" }}
            animate={{ opacity: 1, transform: "translateY(0px) scale(1)" }}
            exit={{ opacity: 0, transform: "translateY(-4px) scale(0.97)", transition: { duration: 0.12 } }}
            transition={{ duration: 0.18, ease: [0.23, 1, 0.32, 1] }}
          >
            {places.length ? (
              places.map((drive) => (
                <button
                  key={drive.id}
                  type="button"
                  role="menuitem"
                  disabled={!drive.online}
                  onClick={() => {
                    setOpen(false);
                    onPick(drive);
                  }}
                >
                  <Icon name={drive.kind} size={16} />
                  <span>{drive.name}</span>
                  {!drive.online ? <em>Unplugged</em> : null}
                </button>
              ))
            ) : (
              <p>Add another place first, like a USB stick or drive.</p>
            )}
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

export function Viewer({ name, onClose, children }: { name: string; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const esc = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [onClose]);
  return (
    <motion.div
      className="viewer"
      role="dialog"
      aria-label={name}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0, transition: { duration: 0.18 } }}
      transition={{ duration: 0.22 }}
    >
      <div className="viewer-bar">
        <button type="button" className="viewer-back" onClick={onClose}>
          <Icon name="back" size={18} /> Back
        </button>
        <strong>{name}</strong>
      </div>
      <motion.div
        className="viewer-body"
        initial={{ opacity: 0, transform: "scale(0.94)" }}
        animate={{ opacity: 1, transform: "scale(1)" }}
        transition={{ type: "spring", duration: 0.45, bounce: 0.12 }}
      >
        {children}
      </motion.div>
    </motion.div>
  );
}

const WAIT_OPEN = [
  "Phones can take a moment to answer.",
  "Still reading. Big folders take a little while.",
  "Nearly there…",
  "You can look around elsewhere. We’ll keep going.",
];
const WAIT_ADD = [
  "Nothing gets moved. We’re just making a list.",
  "Phones are slower over a cable. Hang on.",
  "Big folders take a while. Maybe put the kettle on.",
  "You can leave this screen. It carries on.",
];

export function FolderWait({ name, mode }: { name: string; mode: "open" | "add" }) {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => setTick((n) => n + 1), 4200);
    return () => window.clearInterval(id);
  }, []);
  const lines = mode === "add" ? WAIT_ADD : WAIT_OPEN;
  const line = lines[Math.min(tick, lines.length - 1)]!;
  return (
    <div className={`folder-wait${mode === "add" ? " overlay" : ""}`} role="status" aria-live="polite" aria-busy="true" data-testid="folder-wait">
      <div className="polaroids" aria-hidden="true">
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
        </div>
      </div>
      <h2>{mode === "add" ? `Getting to know ${name}` : `Opening ${name}`}</h2>
      <AnimatePresence mode="wait">
        <motion.p key={line} initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }}>
          {line}
        </motion.p>
      </AnimatePresence>
    </div>
  );
}
