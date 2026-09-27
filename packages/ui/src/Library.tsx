import type { EventCluster, LibraryFile } from "@memories/core";
import { LayoutGroup, motion } from "motion/react";
import { useMemo, useState } from "react";
import {
  dayKey,
  dayLabel,
  FAMILY,
  familyOf,
  monthKey,
  monthLabel,
  plural,
  SHELF,
  SHELF_ORDER,
  shelfOf,
  shortDate,
  type Family,
  type Shelf,
} from "./files.js";
import { Icon } from "./icons.js";
import { Tile } from "./Tile.js";

export type Lens = "type" | "date" | "moments";
export type Scope = { shelf?: Shelf; family?: Family; month?: string; day?: string; inbox?: boolean };

type Section = { key: string; title: string; items: LibraryFile[] };
type Group = {
  key: string;
  title: string;
  subtitle?: string | undefined;
  items: LibraryFile[];
  sections?: Section[] | undefined;
  drill?: Scope | undefined;
};

const PEEK = 18;
const PAGE = 240;
const LAYOUT_LIMIT = 260;
const DOC_FAMILIES = SHELF.documents.families;

export function inScope(file: LibraryFile, scope: Scope, search: string) {
  if (scope.inbox && !file.inbox) return false;
  if (scope.family && familyOf(file.name, file.kind) !== scope.family) return false;
  if (!scope.family && scope.shelf && shelfOf(file.name, file.kind) !== scope.shelf) return false;
  if (scope.day && dayKey(file.takenAt) !== scope.day) return false;
  if (!scope.day && scope.month && monthKey(file.takenAt) !== scope.month) return false;
  if (search && !file.name.toLowerCase().includes(search.toLowerCase())) return false;
  return true;
}

export function scopeTitle(scope: Scope) {
  const what = scope.family ? FAMILY[scope.family].label : scope.shelf ? SHELF[scope.shelf].label : null;
  const when = scope.day ? dayLabel(scope.day) : scope.month ? monthLabel(scope.month) : null;
  const base = scope.inbox ? "New" : null;
  if (base && what) return `New ${what.toLowerCase()}`;
  if (what && when) return `${what} from ${when}`;
  return what ?? when ?? base ?? "Everything";
}

function byDateDesc(a: string, b: string) {
  if (a === "undated") return 1;
  if (b === "undated") return -1;
  return a < b ? 1 : -1;
}

function sortByDateDesc(files: LibraryFile[]) {
  return [...files].sort((a, b) => {
    const ak = a.takenAt ?? "";
    const bk = b.takenAt ?? "";
    if (!ak && bk) return 1;
    if (ak && !bk) return -1;
    if (ak === bk) return a.name.localeCompare(b.name);
    return ak < bk ? 1 : -1;
  });
}

function sectionsByMonth(files: LibraryFile[]): Section[] {
  const map = new Map<string, LibraryFile[]>();
  for (const file of sortByDateDesc(files)) {
    const key = monthKey(file.takenAt);
    map.set(key, [...(map.get(key) ?? []), file]);
  }
  return [...map.entries()]
    .sort(([a], [b]) => byDateDesc(a, b))
    .map(([key, items]) => ({ key, title: monthLabel(key), items }));
}

function sectionsByFamily(files: LibraryFile[]): Section[] {
  const map = new Map<Family, LibraryFile[]>();
  for (const file of files) {
    const family = familyOf(file.name, file.kind);
    map.set(family, [...(map.get(family) ?? []), file]);
  }
  return DOC_FAMILIES.filter((family) => map.has(family)).map((family) => ({
    key: family,
    title: FAMILY[family].label,
    items: sortByDateDesc(map.get(family)!),
  }));
}

function withOptionalSections(group: Group, sections: Section[]): Group {
  if (sections.length <= 1) return { ...group, items: sortByDateDesc(group.items) };
  return { ...group, items: sections.flatMap((section) => section.items), sections };
}

function isDocumentsScope(scope: Scope) {
  return scope.shelf === "documents" || (!!scope.family && FAMILY[scope.family].shelf === "documents");
}

