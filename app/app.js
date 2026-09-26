(() => {
  const D = window.MEMORIES_DATA;

  const state = {
    onboarded: localStorage.getItem("memories-tour") === "1",
    ob: 0,
    screen: "browse",
    view: "type",
    arrange: "date",
    layout: "list",
    folder: null,
    album: null,
    driveFilter: null,
    coverage: "all",
    typeFilter: "photo",
    sort: "name",
    selected: new Set(),
    selectedFolder: null,
    viewer: null,
    sheet: false,
    inspector: true,
    modal: null,
    search: "",
    searchFocus: false,
    toast: null,
    hist: [{ screen: "browse", view: "type", arrange: "date", folder: null, typeFilter: "photo", places: false }],
    histI: 0,
    places: false,
    drawer: false,
    justPlugged: null,
    backupSetup: null,
    theme: localStorage.getItem("memories-theme") || "system",
  };

  function applyTheme(pref) {
    const dark =
      pref === "dark" || (pref !== "light" && window.matchMedia("(prefers-color-scheme: dark)").matches);
    document.documentElement.dataset.theme = dark ? "dark" : "light";
    document.documentElement.style.colorScheme = dark ? "dark" : "light";
  }
  applyTheme(state.theme);
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    if (state.theme === "system") applyTheme("system");
  });

  if (!Array.isArray(D.backups)) D.backups = [];
  try {
    const saved = JSON.parse(localStorage.getItem("memories-backups") || "null");
    if (Array.isArray(saved)) {
      D.backups = saved.map((j) => ({ ...j, status: "idle", lastRun: j.lastRun || null }));
    }
  } catch (e) {
    /* keep seeded jobs */
  }

  const driveById = (id) => D.drives.find((d) => d.id === id);
  const fileById = (id) => D.files.find((f) => f.id === id);
  const folderById = (id) => D.folders.find((f) => f.id === id);

  function coverageOf(file) {
    if (file.locations.some((l) => l.status === "copying")) return "copying";
    if (file.locations.length === 1) return "only";
    return "copied";
  }

  function whereText(file) {
    return file.locations
      .map((l) => {
        const d = driveById(l.drive);
        if (l.status === "copying") return `Copying to ${d.name} ${l.progress}%`;
        return d.online ? d.name : `${d.name} (offline)`;
      })
      .join(", ");
  }

  function kindLabel(file) {
    return { photo: "JPEG image", video: "Movie", document: "PDF document" }[file.type] || "File";
  }

  function esc(s) {
    return String(s)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;");
  }

  function toast(msg) {
    state.toast = msg;
    render();
    setTimeout(() => {
      if (state.toast === msg) {
        state.toast = null;
        render();
      }
    }, 2200);
  }

  function inboxCount() {
    return D.files.filter((f) => f.inbox).length;
  }
  function onlyCount() {
    return D.files.filter((f) => coverageOf(f) === "only").length;
  }
  function copyingCount() {
    return D.files.filter((f) => coverageOf(f) === "copying").length;
  }
  function copyingAvg() {
    const parts = D.files.flatMap((f) => f.locations.filter((l) => l.status === "copying"));
    if (!parts.length) return 0;
    return Math.round(parts.reduce((a, l) => a + (l.progress || 0), 0) / parts.length);
  }

  function saveBackups() {
    localStorage.setItem(
      "memories-backups",
      JSON.stringify(D.backups.map((j) => ({ ...j, status: j.status === "running" ? "idle" : j.status }))),
    );
  }

  function isSourceDrive(d) {
    return d && ["phone", "usb", "disk"].includes(d.kind);
  }

  function canEject(d) {
    return d && d.online && d.kind !== "computer" && d.kind !== "cloud";
  }

  function sourceFolder(driveId, folderId) {
    return (driveById(driveId)?.folders || []).find((f) => f.id === folderId);
  }

  function folderKids(drive, parentId) {
    return (drive?.folders || []).filter((f) => (f.parent || null) === (parentId || null));
  }

  function folderTrail(drive, folderId) {
    const trail = [];
    let id = folderId;
    while (id) {
      const folder = (drive?.folders || []).find((f) => f.id === id);
      if (!folder) break;
      trail.unshift(folder);
      id = folder.parent || null;
    }
    return trail;
  }

  function jobById(id) {
    return D.backups.find((j) => j.id === id);
  }

  function jobFolderLabel(job) {
    return job.folders
      .map((id) => sourceFolder(job.source, id)?.name)
      .filter(Boolean)
      .join(", ");
  }

  function jobTypes(job) {
    const types = new Set();
    job.folders.forEach((id) => {
      (sourceFolder(job.source, id)?.types || []).forEach((t) => types.add(t));
    });
    return types;
  }

  function jobFiles(job) {
    const types = jobTypes(job);
    return D.files.filter((f) => types.has(f.type) && f.locations.some((l) => l.drive === job.source));
  }

  function jobMissing(job) {
    return jobFiles(job).filter((f) => !f.locations.some((l) => l.drive === job.dest && l.status === "ready"));
  }

  function jobBothOnline(job) {
    const s = driveById(job.source);
    const d = driveById(job.dest);
    return !!(s?.online && d?.online);
  }

  function waitDrive(job) {
    const s = driveById(job.source);
    const d = driveById(job.dest);
    if (s && !s.online) return s;
    if (d && !d.online) return d;
    return null;
  }

  function backupAttention() {
    const ready = D.backups.filter((j) => jobBothOnline(j) && j.status !== "running" && jobMissing(j).length).length;
    if (ready) return ready;
    if (state.justPlugged && isSourceDrive(driveById(state.justPlugged)) && !D.backups.some((j) => j.source === state.justPlugged)) {
      return 1;
    }
    return 0;
  }

  let backupGen = 0;

  function queueCopy(file, destId) {
    const existing = file.locations.find((l) => l.drive === destId);
    if (existing && existing.status === "ready") return;
    if (existing) {
      existing.status = "copying";
      existing.progress = existing.progress || 8;
    } else {
      file.locations.push({ drive: destId, status: "copying", progress: 8 });
    }
    file.inbox = false;
  }

  function runBackup(job) {
    const src = driveById(job.source);
    const dest = driveById(job.dest);
    if (!src?.online) {
      toast(`Plug in ${src?.name || "the source"} first.`);
      return;
    }
    if (!dest?.online) {
      toast(`Plug in ${dest?.name || "the destination"} first.`);
      return;
    }
    const missing = jobMissing(job);
    if (!missing.length) {
      job.status = "idle";
      job.lastRun = "Just now";
      saveBackups();
      toast("Already up to date. We’ll copy what’s new next time.");
      render();
      return;
    }
    missing.forEach((f) => queueCopy(f, job.dest));
    job.status = "running";
    state.justPlugged = null;
    const gen = ++backupGen;
    toast(`Copying ${missing.length} item${missing.length === 1 ? "" : "s"} to ${dest.name}…`);
    render();
    const tick = () => {
      if (gen !== backupGen) return;
      const live = jobById(job.id);
      if (!live) return;
      const s = driveById(live.source);
      const d = driveById(live.dest);
      if (!s?.online || !d?.online) {
        live.status = "idle";
        toast("Drive disconnected. Backup will wait.");
        render();
        return;
      }
      const parts = jobMissing(live)
        .map((f) => f.locations.find((l) => l.drive === live.dest && l.status === "copying"))
        .filter(Boolean);
      if (!parts.length) {
        live.status = "idle";
        live.lastRun = "Just now";
        saveBackups();
        toast(`Backup finished. Files are on ${d.name}.`);
        render();
        return;
      }
      parts.forEach((l) => {
        l.progress = Math.min(100, (l.progress || 8) + 22);
        if (l.progress >= 100) l.status = "ready";
      });
      render();
      setTimeout(tick, 420);
    };
    setTimeout(tick, 420);
  }

  function locSnap() {
    return {
      screen: state.screen,
      view: state.view,
      arrange: state.arrange,
      folder: state.folder,
      album: state.album,
      driveFilter: state.driveFilter,
      coverage: state.coverage,
      typeFilter: state.typeFilter,
      places: state.places,
    };
  }

  function pushHist() {
    state.drawer = false;
    state.hist = state.hist.slice(0, state.histI + 1);
    state.hist.push(locSnap());
    state.histI = state.hist.length - 1;
    state.selected = new Set();
    state.selectedFolder = null;
  }

  function applyLoc(loc) {
    Object.assign(state, loc);
    state.selected = new Set();
    state.selectedFolder = null;
    state.drawer = false;
  }

  function isMobile() {
    return window.innerWidth < 960;
  }

  function leaveMap() {
    state.places = false;
    state.drawer = false;
  }

  function inCustom() {
    return state.screen === "browse" && state.view === "folder" && !!state.folder;
  }

  function goType(id) {
    leaveMap();
    state.screen = "browse";
    state.view = "type";
    state.typeFilter = id;
    state.folder = null;
    state.album = null;
    state.driveFilter = null;
    state.arrange = "date";
    pushHist();
    render();
  }

  function goEvents() {
    leaveMap();
    state.screen = "browse";
    state.view = "events";
    state.typeFilter = null;
    state.folder = null;
    state.album = null;
    state.driveFilter = null;
    state.arrange = "date";
    pushHist();
    render();
  }

  function goLibrary() {
    goType("photo");
  }

  function filesInScope() {
    let list = D.files.slice();
    if (state.screen === "inbox" || (state.screen === "browse" && state.view === "inbox")) list = list.filter((f) => f.inbox);
    if (state.screen === "search" || (state.search && state.screen === "search")) {
      const q = state.search.toLowerCase();
      if (q) {
        list = D.files.filter(
          (f) =>
            f.name.toLowerCase().includes(q) ||
            f.type.includes(q) ||
            f.date.includes(q),
        );
      } else list = [];
    }
    if (state.screen === "browse") {
      if (state.view === "folder" && state.folder) {
        const ids = descendantFolderIds(state.folder);
        list = list.filter((f) => ids.includes(f.folder));
      }
      if (state.view === "events") list = list.filter((f) => f.type === "photo" || f.type === "video");
      if (state.view === "type" && state.typeFilter) list = list.filter((f) => f.type === state.typeFilter);
      if (state.view === "drive" && state.driveFilter) {
        list = list.filter((f) => f.locations.some((l) => l.drive === state.driveFilter));
      }
    }
    list.sort((a, b) => b.date.localeCompare(a.date) || a.name.localeCompare(b.name));
    return list;
  }

  function childFolders() {
    if (!inCustom()) return [];
    return D.folders.filter((f) => f.parent === state.folder).sort((a, b) => a.name.localeCompare(b.name));
  }

  function descendantFolderIds(id) {
    const out = [id];
    D.folders.filter((f) => f.parent === id).forEach((f) => out.push(...descendantFolderIds(f.id)));
    return out;
  }

  function monthLabel(iso) {
    const [y, m] = iso.split("-");
    return new Date(Number(y), Number(m) - 1, 1).toLocaleString("en-US", { month: "long", year: "numeric" });
  }

  function arrangeLabel(id = state.arrange) {
    return { folder: "This folder", date: "Date", kind: "Kind", album: "Album", drive: "Drive", copies: "Copies" }[id] || "This folder";
  }

  function dayLabel(iso) {
    const [y, m, d] = iso.split("-");
    return new Date(Number(y), Number(m) - 1, Number(d)).toLocaleString("en-US", {
      day: "numeric",
      month: "short",
      year: "numeric",
    });
  }

  function groupedFiles() {
    const files = filesInScope();
    const map = new Map();
    files.forEach((f) => {
      const key = f.date.slice(0, 7);
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(f);
    });
    return [...map.keys()]
      .sort((a, b) => b.localeCompare(a))
      .map((key) => ({ id: key, title: monthLabel(key), files: map.get(key) }));
  }

  function eventGroups() {
    const files = filesInScope();
    const map = new Map();
    files.forEach((f) => {
      const key = `${f.date}|${f.place || ""}`;
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(f);
    });
    return [...map.keys()]
      .sort((a, b) => b.localeCompare(a))
      .map((key) => {
        const [iso, place] = key.split("|");
        const title = place ? `${dayLabel(iso)} · ${place}` : dayLabel(iso);
        return { id: key, title, place, date: iso, files: map.get(key) };
      });
  }

  function folderCount(id) {
    return D.files.filter((f) => f.folder === id).length + D.folders.filter((f) => f.parent === id).length;
  }

  function icon(name) {
    const p = {
      recents: "M12 7v5l3 2",
      folder: "M3 7h6l2 2h10v10H3z",
      inbox: "M3 12h6l2 3h2l2-3h6v8H3zM3 4h18v8",
      photos: "M4 6h16v12H4zM8 10a1 1 0 1 0 0-2",
      events: "M5 4h14v3H5zM5 9h6v11H5zM13 9h6v11h-6z",
      video: "M4 6h10v12H4zm10 4 6-3v10l-6-3z",
      doc: "M6 3h8l6 6v12H6z",
      copy: "M4 8h12v12H4zM8 4h12v12",
      drive: "M4 6h16v4H4zm0 8h16v4H4z",
      user: "M12 12a4 4 0 1 0-4-4 4 4 0 0 0 4 4zm0 2c-4 0-8 2-8 6h16c0-4-4-6-8-6z",
      search: "M11 19a8 8 0 1 1 0-16 8 8 0 0 1 0 16zm10 2-4.3-4.3",
      backup: "M12 4v10m0 0 4-4m-4 4-4-4M5 16v2a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-2",
    };
    const extra = name === "recents" ? '<circle cx="12" cy="12" r="9"/>' : "";
    return `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${extra}<path d="${p[name] || p.folder}"/></svg>`;
  }

  function navItem(label, ic, active, act, extra = "") {
    return `<button class="nav-item ${active ? "active" : ""}" data-act="${act}" ${extra}>${icon(ic)} ${esc(label)}</button>`;
  }

  function folderPathOf(file) {
    if (!file.folder) return "—";
    const parts = [];
    let id = file.folder;
    while (id) {
      const f = folderById(id);
      if (!f) break;
      parts.unshift(f.name);
      id = f.parent;
    }
    return parts.join(" › ") || "—";
  }

  function showFolderCol() {
    if (inCustom() && state.arrange === "folder") return false;
    return true;
  }

  function folderSub(f) {
    const kids = D.folders.filter((x) => x.parent === f.id).sort((a, b) => a.name.localeCompare(b.name));
    if (kids.length) return kids.map((k) => k.name).join(", ");
    const n = D.files.filter((x) => x.folder === f.id).length;
    return n ? `${n} file${n === 1 ? "" : "s"}` : "Empty";
  }

  function folderTree(parent = null, depth = 0) {
    return D.folders
      .filter((f) => f.parent === parent)
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((f) => {
        const on = inCustom() && state.folder === f.id;
        return `<button class="nav-item ${on ? "active" : ""}" style="padding-left:${8 + depth * 14}px" data-act="path" data-id="${f.id}">${icon("folder")} ${esc(f.name)}</button>${folderTree(f.id, depth + 1)}`;
      })
      .join("");
  }

  function placeTree(parent = null, depth = 0) {
    return D.folders
      .filter((f) => f.parent === parent)
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(
        (f) =>
          `<button class="place-row" style="padding-left:${12 + depth * 18}px" data-act="folder" data-id="${f.id}">
            ${folderGlyph("fm-ico")}
            <div class="place-copy"><strong>${esc(f.name)}</strong><span>${esc(folderSub(f))}</span></div>
          </button>${placeTree(f.id, depth + 1)}`,
      )
      .join("");
  }

  function sidebarInner() {
    return `
        <div class="brand">Memories</div>
        <div class="nav-label">Files</div>
        ${navItem("Events", "events", state.view === "events", "events")}
        ${navItem("Images", "photos", state.view === "type" && state.typeFilter === "photo", "type", 'data-id="photo"')}
        ${navItem("Videos", "video", state.view === "type" && state.typeFilter === "video", "type", 'data-id="video"')}
        ${navItem("Documents", "doc", state.view === "type" && state.typeFilter === "document", "type", 'data-id="document"')}
        <button class="nav-item ${state.screen === "inbox" ? "active" : ""}" data-act="nav" data-screen="inbox">
          ${icon("inbox")} Inbox <span class="badge">${inboxCount()}</span>
        </button>
        <div class="nav-label">Your folders</div>
        ${
          D.folders.length
            ? folderTree()
            : `<p class="nav-empty">Optional. Create one, then move files in — they still appear under Images, Videos, or Documents.</p>`
        }
        <button class="nav-item new" data-act="new-folder">${icon("folder")} New folder</button>
        <div class="nav-label">Locations</div>
        ${D.drives
          .map(
            (d) => `
          <button class="nav-item ${state.view === "drive" && state.driveFilter === d.id ? "active" : ""}" data-act="place" data-id="${d.id}">
            <span class="dot ${d.online ? "" : "off"}" style="background:${d.color}"></span>
            ${esc(d.name)}
          </button>`,
          )
          .join("")}
        <div class="nav-label"> </div>
        <button class="nav-item ${state.screen === "drives" ? "active" : ""}" data-act="nav" data-screen="drives">${icon("drive")} Manage drives</button>
        <button class="nav-item ${state.screen === "backup" ? "active" : ""}" data-act="nav" data-screen="backup">
          ${icon("backup")} Backup ${backupAttention() ? `<span class="badge">${backupAttention()}</span>` : ""}
        </button>
        <button class="nav-item ${state.screen === "profile" ? "active" : ""}" data-act="nav" data-screen="profile">${icon("user")} Settings</button>
        <div class="sidebar-foot">${copyingCount() ? `${copyingCount()} copying` : `${D.files.length} items`}</div>`;
  }

  function sidebar() {
    return `<aside class="sidebar">${sidebarInner()}</aside>`;
  }

  function drawer() {
    return `<div class="drawer-bg" data-act="close-drawer"><aside class="sidebar drawer-panel" data-stop>${sidebarInner()}</aside></div>`;
  }

  function places() {
    return `<div class="places">
      <div class="journey">
        <p><strong>Your folders</strong> are optional. Images, Videos, and Documents stay the standard. Folders you make are extra — nothing moves on disk.</p>
      </div>
      ${
        D.folders.length
          ? placeTree()
          : `<div class="empty"><h2>No custom folders</h2><p>Create one, then select files and Move to…</p></div>`
      }
      <button class="place-row new" data-act="new-folder">
        ${folderGlyph("fm-ico")}
        <div class="place-copy"><strong>New folder</strong><span>Your view. Files still appear under Images, Videos, or Documents.</span></div>
      </button>
    </div>`;
  }

  function pathButtons() {
    if (isMobile() && state.places && state.screen === "browse") return `<button class="cur">Your folders</button>`;
    if (state.screen === "inbox") return `<button class="cur">Inbox</button>`;
    if (state.screen === "search") return `<button class="cur">Search</button>`;
    if (state.screen === "drives") return `<button class="cur">Drives</button>`;
    if (state.screen === "backup") return `<button class="cur">${state.backupSetup ? (state.backupSetup.editId ? "Edit backup" : "New backup") : "Backup"}</button>`;
    if (state.screen === "profile") return `<button class="cur">Settings</button>`;
    if (state.view === "events") return `<button class="cur">Events</button>`;
    if (state.view === "type") {
      const n = { photo: "Images", video: "Videos", document: "Documents" }[state.typeFilter] || "Files";
      return `<button class="cur">${esc(n)}</button>`;
    }
    if (state.view === "drive") {
      const d = driveById(state.driveFilter);
      return `<button class="cur">${esc(d?.name || "Drive")}</button>`;
    }
    const parts = [];
    let id = state.folder;
    while (id) {
      const f = folderById(id);
      if (!f) break;
      parts.unshift(f);
      id = f.parent;
    }
    const crumbs = parts
      .map(
        (f, i) =>
          `${i ? `<span class="sep">›</span>` : ""}<button class="${i === parts.length - 1 ? "cur" : ""}" data-act="path" data-id="${f.id}">${esc(f.name)}</button>`,
      )
      .join("");
    return crumbs || `<button class="cur">Folder</button>`;
  }

  function topbar() {
    return `
      <header class="topbar">
        <button class="menu-btn" data-act="drawer" aria-label="Browse menu" title="Browse">
          <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M3 5h12M3 9h12M3 13h12"/></svg>
        </button>
        <div class="nav-btns">
          <button data-act="back" ${state.histI <= 0 ? "disabled" : ""} title="Back" aria-label="Back">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 3 5 8l5 5"/></svg>
          </button>
          <button data-act="fwd" ${state.histI >= state.hist.length - 1 ? "disabled" : ""} title="Forward" aria-label="Forward">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 3l5 5-5 5"/></svg>
          </button>
        </div>
        <nav class="path">${pathButtons()}</nav>
        <input class="search-mini" placeholder="Search" value="${esc(state.search)}" data-act="search-type">
      </header>`;
  }

  function fileGlyph(f, cls = "fm-ico") {
    if (f.src) return `<img class="${cls}" referrerpolicy="no-referrer" src="${f.src}" alt="">`;
    if (f.type === "document") return `<div class="${cls} doc">PDF</div>`;
    if (f.type === "video") return `<div class="${cls} vid">MOV</div>`;
    return `<div class="${cls}"></div>`;
  }

  function folderGlyph(cls = "fm-ico") {
    return `<div class="${cls} folder"></div>`;
  }

  function fileRow(f) {
    const cov = coverageOf(f);
    const tag = cov === "copying" ? `<span class="tag go">Copying</span>` : cov === "only" ? `<span class="tag only">1 copy</span>` : "";
    const fold = showFolderCol() ? `<span class="fold hide-sm">${esc(folderPathOf(f))}</span>` : "";
    return `
        <button class="fm-row ${state.selected.has(f.id) ? "selected" : ""}" data-act="pick" data-id="${f.id}">
          ${fileGlyph(f)}
          <div class="name"><span>${esc(f.name)}</span>${tag}</div>
          <span class="dt hide-sm">${esc(f.date)}</span>
          <span class="sz hide-sm">${esc(f.size)}</span>
          <span class="kind hide-sm">${esc(kindLabel(f))}</span>
          ${fold}
          <span class="where hide-sm">${esc(whereText(f))}</span>
        </button>`;
  }

  function folderRow(f) {
    const fold = showFolderCol() ? `<span class="fold hide-sm">—</span>` : "";
    return `
        <button class="fm-row ${state.selectedFolder === f.id ? "selected" : ""}" data-act="pick-folder" data-id="${f.id}">
          ${folderGlyph()}
          <div class="name"><span>${esc(f.name)}</span><span class="sub">${esc(folderSub(f))}</span></div>
          <span class="dt hide-sm">—</span>
          <span class="sz hide-sm">${folderCount(f.id)} items</span>
          <span class="kind hide-sm">Folder</span>
          ${fold}
          <span class="where hide-sm">On this Mac</span>
        </button>`;
  }

  function iconFile(f) {
    return `
          <button class="ico-item ${state.selected.has(f.id) ? "selected" : ""}" data-act="pick" data-id="${f.id}">
            ${fileGlyph(f, "pict" + (f.src ? "" : f.type === "document" ? " doc" : f.type === "video" ? " vid" : ""))}
            <span class="lab">${esc(f.name)}</span>
          </button>`;
  }

  function groupHead(title, n) {
    if (!title) return "";
    return `<div class="group-head"><span>${esc(title)}</span><span>${n}</span></div>`;
  }

  function listing() {
    const folders = childFolders();
    const groups = groupedFiles();
    const fileCount = groups.reduce((n, g) => n + g.files.length, 0);
    if (state.layout === "icons") {
      return `<div class="icons-wrap">
        ${
          folders.length
            ? `<div class="icons">${folders
                .map(
                  (f) => `
          <button class="ico-item ${state.selectedFolder === f.id ? "selected" : ""}" data-act="pick-folder" data-id="${f.id}">
            <div class="pict folder"></div>
            <span class="lab">${esc(f.name)}</span>
          </button>`,
                )
                .join("")}</div>`
            : ""
        }
        ${groups
          .map(
            (g) => `
        ${groupHead(g.title, g.files.length)}
        <div class="icons">${g.files.map(iconFile).join("")}</div>`,
          )
          .join("")}
        ${!folders.length && !fileCount ? `<div class="empty"><h2>${inCustom() ? "This folder is empty" : "Nothing here"}</h2><p>${inCustom() ? "Select files from Images, Videos, or Documents, then Move to… Bytes stay on the same drives." : "Nothing in this view yet."}</p></div>` : ""}
      </div>`;
    }
    const foldCol = showFolderCol();
    return `<div class="fm ${foldCol ? "with-fold" : ""}">
      <div class="colhead">
        <span></span>
        <button data-act="sort" data-sort="name">Name</button>
        <button class="hide-sm" data-act="sort" data-sort="date">Date</button>
        <button class="hide-sm" data-act="sort" data-sort="size">Size</button>
        <button class="hide-sm" data-act="sort" data-sort="kind">Kind</button>
        ${foldCol ? `<span class="hide-sm">Folder</span>` : ""}
        <span class="hide-sm">Where</span>
      </div>
      ${folders.map(folderRow).join("")}
      ${groups.map((g) => `${groupHead(g.title, g.files.length)}${g.files.map(fileRow).join("")}`).join("")}
      ${!folders.length && !fileCount ? `<div class="empty"><h2>${inCustom() ? "This folder is empty" : "Nothing here"}</h2><p>${inCustom() ? "Select files from Images, Videos, or Documents, then Move to… Bytes stay on the same drives." : "Nothing in this view yet."}</p></div>` : ""}
    </div>`;
  }

  function journey() {
    if (state.screen !== "browse") return "";
    if (state.view === "events") {
      return `<div class="journey"><p><strong>Events</strong> groups photos and videos by day and place. Images and Videos are the file lists, by date.</p></div>`;
    }
    if (state.view === "type" && state.typeFilter === "photo") {
      return `<div class="journey"><p><strong>Images</strong>, by date. Open Events for a gallery grouped by when and where.</p></div>`;
    }
    if (state.view === "type" && state.typeFilter === "video") {
      return `<div class="journey"><p><strong>Videos</strong>, by date. Same clips appear in Events with the photos from that day.</p></div>`;
    }
    if (state.view === "type" && state.typeFilter === "document") {
      return `<div class="journey"><p><strong>Documents</strong>, by date.</p></div>`;
    }
    if (!inCustom()) return "";
    const here = folderById(state.folder);
    return `<div class="journey"><p><strong>${esc(here?.name || "Folder")}</strong> is your view. Files still show under Images, Videos, or Documents.</p></div>`;
  }

  function eventsGallery() {
    const groups = eventGroups();
    if (!groups.length) return `<div class="empty"><h2>No events yet</h2><p>Photos and videos group here by day and place.</p></div>`;
    return `<div class="events">
      ${groups
        .map(
          (g) => `
        <section class="event">
          <header class="event-head">
            <h2>${esc(g.title)}</h2>
            <span>${g.files.length} ${g.files.length === 1 ? "item" : "items"}</span>
          </header>
          <div class="event-grid">
            ${g.files
              .map((f) => {
                const cov = coverageOf(f);
                const tag = cov === "copying" ? `<span class="tag go">Copying</span>` : cov === "only" ? `<span class="tag only">1 copy</span>` : "";
                return `<button class="event-tile ${state.selected.has(f.id) ? "selected" : ""}" data-act="pick" data-id="${f.id}">
                  ${fileGlyph(f, "event-img")}
                  ${f.type === "video" ? `<span class="event-vid">Video</span>` : ""}
                  ${tag}
                </button>`;
              })
              .join("")}
          </div>
        </section>`,
        )
        .join("")}
    </div>`;
  }

  function actionbar() {
    const n = state.selected.size;
    const can = n > 0 || !!state.selectedFolder;
    const items = filesInScope().length + childFolders().length;
    const hint = "";
    const canMakeFolder = state.screen === "browse";
    return `<div class="actionbar">
      <span class="muted">${n ? n + " selected" : items + " items"}</span>
      ${hint}
      <span style="flex:1"></span>
      ${canMakeFolder ? `<button class="btn btn-secondary" data-act="new-folder">New folder</button>` : ""}
      <button class="btn btn-secondary" data-act="modal" data-modal="move" ${can ? "" : "disabled"}>Move to…</button>
      <button class="btn btn-secondary" data-act="modal" data-modal="copy" ${can ? "" : "disabled"}>Copy to…</button>
      <button class="btn btn-primary" data-act="modal" data-modal="cloud" ${can ? "" : "disabled"}>Keep in cloud</button>
    </div>`;
  }

  function browse() {
    if (isMobile() && state.places) return places();
    if (state.view === "events") return `${journey()}${actionbar()}${eventsGallery()}`;
    return `${journey()}${actionbar()}${listing()}`;
  }

  function inbox() {
    return `${actionbar()}
      <div class="actionbar" style="border-bottom:0;color:var(--muted);font-size:12px">Not yet on a drive you meant to keep. Copy these onto a registered disk or the cloud.</div>
      ${listing()}`;
  }

  function backupBanner() {
    const id = state.justPlugged;
    if (!id || state.backupSetup) return "";
    const d = driveById(id);
    if (!d) return "";
    const asSource = D.backups.filter((j) => j.source === id);
    const asDest = D.backups.filter((j) => j.dest === id);
    const ready = [...asSource, ...asDest].find((j) => jobBothOnline(j) && j.status !== "running");
    if (ready) {
      const src = driveById(ready.source);
      const dest = driveById(ready.dest);
      return `<div class="bk-banner">
        <p><strong>${esc(d.name)}</strong> is connected. Start the saved backup — ${esc(jobFolderLabel(ready))} from ${esc(src.name)} onto ${esc(dest.name)}.</p>
        <button class="btn btn-primary" data-act="bk-start" data-id="${ready.id}">Start backup</button>
      </div>`;
    }
    const waiting = asSource[0] || asDest[0];
    if (waiting) {
      const need = waitDrive(waiting);
      return `<div class="bk-banner">
        <p><strong>${esc(d.name)}</strong> is connected. Plug in ${esc(need?.name || "the other drive")} to start the saved backup.</p>
        ${need ? `<button class="btn btn-primary" data-act="plug" data-id="${need.id}">Plug in ${esc(need.name)}</button>` : ""}
      </div>`;
    }
    if (isSourceDrive(d)) {
      return `<div class="bk-banner">
        <p><strong>${esc(d.name)}</strong> is connected. Choose which folders to copy onto another drive. We’ll remember the selection.</p>
        <button class="btn btn-primary" data-act="bk-new" data-source="${d.id}">Set up backup</button>
      </div>`;
    }
    return `<div class="bk-banner"><p><strong>${esc(d.name)}</strong> is connected.</p></div>`;
  }

  function backupCard(job) {
    const src = driveById(job.source);
    const dest = driveById(job.dest);
    const missing = jobMissing(job);
    const wait = waitDrive(job);
    const copying = missing.filter((f) => f.locations.some((l) => l.drive === job.dest && l.status === "copying"));
    const pct = copying.length
      ? Math.round(copying.reduce((a, f) => a + (f.locations.find((l) => l.drive === job.dest)?.progress || 0), 0) / copying.length)
      : 0;
    let status = "";
    if (job.status === "running") {
      status = `<div class="bk-wait">Copying ${copying.length || missing.length} items · ${pct}%</div>
        <div class="usage" style="margin-top:8px"><i style="width:${pct}%"></i></div>`;
    } else if (wait) {
      status = `<div class="bk-wait">Waiting for ${esc(wait.name)}</div>`;
    } else if (!missing.length) {
      status = `<div class="bk-ok">${job.lastRun ? `Last backup ${esc(job.lastRun)}` : "Up to date"}</div>`;
    } else {
      status = `<div class="bk-ok">Ready · ${missing.length} new item${missing.length === 1 ? "" : "s"}</div>`;
    }
    const startBtn =
      job.status === "running"
        ? ""
        : wait
          ? `<button class="btn btn-primary" data-act="plug" data-id="${wait.id}">Plug in ${esc(wait.name)}</button>`
          : `<button class="btn btn-primary" data-act="bk-start" data-id="${job.id}">Start backup</button>`;
    return `<div class="bk-card">
      <h3>${esc(src?.name || "Source")} → ${esc(dest?.name || "Drive")}</h3>
      <div class="bk-meta">${esc(jobFolderLabel(job) || "No folders selected")}${dest?.sell ? " · Cloud spare" : ""}</div>
      ${status}
      <div class="bk-actions">
        ${startBtn}
        <button class="btn btn-secondary" data-act="bk-edit" data-id="${job.id}">Edit</button>
        <button class="btn btn-ghost" data-act="bk-remove" data-id="${job.id}">Remove</button>
      </div>
    </div>`;
  }

  function backupWizard() {
    const w = state.backupSetup;
    const steps = ["Source", "Folders", "Drive"];
    const src = driveById(w.source);
    let body = "";
    if (w.step === 0) {
      const drives = D.drives.filter(isSourceDrive);
      body = `<p>Plug in a phone, SSD, or USB. We’ll list the folders on it.</p>
        ${drives
          .map((d) => {
            const on = w.source === d.id;
            return `<button class="pick ${on ? "on" : ""}" data-act="${d.online ? "bk-source" : "plug"}" data-id="${d.id}">
              <span class="dot" style="width:8px;height:8px;border-radius:50%;background:${d.color};opacity:${d.online ? 1 : 0.35}"></span>
              <div><strong>${esc(d.name)}</strong><div class="muted">${d.online ? "Connected — tap to use" : "Not connected — plug in to detect folders"}</div></div>
            </button>`;
          })
          .join("")}`;
    } else if (w.step === 1) {
      const browse = w.browse || null;
      const here = browse ? (src?.folders || []).find((f) => f.id === browse) : null;
      const folders = folderKids(src, browse);
      const trail = folderTrail(src, browse);
      const thisOn = here ? w.folders.includes(here.id) : false;
      body = `<p>Folders on ${esc(src?.name || "this drive")}. Open a folder to look inside. Check the ones to copy.</p>
        <nav class="path" style="flex:none;height:auto;margin-bottom:10px">
          <button class="${browse ? "" : "cur"}" data-act="bk-browse" data-id="">${esc(src?.name || "Drive")}</button>
          ${trail
            .map(
              (f, i) =>
                `<span class="sep">/</span><button class="${i === trail.length - 1 ? "cur" : ""}" data-act="bk-browse" data-id="${f.id}">${esc(f.name)}</button>`,
            )
            .join("")}
        </nav>
        ${
          here
            ? `<div class="check-row ${thisOn ? "on" : ""}">
            <button class="box-hit" data-act="bk-folder" data-id="${here.id}">
              <span class="box">${thisOn ? "✓" : ""}</span>
              <div><strong>This folder</strong><div class="muted">${esc(here.name)} — everything in it</div></div>
            </button>
          </div>`
            : ""
        }
        ${folders
          .map((f) => {
            const on = w.folders.includes(f.id);
            const kinds = f.types.map((t) => ({ photo: "photos", video: "videos", document: "documents" }[t])).join(" · ");
            const kids = folderKids(src, f.id).length;
            return `<div class="check-row ${on ? "on" : ""}">
              <button class="box-hit" data-act="bk-folder" data-id="${f.id}">
                <span class="box">${on ? "✓" : ""}</span>
                <div><strong>${esc(f.name)}</strong><div class="muted">${esc(f.count)} items · ${esc(f.size)} · ${esc(kinds)}</div></div>
              </button>
              ${kids ? `<button class="open" data-act="bk-browse" data-id="${f.id}">Open</button>` : ""}
            </div>`;
          })
          .join("")}`;
    } else {
      body = `<p>Where should copies land? Originals stay on ${esc(src?.name || "the source")}.</p>
        ${D.drives
          .filter((d) => d.id !== w.source)
          .map((d) => {
            const on = w.dest === d.id;
            return `<button class="pick ${on ? "on" : ""}" data-act="bk-dest" data-id="${d.id}">
              <span class="dot" style="width:8px;height:8px;border-radius:50%;background:${d.color};opacity:${d.online ? 1 : 0.35}"></span>
              <div><strong>${esc(d.name)}</strong><div class="muted">${d.online ? "Connected" : "Offline — we’ll wait until you plug it in"}${d.sell ? " · Offsite spare" : ""} · ${d.used}/${d.total} GB</div></div>
            </button>`;
          })
          .join("")}`;
    }
    const canNext = w.step === 0 ? !!w.source : w.step === 1 ? w.folders.length > 0 : !!w.dest;
    return `<div>
      <div class="bk-steps">${steps.map((s, i) => `<span class="${i === w.step ? "on" : ""}">${i + 1}. ${s}</span>`).join("")}</div>
      ${body}
      <div class="bk-wizard-nav">
        <button class="btn btn-secondary" data-act="bk-cancel">Cancel</button>
        ${w.step > 0 ? `<button class="btn btn-secondary" data-act="bk-back">Back</button>` : ""}
        ${
          w.step < 2
            ? `<button class="btn btn-primary" data-act="bk-next" ${canNext ? "" : "disabled"}>Continue</button>`
            : `<button class="btn btn-primary" data-act="bk-save" ${canNext ? "" : "disabled"}>Save backup</button>`
        }
      </div>
    </div>`;
  }

  function backup() {
    if (state.backupSetup) {
      return `<div class="pad">
        <div class="actionbar" style="border:0;padding:0 0 8px">
          <h1 style="flex:1;margin:0">${state.backupSetup.editId ? "Edit backup" : "New backup"}</h1>
        </div>
        ${backupWizard()}
      </div>`;
    }
    const sources = D.drives.filter(isSourceDrive);
    const hasJob = (id) => D.backups.some((j) => j.source === id || j.dest === id);
    const unusedOnline = sources.filter((d) => d.online && !hasJob(d.id) && d.id !== state.justPlugged);
    const unusedOffline = sources.filter((d) => !d.online && !hasJob(d.id));
    return `<div class="pad">
      <div class="actionbar" style="border:0;padding:0 0 12px">
        <h1 style="flex:1;margin:0">Backup</h1>
        <button class="btn btn-primary" data-act="bk-new">New backup</button>
      </div>
      <p class="hello" style="margin-bottom:14px">Backup copies selected folders onto another drive. Plug both in, then Start. It is not how you add a drive.</p>
      ${backupBanner()}
      ${D.backups.length ? D.backups.map(backupCard).join("") : `<div class="empty" style="padding:24px 8px"><h2>No saved backup yet</h2><p>Plug in a phone or thumbdrive, pick folders, pick a drive. We keep that selection.</p></div>`}
      ${
        unusedOnline.length
          ? `<h2>Connected, no backup yet</h2>${unusedOnline
              .map(
                (d) => `<div class="bk-card" style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
                  <div style="flex:1"><strong>${esc(d.name)}</strong><div class="bk-meta">Connected. Choose folders to copy off it.</div></div>
                  <button class="btn btn-primary" data-act="bk-new" data-source="${d.id}">Set up backup</button>
                  ${canEject(d) ? `<button class="btn btn-secondary" data-act="eject" data-id="${d.id}">Eject</button>` : ""}
                </div>`,
              )
              .join("")}`
          : ""
      }
      ${
        unusedOffline.length
          ? `<h2>Plug in to detect</h2>${unusedOffline
              .map(
                (d) => `<div class="bk-card" style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
                  <div style="flex:1"><strong>${esc(d.name)}</strong><div class="bk-meta">Not connected. Plug in and we’ll list folders on it.</div></div>
                  <button class="btn btn-primary" data-act="plug" data-id="${d.id}">Plug in</button>
                </div>`,
              )
              .join("")}`
          : ""
      }
    </div>`;
  }

  function drives() {
    return `<div class="pad">
      <div class="actionbar" style="border:0;padding:0 0 12px">
        <h1 style="flex:1;margin:0">Drives</h1>
        <button class="btn btn-primary" data-act="modal" data-modal="register">Register a drive</button>
      </div>
      ${D.drives
        .map((d) => {
          const n = D.files.filter((f) => f.locations.some((l) => l.drive === d.id)).length;
          const pct = Math.round((d.used / d.total) * 100);
          return `<button class="drive-row" data-act="place" data-id="${d.id}">
            <span class="dot ${d.online ? "" : "off"}" style="width:10px;height:10px;border-radius:50%;background:${d.color}"></span>
            <div style="flex:1;min-width:0;text-align:left">
              <strong>${esc(d.name)}</strong>
              <div class="muted">${d.online ? "Connected" : "Not connected"} · ${n} items · ${d.used} GB of ${d.total} GB${d.sell ? " · Memories Cloud" : ""}</div>
              <div class="usage"><i style="width:${pct}%"></i></div>
            </div>
          </button>`;
        })
        .join("")}
    </div>`;
  }

  function searchScreen() {
    return `${actionbar()}${state.search.trim() ? listing() : `<div class="empty"><h2>Search the library</h2><p>Name, type, or year. Results open as a file list.</p></div>`}`;
  }

  function profile() {
    return `<div class="pad">
      <h1>Settings</h1>
      <p class="hello">${esc(D.user.name)} · family library</p>
      <h2>Family</h2>
      ${D.family.map((p) => `<div class="settings-row"><span>${esc(p.name)}</span><span class="muted">${esc(p.role)}</span></div>`).join("")}
      <h2>This Mac</h2>
      <div class="settings-row"><span>Memories on this computer</span><span class="muted">Free</span></div>
      <div class="settings-row"><span>Remember new files in a drive</span><span class="muted">On</span></div>
      <div class="settings-row"><span>Warn when a file has only one copy</span><span class="muted">On</span></div>
      <h2>Backup</h2>
      <p class="muted" style="margin-bottom:10px">Saved copy pairs. Plug both drives in, then Start. This is not how you add a drive.</p>
      <button class="btn btn-secondary" data-act="nav" data-screen="backup">Open Backup</button>
      <h2>Cloud</h2>
      <p class="muted" style="margin-bottom:10px">Optional paid spare. 100 GB · 12 GB used. The organizer does not need this.</p>
      <button class="btn btn-primary" data-act="modal" data-modal="cloud">Keep more in the cloud</button>
      <h2>Appearance</h2>
      <div class="settings-row">
        <span>Theme</span>
        <select data-act="theme" aria-label="Appearance">
          <option value="system"${state.theme === "system" ? " selected" : ""}>Match system</option>
          <option value="light"${state.theme === "light" ? " selected" : ""}>Light</option>
          <option value="dark"${state.theme === "dark" ? " selected" : ""}>Dark</option>
        </select>
      </div>
      <h2>Demo</h2>
      <button class="btn btn-secondary" data-act="reset">Replay welcome</button>
    </div>`;
  }

  function inspector() {
    const f = state.selected.size === 1 ? fileById([...state.selected][0]) : null;
    const fol = state.selectedFolder ? folderById(state.selectedFolder) : null;
    if (fol && !f) {
      return `<aside class="inspector">
        ${folderGlyph("fm-ico")}
        <h3 style="margin-top:10px">${esc(fol.name)}</h3>
        <p class="muted">Folder · ${folderCount(fol.id)} items</p>
        <button class="btn btn-secondary" data-act="folder" data-id="${fol.id}" style="margin-top:12px">Open</button>
      </aside>`;
    }
    if (!f) {
      return `<aside class="inspector">
        <h3>Info</h3>
        <p class="muted">${state.selected.size ? state.selected.size + " items selected" : "Select a file to see kind, size, and every copy."}</p>
        ${state.selected.size ? `<div style="margin-top:12px"><button class="btn btn-primary" data-act="modal" data-modal="copy">Copy to…</button></div>` : ""}
      </aside>`;
    }
    const preview = f.src
      ? `<img referrerpolicy="no-referrer" src="${f.src}" alt="">`
      : `<div class="doc-preview">${f.type === "document" ? "PDF" : "FILE"}</div>`;
    return `<aside class="inspector">
      <div class="insp-preview">${preview}</div>
      <h3>${esc(f.name)}</h3>
      <p class="muted">${esc(kindLabel(f))} · ${esc(f.size)}</p>
      <div class="settings-row"><span>Created</span><span class="muted">${esc(f.date)}</span></div>
      <div class="settings-row"><span>Folder</span><span class="muted">${esc(folderPathOf(f))}</span></div>
      <h2>Where</h2>
      ${f.locations
        .map((l) => {
          const d = driveById(l.drive);
          return `<div class="settings-row"><span>${esc(d.name)}${d.online ? "" : " · offline"}</span><span class="chip ${l.status === "copying" ? "go" : d.online ? "ok" : "off"}">${l.status === "copying" ? l.progress + "%" : "Ready"}</span></div>`;
        })
        .join("")}
      <div style="display:flex;flex-direction:column;gap:6px;margin-top:14px">
        <button class="btn btn-primary" data-act="modal" data-modal="copy">Copy to…</button>
        <button class="btn btn-secondary" data-act="modal" data-modal="move">Move to…</button>
        <button class="btn btn-secondary" data-act="modal" data-modal="cloud">Keep in cloud</button>
        <button class="btn btn-ghost" data-act="open-sel">Open</button>
      </div>
    </aside>`;
  }

  function dock() {
    const n = copyingCount();
    const items = filesInScope().length + childFolders().length;
    if (!n) return `<footer class="dock"><span>${state.selected.size ? state.selected.size + " selected" : items + " items"}</span></footer>`;
    return `<footer class="dock">
      <span>${n} copying</span>
      <span class="progress"><i style="width:${copyingAvg()}%"></i></span>
      <span>${copyingAvg()}%</span>
    </footer>`;
  }

  function tabs() {
    return `<nav class="tabs">
      <button class="${state.view === "events" ? "active" : ""}" data-act="events">Events</button>
      <button class="${state.view === "type" && state.typeFilter === "photo" ? "active" : ""}" data-act="type" data-id="photo">Images</button>
      <button data-act="modal" data-modal="copy"><span class="fab">+</span></button>
      <button class="${state.screen === "inbox" ? "active" : ""}" data-act="nav" data-screen="inbox">Inbox</button>
      <button class="${state.screen === "profile" ? "active" : ""}" data-act="nav" data-screen="profile">You</button>
    </nav>`;
  }

  function finishTour() {
    state.onboarded = true;
    localStorage.setItem("memories-onboarded", "1");
    localStorage.setItem("memories-tour", "1");
  }

  function tourScene(step) {
    const thumbs = [
      "https://images.unsplash.com/photo-1519741497674-611481863552?w=240&q=70",
      "https://images.unsplash.com/photo-1502082553048-f009c37129b9?w=240&q=70",
      "https://images.unsplash.com/photo-1464349095431-e9a21285b5f3?w=240&q=70",
      "https://images.unsplash.com/photo-1414235077428-338989a2e8c0?w=240&q=70",
      "https://images.unsplash.com/photo-1556912173-46c336c7fd55?w=240&q=70",
      "https://images.unsplash.com/photo-1507525428034-b723cf961d3e?w=240&q=70",
    ];
    if (step === 0) {
      return `<div class="scene scene-welcome" aria-hidden="true">
        ${thumbs
          .slice(0, 3)
          .map(
            (src, i) => `<figure class="print" style="--i:${i}"><img alt="" width="160" height="120" src="${src}"></figure>`,
          )
          .join("")}
      </div>`;
    }
    if (step === 1) {
      const groups = [
        { name: "Images", n: 4 },
        { name: "Videos", n: 2 },
        { name: "Documents", n: 2 },
        { name: "Events", n: 3 },
      ];
      return `<div class="scene scene-files" aria-hidden="true">
        ${groups
          .map(
            (g, gi) => `<div class="g" style="--g:${gi}">
              <strong>${g.name}</strong>
              <div class="tiles">${Array.from({ length: g.n }, (_, i) => {
                const src = thumbs[(gi + i) % thumbs.length];
                const isDoc = g.name === "Documents";
                return isDoc
                  ? `<i class="doc" style="--i:${i}">PDF</i>`
                  : `<img alt="" width="56" height="56" style="--i:${i}" src="${src}">`;
              }).join("")}</div>
            </div>`,
          )
          .join("")}
      </div>`;
    }
    if (step === 2) {
      const drives = [
        { name: "This Mac · Photos", on: true, color: "#3B82F6" },
        { name: "Android · Camera", on: true, color: "#10B981" },
        { name: "Summer SSD", on: false, color: "#F59E0B" },
        { name: "Travel USB", on: false, color: "#8B5CF6" },
      ];
      return `<div class="scene scene-drives" aria-hidden="true">
        ${drives
          .map(
            (d, i) => `<div class="drv ${d.on ? "live" : "wait"}" style="--i:${i}">
              <span class="dot" style="background:${d.color}"></span>
              <strong>${esc(d.name)}</strong>
              <em class="st-off">Not connected</em>
              <em class="st-on">Connected</em>
            </div>`,
          )
          .join("")}
      </div>`;
    }
    if (step === 3) {
      return `<div class="scene scene-copy" aria-hidden="true">
        <div class="card">
          <img alt="" width="280" height="180" src="${thumbs[0]}">
          <div class="meta"><b>First dance.jpg</b><span>Wedding · 12 Aug 2025</span></div>
          <div class="chips">
            <span class="c c1">Camera</span>
            <span class="c c2">Summer SSD</span>
            <span class="c c3">Copying 62%</span>
          </div>
        </div>
      </div>`;
    }
    return `<div class="scene scene-cloud" aria-hidden="true">
      <div class="card">
        <img alt="" width="280" height="180" src="${thumbs[0]}">
        <div class="meta"><b>First dance.jpg</b><span>Same file. Still here after you unplug.</span></div>
        <div class="chips">
          <span class="c">This Mac · Photos</span>
          <span class="c">Summer SSD</span>
          <span class="c optional">USB · when plugged in</span>
        </div>
      </div>
    </div>`;
  }

  function renderOnboard() {
    const steps = [
      {
        title: "This is a file manager.",
        body: "For the disks you already own — this computer, a phone, an SSD, a USB stick. A drive is a folder you choose, not the whole disk.",
      },
      {
        title: "Those files show up here.",
        body: "Images, videos, and documents, by date. Photos and videos also as events, by day and place. You can use only this, forever, with the network unplugged.",
      },
      {
        title: "A drive is a folder you choose.",
        body: "Photos on this Mac. Camera on the phone. A folder on an SSD. Plug in, pick the folder. Memories remembers what’s in it. The files stay put.",
      },
      {
        title: "Backup is a separate step.",
        body: "Open folders on a drive, check the ones to copy, then pick a disk. Plug both in, then Start. Originals stay where they are.",
      },
      {
        title: "Unplug later. The catalog stays.",
        body: "Memories still shows what you have, and which folder it lives in. Skip the cloud forever and it still works as a file manager.",
      },
    ];
    const s = steps[state.ob];
    const last = state.ob === steps.length - 1;
    const pct = ((state.ob + 1) / steps.length) * 100;
    return `<div class="tour" role="dialog" aria-modal="true" aria-labelledby="tour-title">
      <div class="tour-stage">${tourScene(state.ob)}</div>
      <div class="tour-panel">
        <p class="tour-brand">Memories</p>
        <h1 id="tour-title">${esc(s.title)}</h1>
        <p>${esc(s.body)}</p>
        <div class="tour-actions">
          ${state.ob > 0 ? `<button class="btn btn-ghost" data-act="ob-back">Back</button>` : ""}
          <button class="btn btn-primary" data-act="ob-next">${last ? "Open Images" : "Continue"}</button>
        </div>
        <button class="tour-skip" data-act="ob-skip">Skip welcome</button>
        <div class="tour-bar" aria-hidden="true"><i style="width:${pct}%"></i></div>
      </div>
    </div>`;
  }

  function viewer() {
    const f = fileById(state.viewer);
    if (!f) return "";
    const canOpen = f.locations.some((l) => driveById(l.drive).online);
    const img = f.src
      ? `<img referrerpolicy="no-referrer" src="${f.src}" alt="${esc(f.name)}">`
      : `<div style="color:#fff;display:grid;place-items:center">${esc(f.name)}</div>`;
    return `<div class="viewer">
      <div class="vbar top">
        <button data-act="close-viewer">Back</button>
        <strong style="flex:1">${esc(f.name)}</strong>
        <button data-act="sheet">${state.sheet ? "Hide info" : "Get Info"}</button>
      </div>
      ${img}
      <div class="vbar bot">
        <button data-act="modal" data-modal="copy">Copy to…</button>
        <button data-act="modal" data-modal="cloud">Cloud</button>
        <button data-act="toast" data-msg="Moved to Trash">Move to Trash</button>
      </div>
      ${
        state.sheet
          ? `<div class="sheet"><div class="handle"></div>
              <h3>${esc(f.name)}</h3>
              <p class="muted">${esc(kindLabel(f))} · ${esc(f.size)} · ${esc(f.date)}</p>
              <h2>Where</h2>
              ${f.locations
                .map((l) => {
                  const d = driveById(l.drive);
                  return `<div class="settings-row"><span>${esc(d.name)}${d.online ? "" : " · offline"}</span><span class="chip ${l.status === "copying" ? "go" : "ok"}">${l.status === "copying" ? l.progress + "%" : "Ready"}</span></div>`;
                })
                .join("")}
              ${!canOpen ? `<p class="muted">No connected copy. Plug in ${esc(driveById(f.locations[0].drive).name)} to open the original.</p>` : ""}
            </div>`
          : ""
      }
    </div>`;
  }

  function modal() {
    if (!state.modal) return "";
    if (state.modal === "copy" || state.modal === "cloud") {
      const cloudOnly = state.modal === "cloud";
      const drives = cloudOnly ? D.drives.filter((d) => d.kind === "cloud") : D.drives;
      return `<div class="modal-bg" data-act="close-modal"><div class="modal" data-stop>
        <h2>${cloudOnly ? "Keep in cloud" : "Copy to…"}</h2>
        <p>${cloudOnly ? "Optional paid spare. Originals stay on your disks. The organizer stays free." : "If that drive already has these bytes, we won’t copy twice."}</p>
        <div class="drive-pick">
          ${drives
            .map(
              (d) => `<button class="${d.online ? "" : "off"}" data-act="do-copy" data-id="${d.id}">
                <span class="dot" style="width:8px;height:8px;border-radius:50%;background:${d.color}"></span>
                <div><strong>${esc(d.name)}</strong><div class="muted">${d.online ? "Connected" : "Offline"} · ${d.used}/${d.total} GB</div></div>
              </button>`,
            )
            .join("")}
        </div>
        <button class="btn btn-secondary" data-act="close-modal" style="width:100%;justify-content:center">Cancel</button>
      </div></div>`;
    }
    if (state.modal === "move") {
      if (!D.folders.length) {
        return `<div class="modal-bg" data-act="close-modal"><div class="modal" data-stop>
          <h2>Move to…</h2>
          <p>You don’t have a custom folder yet. Create one — files still appear under Images, Videos, or Documents.</p>
          <button class="btn btn-primary" data-act="new-folder" style="width:100%;justify-content:center;margin-bottom:8px">New folder</button>
          <button class="btn btn-secondary" data-act="close-modal" style="width:100%;justify-content:center">Cancel</button>
        </div></div>`;
      }
      const rows = [
        `<button data-act="do-move" data-id=""><div><strong>Not in a folder</strong><div class="muted">Standard view only — Images, Videos, Documents</div></div></button>`,
      ];
      const walk = (parent, depth) => {
        D.folders
          .filter((f) => f.parent === parent)
          .forEach((f) => {
            rows.push(`<button style="padding-left:${10 + depth * 14}px" data-act="do-move" data-id="${f.id}">${icon("folder")} <div><strong>${esc(f.name)}</strong><div class="muted">${depth ? "Inside another folder" : "Your folder"}</div></div></button>`);
            walk(f.id, depth + 1);
          });
      };
      walk(null, 0);
      return `<div class="modal-bg" data-act="close-modal"><div class="modal" data-stop>
        <h2>Move to…</h2>
        <p>Puts files or folders in a view you made. Bytes stay on the same drives. They still show under Images, Videos, or Documents.</p>
        <div class="drive-pick">${rows.join("")}</div>
        <button class="btn btn-secondary" data-act="close-modal" style="width:100%;justify-content:center">Cancel</button>
      </div></div>`;
    }
    if (state.modal === "register") {
      return `<div class="modal-bg" data-act="close-modal"><div class="modal" data-stop>
        <h2>Register a drive</h2>
        <p>A folder you choose. We’ll remember the files in it. Backup is a separate step.</p>
        ${["External SSD", "USB stick", "This phone", "Folder on this Mac"]
          .map((t) => `<button class="drive-row" data-act="toast" data-msg="Demo: ${t} would appear under Locations" style="border:1px solid var(--line);border-radius:8px;margin-bottom:6px">${esc(t)}</button>`)
          .join("")}
        <button class="btn btn-secondary" data-act="close-modal" style="width:100%;justify-content:center;margin-top:8px">Cancel</button>
      </div></div>`;
    }
    return "";
  }

  function render() {
    const root = document.getElementById("app");
    if (!state.onboarded) {
      root.className = "app onboarding";
      root.innerHTML = renderOnboard();
      root.querySelector("[data-act=ob-next]")?.focus();
      return;
    }
    const showInsp = state.inspector && window.innerWidth > 960 && !["profile", "drives", "backup"].includes(state.screen);
    root.className = "app" + (showInsp ? "" : " no-inspector");
    if (state.screen !== "backup") state.backupSetup = null;
    const body =
      state.screen === "inbox"
        ? inbox()
        : state.screen === "drives"
          ? drives()
          : state.screen === "backup"
            ? backup()
            : state.screen === "search"
            ? searchScreen()
            : state.screen === "profile"
              ? profile()
              : browse();
    root.innerHTML = `
      ${isMobile() ? "" : sidebar()}${topbar()}
      <main class="main">${body}</main>
      ${showInsp ? inspector() : ""}
      ${dock()}${tabs()}
      ${state.drawer && isMobile() ? drawer() : ""}
      ${state.viewer ? viewer() : ""}
      ${modal()}
      ${state.toast ? `<div class="toast">${esc(state.toast)}</div>` : ""}
      <div class="demo-flag">Local app mock · <a href="../product.html">Product story</a></div>
    `;
    const inp = root.querySelector("[data-act=search-type]");
    if (inp && state.searchFocus) {
      inp.focus();
      inp.setSelectionRange(inp.value.length, inp.value.length);
    }
  }

  function openFolder(id, { asTree = true } = {}) {
    leaveMap();
    state.screen = "browse";
    state.view = "folder";
    state.folder = id;
    state.album = null;
    state.typeFilter = null;
    state.driveFilter = null;
    if (asTree) state.arrange = "folder";
    pushHist();
    render();
  }

  function onDblClick(e) {
    const folder = e.target.closest("[data-act=pick-folder]");
    if (folder) {
      openFolder(folder.dataset.id);
      return;
    }
    const t = e.target.closest("[data-act=pick]");
    if (t) openFile(t.dataset.id);
  }

  let lastPick = 0;
  function onClick(e) {
    const stop = e.target.closest("[data-stop]");
    const t = e.target.closest("[data-act]");
    if (!t) return;
    const act = t.dataset.act;
    if ((act === "close-modal" || act === "close-drawer") && stop && e.target !== t) return;

    if (act === "ob-next") {
      if (state.ob >= 4) finishTour();
      else state.ob += 1;
      render();
      return;
    }
    if (act === "ob-back") {
      if (state.ob > 0) state.ob -= 1;
      render();
      return;
    }
    if (act === "ob-skip") {
      finishTour();
      render();
      return;
    }
    if (act === "nav") {
      leaveMap();
      if (t.dataset.screen !== "backup") state.backupSetup = null;
      state.screen = t.dataset.screen;
      state.selected = new Set();
      pushHist();
      render();
      return;
    }
    if (act === "library") {
      goType("photo");
      return;
    }
    if (act === "events") {
      goEvents();
      return;
    }
    if (act === "places") {
      state.places = true;
      state.drawer = false;
      state.screen = "browse";
      state.view = "library";
      state.folder = null;
      state.album = null;
      state.typeFilter = null;
      state.driveFilter = null;
      state.selected = new Set();
      state.selectedFolder = null;
      pushHist();
      render();
      return;
    }
    if (act === "drawer") {
      state.drawer = !state.drawer;
      render();
      return;
    }
    if (act === "close-drawer") {
      state.drawer = false;
      render();
      return;
    }
    if (act === "smart") {
      leaveMap();
      state.screen = "browse";
      state.view = t.dataset.view;
      pushHist();
      render();
      return;
    }
    if (act === "folder") {
      openFolder(t.dataset.id);
      return;
    }
    if (act === "path") {
      openFolder(t.dataset.id, { asTree: false });
      return;
    }
    if (act === "arrange") return;
    if (act === "album") {
      leaveMap();
      state.screen = "browse";
      state.view = "albums";
      state.album = t.dataset.id;
      pushHist();
      render();
      return;
    }
    if (act === "type") {
      goType(t.dataset.id);
      return;
    }
    if (act === "place") {
      leaveMap();
      state.screen = "browse";
      state.view = "drive";
      state.driveFilter = t.dataset.id;
      pushHist();
      render();
      return;
    }
    if (act === "cov") {
      leaveMap();
      state.screen = "browse";
      state.view = "coverage";
      state.coverage = t.dataset.id;
      pushHist();
      render();
      return;
    }
    if (act === "layout") {
      state.layout = t.dataset.layout;
      render();
      return;
    }
    if (act === "sort") {
      state.sort = t.dataset.sort;
      render();
      return;
    }
    if (act === "back") {
      if (state.histI > 0) {
        state.histI -= 1;
        applyLoc(state.hist[state.histI]);
        render();
      }
      return;
    }
    if (act === "fwd") {
      if (state.histI < state.hist.length - 1) {
        state.histI += 1;
        applyLoc(state.hist[state.histI]);
        render();
      }
      return;
    }
    if (act === "pick-folder") {
      if (window.innerWidth < 960) {
        openFolder(t.dataset.id);
        return;
      }
      const now = Date.now();
      if (state.selectedFolder === t.dataset.id && now - lastPick < 400) {
        openFolder(t.dataset.id);
        return;
      }
      lastPick = now;
      state.selected = new Set();
      state.selectedFolder = t.dataset.id;
      render();
      return;
    }
    if (act === "pick") {
      if (window.innerWidth < 960) {
        openFile(t.dataset.id);
        return;
      }
      const now = Date.now();
      if (state.selected.has(t.dataset.id) && state.selected.size === 1 && now - lastPick < 400) {
        openFile(t.dataset.id);
        return;
      }
      lastPick = now;
      if (!e.metaKey && !e.shiftKey) state.selected = new Set();
      if (state.selected.has(t.dataset.id) && (e.metaKey || e.shiftKey)) state.selected.delete(t.dataset.id);
      else state.selected.add(t.dataset.id);
      state.selectedFolder = null;
      render();
      return;
    }
    if (act === "open-sel") {
      const id = [...state.selected][0];
      if (id) openFile(id);
    }
    if (act === "close-viewer") {
      state.viewer = null;
      state.sheet = false;
      render();
    }
    if (act === "sheet") {
      state.sheet = !state.sheet;
      render();
    }
    if (act === "modal") {
      if (!state.selected.size && state.viewer) state.selected = new Set([state.viewer]);
      state.modal = t.dataset.modal;
      render();
    }
    if (act === "new-folder") {
      state.modal = null;
      const parent = inCustom() ? state.folder : null;
      const n = D.folders.filter((f) => f.parent === parent && f.name.startsWith("Untitled folder")).length;
      const name = n ? `Untitled folder ${n + 1}` : "Untitled folder";
      const id = "fold-" + Date.now();
      D.folders.push({ id, name, parent });
      const ids = [...state.selected];
      if (ids.length) {
        ids.forEach((fid) => {
          const f = fileById(fid);
          if (f) {
            f.folder = id;
            f.inbox = false;
          }
        });
        toast(`In ${name}. Files still appear under Images, Videos, or Documents.`);
        render();
        return;
      }
      openFolder(id);
      toast("Empty folder. Select files, then Move to…");
      return;
    }
    if (act === "do-move") {
      const destId = t.dataset.id || null;
      const dest = destId ? folderById(destId) : null;
      if (state.selectedFolder) {
        const fol = folderById(state.selectedFolder);
        if (fol) {
          if (dest && descendantFolderIds(fol.id).includes(dest.id)) {
            toast("Can't put a folder inside itself.");
            return;
          }
          fol.parent = dest ? dest.id : null;
        }
      }
      const ids = state.selected.size ? [...state.selected] : state.viewer ? [state.viewer] : [];
      ids.forEach((id) => {
        const f = fileById(id);
        if (f) {
          f.folder = dest ? dest.id : null;
          f.inbox = false;
        }
      });
      state.modal = null;
      toast(dest ? `In ${dest.name}. Still in the standard view.` : "Not in a folder. Still in the standard view.");
      render();
      return;
    }
    if (act === "close-modal") {
      state.modal = null;
      render();
    }
    if (act === "do-copy") {
      const d = driveById(t.dataset.id);
      if (!d.online) {
        toast(`${d.name} isn’t connected.`);
        return;
      }
      const ids = state.selected.size ? [...state.selected] : state.viewer ? [state.viewer] : [];
      ids.forEach((id) => {
        const f = fileById(id);
        if (!f) return;
        if (f.locations.some((l) => l.drive === d.id && l.status === "ready")) return;
        const existing = f.locations.find((l) => l.drive === d.id);
        if (existing) existing.status = "copying";
        else f.locations.push({ drive: d.id, status: "copying", progress: 8 });
        f.inbox = false;
      });
      state.modal = null;
      toast(d.kind === "cloud" ? "Copying to Cloud…" : `Copying to ${d.name}…`);
      render();
      return;
    }
    if (act === "plug") {
      const d = driveById(t.dataset.id);
      if (!d) return;
      d.online = true;
      state.justPlugged = d.id;
      if (state.backupSetup && isSourceDrive(d) && !state.backupSetup.source) {
        state.backupSetup.source = d.id;
        state.backupSetup.step = 1;
      }
      toast(`${d.name} connected.`);
      if (state.screen !== "backup") {
        state.screen = "backup";
        state.backupSetup = null;
        pushHist();
      }
      render();
      return;
    }
    if (act === "eject") {
      const d = driveById(t.dataset.id);
      if (!d || !canEject(d)) return;
      d.online = false;
      if (state.justPlugged === d.id) state.justPlugged = null;
      D.backups.forEach((j) => {
        if (j.status === "running" && (j.source === d.id || j.dest === d.id)) j.status = "idle";
      });
      backupGen += 1;
      toast(`${d.name} ejected. Backup will wait.`);
      render();
      return;
    }
    if (act === "bk-new") {
      state.screen = "backup";
      const source = t.dataset.source || null;
      state.backupSetup = {
        step: source ? 1 : 0,
        source,
        folders: [],
        dest: null,
        browse: null,
        editId: null,
      };
      render();
      return;
    }
    if (act === "bk-edit") {
      const job = jobById(t.dataset.id);
      if (!job) return;
      state.screen = "backup";
      state.backupSetup = {
        step: 1,
        source: job.source,
        folders: [...job.folders],
        dest: job.dest,
        browse: null,
        editId: job.id,
      };
      render();
      return;
    }
    if (act === "bk-remove") {
      D.backups = D.backups.filter((j) => j.id !== t.dataset.id);
      saveBackups();
      toast("Backup removed. Files already copied stay put.");
      render();
      return;
    }
    if (act === "bk-cancel") {
      state.backupSetup = null;
      render();
      return;
    }
    if (act === "bk-back") {
      if (state.backupSetup && state.backupSetup.step > 0) state.backupSetup.step -= 1;
      render();
      return;
    }
    if (act === "bk-next") {
      const w = state.backupSetup;
      if (!w) return;
      if (w.step === 0 && !w.source) return;
      if (w.step === 1 && !w.folders.length) return;
      if (w.step < 2) w.step += 1;
      render();
      return;
    }
    if (act === "bk-source") {
      if (!state.backupSetup) return;
      state.backupSetup.source = t.dataset.id;
      state.backupSetup.folders = [];
      state.backupSetup.browse = null;
      state.backupSetup.step = 1;
      render();
      return;
    }
    if (act === "bk-browse") {
      if (!state.backupSetup) return;
      state.backupSetup.browse = t.dataset.id || null;
      render();
      return;
    }
    if (act === "bk-folder") {
      if (!state.backupSetup) return;
      const id = t.dataset.id;
      const set = new Set(state.backupSetup.folders);
      if (set.has(id)) set.delete(id);
      else set.add(id);
      state.backupSetup.folders = [...set];
      render();
      return;
    }
    if (act === "bk-dest") {
      if (!state.backupSetup) return;
      state.backupSetup.dest = t.dataset.id;
      render();
      return;
    }
    if (act === "bk-save") {
      const w = state.backupSetup;
      if (!w?.source || !w.dest || !w.folders.length) return;
      if (w.editId) {
        const job = jobById(w.editId);
        if (job) {
          job.source = w.source;
          job.folders = [...w.folders];
          job.dest = w.dest;
        }
      } else {
        D.backups.push({
          id: "bk-" + Date.now(),
          source: w.source,
          folders: [...w.folders],
          dest: w.dest,
          lastRun: null,
          status: "idle",
        });
      }
      saveBackups();
      state.backupSetup = null;
      state.justPlugged = null;
      const dest = driveById(w.dest);
      toast(dest?.online ? "Saved. Start backup when you’re ready." : `Saved. Plug in ${dest?.name || "the drive"} to start.`);
      render();
      return;
    }
    if (act === "bk-start") {
      const job = jobById(t.dataset.id);
      if (job) runBackup(job);
      return;
    }
    if (act === "toast") toast(t.dataset.msg);
    if (act === "reset") {
      localStorage.removeItem("memories-onboarded");
      localStorage.removeItem("memories-tour");
      state.onboarded = false;
      state.ob = 0;
      render();
    }
  }

  function onInput(e) {
    if (e.target.dataset.act === "search-type") {
      leaveMap();
      state.search = e.target.value;
      state.searchFocus = true;
      state.screen = "search";
      render();
    }
  }

  function onChange(e) {
    if (e.target.dataset.act === "arrange") {
      state.arrange = e.target.value;
      state.selected = new Set();
      state.selectedFolder = null;
      pushHist();
      render();
    }
    if (e.target.dataset.act === "theme") {
      state.theme = e.target.value;
      localStorage.setItem("memories-theme", state.theme);
      applyTheme(state.theme);
      render();
    }
  }

  function openFile(id) {
    state.viewer = id;
    state.selected = new Set([id]);
    state.sheet = false;
    render();
  }

  window.addEventListener("keydown", (e) => {
    if (!state.onboarded) {
      if (e.key === "Enter" || e.key === "ArrowRight") {
        e.preventDefault();
        if (state.ob >= 4) finishTour();
        else state.ob += 1;
        render();
      } else if (e.key === "ArrowLeft" && state.ob > 0) {
        e.preventDefault();
        state.ob -= 1;
        render();
      }
      return;
    }
    if (e.key === "Escape") {
      if (state.modal) state.modal = null;
      else if (state.backupSetup) state.backupSetup = null;
      else if (state.viewer) state.viewer = null;
      else {
        state.selected = new Set();
        state.selectedFolder = null;
      }
      render();
    }
    if (e.key === "Enter" && state.selected.size === 1 && !state.viewer) openFile([...state.selected][0]);
    if ((e.key === "Backspace" || e.key === "ArrowLeft") && e.metaKey) {
      e.preventDefault();
      if (state.histI > 0) {
        state.histI -= 1;
        applyLoc(state.hist[state.histI]);
        render();
      }
    }
  });
  window.addEventListener("resize", () => render());

  const rootEl = document.getElementById("app");
  rootEl.addEventListener("click", onClick);
  rootEl.addEventListener("input", onInput);
  rootEl.addEventListener("change", onChange);
  rootEl.addEventListener("dblclick", onDblClick);
  render();
})();
