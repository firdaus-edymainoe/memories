import type { FileKind } from "@memories/core";
import { motion } from "motion/react";
import { memo, useEffect, useState, type CSSProperties } from "react";
import { extLabel, FAMILY, familyOf, type Family } from "./files.js";

function Landscape() {
  return (
    <svg className="landscape" viewBox="0 0 80 60" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
      <rect width="80" height="60" fill="var(--scene-sky)" />
      <circle cx="58" cy="17" r="7" fill="var(--scene-sun)" />
      <path d="M0 42l18-13 14 10 16-17 32 22v16H0z" fill="var(--scene-hill)" />
      <path d="M0 50l22-8 12 6 20-13 26 12v13H0z" fill="var(--scene-hill-2)" />
    </svg>
  );
}

function Photo({ src, alt }: { src: string | null; alt: string }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);
  if (!src || failed) return <Landscape />;
  return <img src={src} alt={alt} loading="lazy" decoding="async" draggable={false} onError={() => setFailed(true)} />;
}

export function FileObject({
  name,
  kind,
  src,
  directory = false,
  mini = false,
}: {
  name: string;
  kind: FileKind | null;
  src?: string | null | undefined;
  directory?: boolean | undefined;
  mini?: boolean | undefined;
}) {
  const family: Family | "folder" = directory ? "folder" : familyOf(name, kind);
  const style = family === "folder" ? undefined : ({ "--tint": FAMILY[family].tint } as CSSProperties);
  const cls = `obj${mini ? " mini" : ""}`;

  if (family === "folder") {
    return (
      <span className={`${cls} folder`} aria-hidden="true">
        <span className="folder-back" />
        <span className="folder-paper" />
        <span className="folder-front" />
      </span>
    );
  }
  if (family === "photo" || family === "video") {
    return (
      <span className={`${cls} print${family === "video" ? " is-video" : ""}`} style={style} aria-hidden="true">
        <span className="print-img">
          <Photo src={family === "photo" ? (src ?? null) : null} alt="" />
        </span>
        {family === "video" ? (
          <span className="play">
            <svg viewBox="0 0 24 24">
              <path d="M9 7l8 5-8 5z" fill="currentColor" />
            </svg>
          </span>
        ) : null}
      </span>
    );
  }
  if (family === "installer") {
    return (
      <span className={`${cls} parcel`} style={style} aria-hidden="true">
        <span className="parcel-lid" />
        <span className="parcel-tape" />
        <span className="parcel-label">{extLabel(name)}</span>
      </span>
    );
  }
  if (family === "archive") {
    return (
      <span className={`${cls} box`} style={style} aria-hidden="true">
        <span className="box-zip" />
        <span className="parcel-label">{extLabel(name)}</span>
      </span>
    );
  }
  if (family === "music") {
    return (
      <span className={`${cls} record`} style={style} aria-hidden="true">
        <span className="record-disc">
          <span className="record-label" />
        </span>
      </span>
    );
  }
  if (family === "code") {
    return (
      <span className={`${cls} card`} style={style} aria-hidden="true">
        <span className="card-glyph">{"</>"}</span>
        <span className="lines" />
        <span className="card-ext">{extLabel(name)}</span>
      </span>
    );
  }
  return (
    <span className={`${cls} sheet`} data-variant={family} style={style} aria-hidden="true">
      <span className="sheet-tab">{extLabel(name)}</span>
      <span className="lines" />
    </span>
  );
}

type TileProps = {
  id: string;
  name: string;
  kind: FileKind | null;
  src?: string | null | undefined;
  meta?: string | undefined;
  directory?: boolean | undefined;
  selected?: boolean | undefined;
  layoutGroup?: boolean | undefined;
  index?: number;
  view: "tiles" | "list";
  label?: string | undefined;
  onSelect: () => void;
  onOpen?: () => void;
};

export const Tile = memo(function Tile({
  id,
  name,
  kind,
  src,
  meta,
  directory,
  selected,
  layoutGroup,
  index = 0,
  view,
  label,
  onSelect,
  onOpen,
}: TileProps) {
  return (
    <motion.button
      type="button"
      {...(layoutGroup ? { layoutId: id, layout: "position" as const } : {})}
      initial={{ opacity: 0, transform: "translateY(8px) scale(0.98)" }}
      animate={{ opacity: 1, transform: "translateY(0px) scale(1)" }}
      transition={{
        opacity: { duration: 0.25, delay: Math.min(index, 16) * 0.018 },
        transform: { type: "spring", duration: 0.45, bounce: 0.15, delay: Math.min(index, 16) * 0.018 },
        layout: { type: "spring", duration: 0.55, bounce: 0.12 },
      }}
      className={`tile ${view}${selected ? " selected" : ""}`}
      aria-label={label}
      aria-pressed={selected}
      onClick={onSelect}
      onDoubleClick={onOpen}
      onKeyDown={(event) => {
        if (event.key === "Enter" && onOpen) {
          event.preventDefault();
          onOpen();
        }
      }}
    >
      <span className="tile-art">
        <FileObject name={name} kind={kind} src={src} directory={directory} mini={view === "list"} />
      </span>
      <span className="tile-text">
        <span className="tile-name">{name}</span>
        {meta ? <span className="tile-meta">{meta}</span> : null}
      </span>
    </motion.button>
  );
});