function buildGroups(files: LibraryFile[], lens: Lens, scope: Scope, events: EventCluster[]): Group[] {
  if (lens === "moments") {
    const ids = new Map(files.map((file) => [file.id, file]));
    return events
      .map((cluster) => ({
        key: `${cluster.day}-${cluster.place ?? ""}`,
        title: dayLabel(cluster.day),
        subtitle: cluster.place ? `in ${cluster.place}` : undefined,
        items: cluster.fileIds.map((id) => ids.get(id)).filter((file): file is LibraryFile => !!file),
        drill: { day: cluster.day },
      }))
      .filter((group) => group.items.length)
      .sort((a, b) => byDateDesc(a.key, b.key));
  }

  const docs = isDocumentsScope(scope);

  if (lens === "date") {
    // Inside Documents: date first, then format (PDF / Word / …) within each period.
    if (docs && !scope.family) {
      const perDay = !!scope.month || !!scope.day;
      const map = new Map<string, LibraryFile[]>();
      for (const file of files) {
        const key = perDay ? dayKey(file.takenAt) : monthKey(file.takenAt);
        map.set(key, [...(map.get(key) ?? []), file]);
      }
      return [...map.entries()]
        .sort(([a], [b]) => byDateDesc(a, b))
        .map(([key, items]) =>
          withOptionalSections(
            {
              key,
              title: perDay ? dayLabel(key) : monthLabel(key),
              items,
              drill: scope.day || key === "undated" ? undefined : perDay ? { day: key } : { month: key },
            },
            sectionsByFamily(items),
          ),
        );
    }

    const perDay = !!scope.month || !!scope.day;
    const map = new Map<string, LibraryFile[]>();
    for (const file of files) {
      const key = perDay ? dayKey(file.takenAt) : monthKey(file.takenAt);
      map.set(key, [...(map.get(key) ?? []), file]);
    }
    return [...map.entries()]
      .sort(([a], [b]) => byDateDesc(a, b))
      .map(([key, items]) => ({
        key,
        title: perDay ? dayLabel(key) : monthLabel(key),
        items: docs ? sortByDateDesc(items) : items,
        drill: scope.day || key === "undated" ? undefined : perDay ? { day: key } : { month: key },
      }));
  }

  // Type lens inside Documents: format first, then date within each format.
  if (docs && scope.shelf === "documents" && !scope.family) {
    const map = new Map<Family, LibraryFile[]>();
    for (const file of files) {
      const family = familyOf(file.name, file.kind);
      map.set(family, [...(map.get(family) ?? []), file]);
    }
    return DOC_FAMILIES.filter((family) => map.has(family)).map((family) => {
      const items = map.get(family)!;
      return withOptionalSections(
        {
          key: family,
          title: FAMILY[family].label,
          items,
          drill: { family },
        },
        sectionsByMonth(items),
      );
    });
  }

  // One document format: still prefer date trays so Type/Date both help.
  if (docs && scope.family) {
    const perDay = !!scope.month || !!scope.day;
    const map = new Map<string, LibraryFile[]>();
    for (const file of files) {
      const key = perDay ? dayKey(file.takenAt) : monthKey(file.takenAt);
      map.set(key, [...(map.get(key) ?? []), file]);
    }
    return [...map.entries()]
      .sort(([a], [b]) => byDateDesc(a, b))
      .map(([key, items]) => ({
        key,
        title: perDay ? dayLabel(key) : monthLabel(key),
        items: sortByDateDesc(items),
        drill: scope.day || key === "undated" ? undefined : perDay ? { day: key } : { month: key },
      }));
  }

  const splitFamilies = !!scope.shelf && !scope.family && SHELF[scope.shelf].families.length > 1;
  if (splitFamilies || scope.family) {
    const map = new Map<Family, LibraryFile[]>();
    for (const file of files) {
      const family = familyOf(file.name, file.kind);
      map.set(family, [...(map.get(family) ?? []), file]);
    }
    return [...map.entries()].map(([family, items]) => ({
      key: family,
      title: FAMILY[family].label,
      items,
      drill: scope.family ? undefined : { family },
    }));
  }

  const map = new Map<Shelf, LibraryFile[]>();
  for (const file of files) {
    const shelf = shelfOf(file.name, file.kind);
    map.set(shelf, [...(map.get(shelf) ?? []), file]);
  }
  return SHELF_ORDER.filter((shelf) => map.has(shelf)).map((shelf) => ({
    key: shelf,
    title: SHELF[shelf].label,
    items: map.get(shelf)!,
    drill: scope.shelf ? undefined : { shelf },
  }));
}

function takeForCap(group: Group, cap: number) {
  if (!group.sections?.length) {
    const items = group.items.slice(0, cap);
    return { sections: null as Section[] | null, items, more: group.items.length - items.length };
  }
  const sections: Section[] = [];
  let left = cap;
  let total = 0;
  for (const section of group.sections) {
    total += section.items.length;
    if (left <= 0) continue;
    const items = section.items.slice(0, left);
    if (items.length) sections.push({ ...section, items });
    left -= items.length;
  }
  return { sections, items: sections.flatMap((section) => section.items), more: Math.max(0, total - cap) };
}

