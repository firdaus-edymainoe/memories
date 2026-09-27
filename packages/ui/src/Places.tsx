import type { DirEntry, Drive, DriveKind, VolumePresence } from "@memories/core";
import { AnimatePresence, LayoutGroup, motion } from "motion/react";
import { useMemo, useState } from "react";
import { FAMILY, familyOf, formatSize, pathLeaf, PLACE_KIND, placeStatus, placeWhere, plural, SHELF, SHELF_ORDER, shelfOf } from "./files.js";
import { Icon } from "./icons.js";
import { FolderWait } from "./Preview.js";
import { Tile } from "./Tile.js";

export type BrowseLens = "folders" | "type";

const spring = { type: "spring", duration: 0.45, bounce: 0.15 } as const;

export function PlacesHome({
  drives,
  phones,
  onOpen,
  onAdd,
  onPhone,
  onBackup,
}: {
  drives: Drive[];
  phones: VolumePresence[];
  onOpen: (drive: Drive) => void;
  onAdd: () => void;
  onPhone: (volume: VolumePresence) => void;
  onBackup: (drive: Drive) => void;
}) {
  return (
    <div className="pad places">
      <div className="page-head">
        <div>
          <h1>Places</h1>
          <p>The folders Memories looks after. Your files always stay where they are.</p>
        </div>
        {drives.length ? (
          <button type="button" className="btn btn-primary" onClick={onAdd}>
            <Icon name="plus" size={16} /> Add a place
          </button>
        ) : null}
      </div>

      <AnimatePresence>
        {phones.map((volume) => (
          <motion.div
            key={volume.volumeId}
            className="notice"
            initial={{ opacity: 0, height: 0, marginBottom: 0 }}
            animate={{ opacity: 1, height: "auto", marginBottom: 16 }}
            exit={{ opacity: 0, height: 0, marginBottom: 0 }}
            transition={spring}
          >
            <div className="notice-in">
              <span className="notice-icon pulse">
                <Icon name="phone" size={22} />
              </span>
              <div>
                <strong>{volume.label} is plugged in</strong>
                <p>Pick the folder you’d like Memories to look after, like Camera.</p>
              </div>
              <button type="button" className="btn btn-primary" onClick={() => onPhone(volume)}>
                Choose a folder on {volume.label}
              </button>
            </div>
          </motion.div>
        ))}
      </AnimatePresence>

      {drives.length ? (
        <div className="place-grid">
          {drives.map((drive, i) => (
            <motion.div
              key={drive.id}
              className={`place-card${drive.online ? "" : " off"}`}
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ ...spring, delay: i * 0.04 }}
            >
              <button type="button" className="place-main" onClick={() => onOpen(drive)} aria-label={`Open ${drive.name}`}>
                <span className="place-icon">
                  <Icon name={drive.kind} size={26} />
                </span>
                <span className="place-text">
                  <strong>{drive.name}</strong>
                  <span className="place-where">{placeWhere(drive)}</span>
                </span>
              </button>
              <div className="place-foot">
                <span className={`status${drive.online ? " on" : ""}`}>
                  <i />
                  {placeStatus(drive)}
                </span>
                <button type="button" className="link" onClick={() => onBackup(drive)}>
                  Back up
                </button>
              </div>
            </motion.div>
          ))}
          <motion.button
            type="button"
            className="place-card add"
            onClick={onAdd}
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ ...spring, delay: drives.length * 0.04 }}
          >
            <Icon name="plus" size={22} />
            <span>Add another place</span>
          </motion.button>
        </div>
      ) : !phones.length ? (
        <div className="empty">
          <div className="empty-art big">
            <Icon name="place" size={34} />
          </div>
          <h2>No places yet</h2>
          <p>A place is a folder Memories looks after, like Pictures on this computer or Camera on your phone.</p>
          <button type="button" className="btn btn-primary" onClick={onAdd}>
            <Icon name="plus" size={16} /> Add a place
          </button>
        </div>
      ) : null}
    </div>
  );
}

