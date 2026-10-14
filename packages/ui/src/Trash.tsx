import type { LibraryFile } from "@memories/core";
import { AnimatePresence, motion } from "motion/react";
import { plural, whenLabel } from "./files.js";
import { Icon } from "./icons.js";
import { Dialog } from "./Places.js";
import { kindLine } from "./Preview.js";
import { FileObject } from "./Tile.js";

const spring = { type: "spring", duration: 0.45, bounce: 0.15 } as const;

export function TrashHome({
  files,
  busy,
  thumbUrl,
  onRestore,
  onDelete,
  onEmpty,
}: {
  files: LibraryFile[];
  busy: boolean;
  thumbUrl: (id: string) => string;
  onRestore: (file: LibraryFile) => void;
  onDelete: (file: LibraryFile) => void;
  onEmpty: () => void;
}) {
  return (
    <div className="pad trash">
      <div className="page-head">
        <div>
          <h1>Trash</h1>
          <p>Files you remove wait here, so nothing goes by accident. Restore them, or delete them for good.</p>
        </div>
        {files.length ? (
          <button type="button" className="btn btn-quiet danger" disabled={busy} onClick={onEmpty}>
            <Icon name="trash" size={16} /> Empty Trash
          </button>
        ) : null}
      </div>
      {files.length ? (
        <>
          <p className="trash-note">Deleting for good removes the file from every place it’s kept, including spare copies.</p>
          <div className="trash-list">
            <AnimatePresence initial={false}>
              {files.map((file, i) => (
                <motion.article
                  key={file.id}
                  className="trash-row"
                  layout
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, x: -16, transition: { duration: 0.15 } }}
                  transition={{ ...spring, delay: Math.min(i, 12) * 0.02 }}
                >
                  <span className="tile-art">
                    <FileObject name={file.name} kind={file.kind} src={thumbUrl(file.id)} mini />
                  </span>
                  <span className="pick-text">
                    <strong>{file.name}</strong>
                    <span>
                      {kindLine(file.name, file.kind)} · Removed {whenLabel(file.trashedAt ?? null).toLowerCase()}
                    </span>
                  </span>
                  <span className="trash-actions">
                    <button type="button" className="btn btn-soft" disabled={busy} onClick={() => onRestore(file)}>
                      <Icon name="restore" size={16} /> Restore
                    </button>
                    <button
                      type="button"
                      className="btn btn-quiet danger"
                      aria-label={`Delete ${file.name} for good`}
                      disabled={busy}
                      onClick={() => onDelete(file)}
                    >
                      Delete
                    </button>
                  </span>
                </motion.article>
              ))}
            </AnimatePresence>
          </div>
        </>
      ) : (
        <div className="empty">
          <div className="empty-art big">
            <Icon name="trash" size={32} />
          </div>
          <h2>Trash is empty</h2>
          <p>When you remove a file from Memories, it waits here first. Nothing is deleted until you say so.</p>
        </div>
      )}
    </div>
  );
}

/** Asks before deleting for good, and says exactly what will happen. */
export function DeleteDialog({
  files,
  onClose,
  onConfirm,
}: {
  files: LibraryFile[];
  onClose: () => void;
  onConfirm: () => void;
}) {
  const what = files.length === 1 ? `“${files[0]!.name}”` : plural(files.length, "file");
  return (
    <Dialog onClose={onClose} labelledBy="delete-title">
      <h2 id="delete-title">Delete {what} for good?</h2>
      <p className="dialog-lede">
        {files.length === 1 ? "It" : "They"} will be deleted from every place {files.length === 1 ? "it’s" : "they’re"} kept, including spare
        copies on other drives. Drives that aren’t plugged in are cleared the next time you connect them. This can’t be undone.
      </p>
      <div className="dialog-actions">
        <button type="button" className="btn btn-quiet" onClick={onClose}>
          Cancel
        </button>
        <button type="button" className="btn btn-danger" onClick={onConfirm}>
          <Icon name="trash" size={16} /> Delete for good
        </button>
      </div>
    </Dialog>
  );
}