export function Library({
  files,
  events,
  lens,
  scope,
  search,
  view,
  selected,
  mediaUrl,
  onDrill,
  onSelect,
  onOpen,
  empty,
}: {
  files: LibraryFile[];
  events: EventCluster[];
  lens: Lens;
  scope: Scope;
  search: string;
  view: "tiles" | "list";
  selected: string | null;
  mediaUrl: (id: string) => string;
  onDrill: (next: Scope) => void;
  onSelect: (id: string) => void;
  onOpen: (id: string) => void;
  empty: React.ReactNode;
}) {
  const [limit, setLimit] = useState(PAGE);
  const visible = useMemo(() => files.filter((file) => inScope(file, scope, search)), [files, scope, search]);
  const groups = useMemo(() => buildGroups(visible, lens, scope, events), [visible, lens, scope, events]);
  const single = groups.length === 1;
  const animateLayout = visible.length <= LAYOUT_LIMIT;
  const docs = isDocumentsScope(scope);

  if (!files.length) return <>{empty}</>;

  if (!groups.length) {
    return (
      <div className="empty small">
        <div className="empty-art">
          <Icon name={search ? "search" : lens === "moments" ? "moments" : "sparkle"} size={28} />
        </div>
        <h2>{search ? `Nothing called “${search}”` : lens === "moments" ? "No moments here yet" : "Nothing here yet"}</h2>
        <p>
          {search
            ? "Try a shorter word, or clear the search."
            : lens === "moments"
              ? "Moments gather photos and videos taken on the same day. Try Type or Date instead."
              : "Try going back a step, or switch between Type and Date."}
        </p>
      </div>
    );
  }

  let shown = 0;
  return (
    <LayoutGroup id="library">
      <div className={`trays ${view}`}>
        <div className="library-head">
          <motion.h1 key={scopeTitle(scope)} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.25 }}>
            {scopeTitle(scope)}
          </motion.h1>
          <p>
            {plural(visible.length, "file")}
            {search ? ` matching “${search}”` : ""}
            {docs && !search ? (lens === "type" ? " · by format, then date" : lens === "date" ? " · by date, then format" : "") : ""}
          </p>
        </div>
        {groups.map((group) => {
          const cap = single ? Math.max(0, limit - shown) : PEEK;
          const taken = takeForCap(group, cap);
          shown += taken.items.length;
          const tileMeta = (file: LibraryFile) =>
            lens === "type" || (docs && group.sections) ? shortDate(file.takenAt) || FAMILY[familyOf(file.name, file.kind)].one : FAMILY[familyOf(file.name, file.kind)].one;

          const renderTile = (file: LibraryFile, index: number) => (
            <Tile
              key={file.id}
              id={file.id}
              name={file.name}
              kind={file.kind}
              src={familyOf(file.name, file.kind) === "photo" ? mediaUrl(file.id) : null}
              meta={tileMeta(file)}
              selected={selected === file.id}
              layoutGroup={animateLayout}
              index={index}
              view={view}
              onSelect={() => onSelect(file.id)}
              onOpen={() => onOpen(file.id)}
            />
          );

          return (
            <section className="tray" key={`${lens}-${group.key}`} aria-label={group.title}>
              <header className="tray-head">
                {group.drill ? (
                  <button type="button" className="tray-title" onClick={() => onDrill({ ...scope, ...group.drill })}>
                    <h2>{group.title}</h2>
                    {group.subtitle ? <span className="tray-sub">{group.subtitle}</span> : null}
                    <span className="tray-count">{group.items.length.toLocaleString("en-GB")}</span>
                    <Icon name="chevron" size={16} className="tray-chev" />
                  </button>
                ) : (
                  <div className="tray-title static">
                    <h2>{group.title}</h2>
                    {group.subtitle ? <span className="tray-sub">{group.subtitle}</span> : null}
                    <span className="tray-count">{group.items.length.toLocaleString("en-GB")}</span>
                  </div>
                )}
              </header>
              {taken.sections ? (
                <div className="tray-sections">
                  {taken.sections.map((section) => (
                    <section className="tray-section" key={section.key} aria-label={section.title}>
                      <h3 className="tray-section-title">{section.title}</h3>
                      <div className="tray-grid">{section.items.map((file, index) => renderTile(file, index))}</div>
                    </section>
                  ))}
                </div>
              ) : (
                <div className="tray-grid">{taken.items.map((file, index) => renderTile(file, index))}</div>
              )}
              {taken.more > 0 ? (
                single ? (
                  <button type="button" className="more-tile inline" onClick={() => setLimit((n) => n + PAGE)}>
                    <span>Show {Math.min(taken.more, PAGE).toLocaleString("en-GB")} more</span>
                  </button>
                ) : group.drill ? (
                  <button type="button" className="more-tile inline" onClick={() => onDrill({ ...scope, ...group.drill })}>
                    <span className="more-n">+{taken.more.toLocaleString("en-GB")}</span>
                    <span>See all</span>
                  </button>
                ) : null
              ) : null}
            </section>
          );
        })}
      </div>
    </LayoutGroup>
  );
}