export function PlaceBrowser({
  title,
  path,
  entries,
  busy,
  adding,
  error,
  lens,
  selected,
  thumbUrl,
  picking,
  onEnter,
  onSelect,
  onOpen,
  onUse,
}: {
  title: string;
  path: string;
  entries: DirEntry[];
  busy: boolean;
  adding: boolean;
  error: string | null;
  lens: BrowseLens;
  selected: string | null;
  thumbUrl: ((entry: DirEntry) => string | null) | null;
  picking: boolean;
  onEnter: (entry: DirEntry) => void;
  onSelect: (entry: DirEntry) => void;
  onOpen: (entry: DirEntry) => void;
  onUse: () => void;
}) {
  const groups = useMemo(() => {
    const folders = entries.filter((entry) => entry.directory);
    const files = entries.filter((entry) => !entry.directory);
    if (lens === "folders") return [{ key: "all", title: "", items: [...folders, ...files] }];
    const map = new Map<string, DirEntry[]>();
    for (const file of files) {
      const shelf = shelfOf(file.name, file.kind);
      map.set(shelf, [...(map.get(shelf) ?? []), file]);
    }
    return [
      ...(folders.length ? [{ key: "folders", title: "Folders", items: folders }] : []),
      ...SHELF_ORDER.filter((shelf) => map.has(shelf)).map((shelf) => ({ key: shelf, title: SHELF[shelf].label, items: map.get(shelf)! })),
    ];
  }, [entries, lens]);

  const name = path ? pathLeaf(path) : title;

  return (
    <div className="pad browse">
      <div className="page-head">
        <div>
          <h1>{name}</h1>
          <p>
            {picking
              ? "Open folders until you find the one you want, then add it. Nothing gets moved."
              : busy
                ? " "
                : plural(entries.length, "item")}
          </p>
        </div>
        {picking ? (
          <button type="button" className="btn btn-primary" disabled={busy} onClick={onUse}>
            <Icon name="check" size={16} /> Add this folder
          </button>
        ) : null}
      </div>
      <div className="browse-body">
        {busy && !adding ? (
          <FolderWait name={name} mode="open" />
        ) : error ? (
          <div className="empty small">
            <div className="empty-art">
              <Icon name="folder" size={28} />
            </div>
            <h2>This folder didn’t open</h2>
            <p>{error}</p>
            <p className="hint">If it’s a phone, unlock it and choose “File transfer”, then try again.</p>
          </div>
        ) : !entries.length ? (
          <div className="empty small">
            <div className="empty-art">
              <Icon name="folder" size={28} />
            </div>
            <h2>This folder is empty</h2>
            <p>{picking ? "You can still add it, or go back and pick another." : "Nothing in here yet."}</p>
          </div>
        ) : (
          <LayoutGroup id="browse">
            <div className="trays tiles">
              {groups.map((group) => (
                <section className="tray" key={`${lens}-${group.key}`}>
                  {group.title ? (
                    <header className="tray-head">
                      <div className="tray-title static">
                        <h2>{group.title}</h2>
                        <span className="tray-count">{group.items.length}</span>
                      </div>
                    </header>
                  ) : null}
                  <div className="tray-grid">
                    {group.items.map((entry, index) => (
                      <Tile
                        key={entry.relativePath}
                        id={`b-${entry.relativePath}`}
                        name={entry.name}
                        kind={entry.kind}
                        directory={entry.directory}
                        src={!entry.directory && thumbUrl && familyOf(entry.name, entry.kind) === "photo" ? thumbUrl(entry) : null}
                        meta={entry.directory ? "Folder" : `${FAMILY[familyOf(entry.name, entry.kind)].one}${entry.size ? `, ${formatSize(entry.size)}` : ""}`}
                        selected={selected === entry.relativePath}
                        layoutGroup={entries.length <= 200}
                        index={index}
                        view="tiles"
                        onSelect={() => (entry.directory ? onEnter(entry) : onSelect(entry))}
                        onOpen={() => (entry.directory ? onEnter(entry) : onOpen(entry))}
                      />
                    ))}
                  </div>
                </section>
              ))}
            </div>
          </LayoutGroup>
        )}
        {busy && adding ? <FolderWait name={name} mode="add" /> : null}
      </div>
    </div>
  );
}

export function AddPlaceDialog({
  phones,
  onClose,
  onPhone,
  onPickFolder,
  onAdd,
}: {
  phones: VolumePresence[];
  onClose: () => void;
  onPhone: (volume: VolumePresence) => void;
  onPickFolder: () => Promise<string | null>;
  onAdd: (input: { name: string; kind: DriveKind; rootPath: string }) => void;
}) {
  const [kind, setKind] = useState<DriveKind | null>(null);
  const [path, setPath] = useState("");
  const [name, setName] = useState("");
  const [typing, setTyping] = useState(false);

  const choose = async () => {
    const picked = await onPickFolder();
    if (picked) {
      setPath(picked);
      if (!name) setName(pathLeaf(picked));
    } else setTyping(true);
  };

  return (
    <Dialog onClose={onClose} labelledBy="add-title">
      <AnimatePresence mode="wait" initial={false}>
        {!kind ? (
          <motion.div key="kind" initial={{ opacity: 0, x: -16 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -16 }} transition={{ duration: 0.2 }}>
            <h2 id="add-title">Add a place</h2>
            <p className="dialog-lede">Where are the files you’d like Memories to look after?</p>
            <div className="kind-grid">
              {(Object.keys(PLACE_KIND) as DriveKind[]).map((value) => (
                <button
                  key={value}
                  type="button"
                  className="kind"
                  onClick={() => {
                    setKind(value);
                    if (value !== "phone" && !name) setName(PLACE_KIND[value].label);
                  }}
                >
                  <span className="kind-icon">
                    <Icon name={value} size={26} />
                  </span>
                  <strong>{PLACE_KIND[value].label}</strong>
                  <span>{PLACE_KIND[value].hint}</span>
                  {value === "phone" && phones.length ? <em className="kind-badge">Plugged in</em> : null}
                </button>
              ))}
            </div>
          </motion.div>
        ) : kind === "phone" ? (
          <motion.div key="phone" initial={{ opacity: 0, x: 16 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: 16 }} transition={{ duration: 0.2 }}>
            <button type="button" className="back-link" onClick={() => setKind(null)}>
              <Icon name="back" size={16} /> Back
            </button>
            <h2 id="add-title">Add your phone</h2>
            {phones.length ? (
              <>
                <p className="dialog-lede">Great, we can see it. Choose the folder you’d like to add.</p>
                <div className="stack">
                  {phones.map((volume) => (
                    <button key={volume.volumeId} type="button" className="pick" onClick={() => onPhone(volume)}>
                      <span className="pick-icon">
                        <Icon name="phone" size={20} />
                      </span>
                      <span className="pick-text">
                        <strong>{volume.label}</strong>
                        <span>Choose a folder on this phone</span>
                      </span>
                      <Icon name="chevron" size={16} />
                    </button>
                  ))}
                </div>
              </>
            ) : (
              <>
                <p className="dialog-lede">We can’t see a phone yet. Three quick steps:</p>
                <ol className="howto">
                  <li>
                    <b>1</b>Plug your phone into this computer with its cable.
                  </li>
                  <li>
                    <b>2</b>Unlock the phone.
                  </li>
                  <li>
                    <b>3</b>When it asks what the cable is for, tap <strong>File transfer</strong>.
                  </li>
                </ol>
                <p className="hint">It will show up here by itself. If a Mac opens “Android File Transfer”, close it first.</p>
                <div className="waiting-dots" aria-label="Waiting for a phone">
                  <i />
                  <i />
                  <i />
                </div>
              </>
            )}
          </motion.div>
        ) : (
          <motion.div key="folder" initial={{ opacity: 0, x: 16 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: 16 }} transition={{ duration: 0.2 }}>
            <button type="button" className="back-link" onClick={() => setKind(null)}>
              <Icon name="back" size={16} /> Back
            </button>
            <h2 id="add-title">Choose a folder</h2>
            <p className="dialog-lede">
              {kind === "computer" ? "Pictures, Documents or Downloads are good places to start." : `Plug in the ${PLACE_KIND[kind].label.toLowerCase()} first, then pick a folder on it.`}
            </p>
            <button type="button" className={`folder-pick${path ? " chosen" : ""}`} onClick={() => void choose()}>
              <span className="folder-pick-icon">
                <Icon name="folder" size={22} />
              </span>
              <span className="pick-text">
                <strong>{path ? pathLeaf(path) : "Choose folder…"}</strong>
                <span>{path || "Opens your computer’s folder picker"}</span>
              </span>
            </button>
            {typing ? (
              <label className="field">
                <span>Folder location</span>
                <input value={path} placeholder="/Users/you/Pictures" onChange={(event) => setPath(event.target.value)} />
              </label>
            ) : null}
            <label className="field">
              <span>Call it</span>
              <input value={name} onChange={(event) => setName(event.target.value)} />
            </label>
            <div className="dialog-actions">
              <button type="button" className="btn btn-quiet" onClick={onClose}>
                Cancel
              </button>
              <button type="button" className="btn btn-primary" disabled={!path || !name.trim()} onClick={() => onAdd({ name: name.trim(), kind, rootPath: path })}>
                Add place
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </Dialog>
  );
}

export function Dialog({ onClose, labelledBy, children }: { onClose: () => void; labelledBy: string; children: React.ReactNode }) {
  return (
    <motion.div
      className="dialog-bg"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0, transition: { duration: 0.18 } }}
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
      onKeyDown={(event) => event.key === "Escape" && onClose()}
    >
      <motion.div
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        initial={{ opacity: 0, transform: "translateY(16px) scale(0.97)" }}
        animate={{ opacity: 1, transform: "translateY(0px) scale(1)" }}
        exit={{ opacity: 0, transform: "translateY(8px) scale(0.98)", transition: { duration: 0.15 } }}
        transition={{ type: "spring", duration: 0.45, bounce: 0.15 }}
      >
        <button type="button" className="icon-btn dialog-close" aria-label="Close dialog" onClick={onClose}>
          <Icon name="close" size={16} />
        </button>
        {children}
      </motion.div>
    </motion.div>
  );
}
