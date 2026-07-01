// browser.ts — the full-canvas image browser view.
//
// Reuses the card-grid file-explorer pattern proven in comfyui-gallery-loader's
// image-picker (breadcrumbs, thumbnail grid, lazy-load, sort, fuzzy search), but
// as a STANDALONE full-viewport view launched from the app chrome rather than a
// per-widget modal — and it MANAGES files (delete / rename / move) instead of
// committing a value to a node widget.

import type { ModalShellController } from "@laurigates/comfy-modal-kit";
import { fuzzyScore, notify, openModalShell } from "@laurigates/comfy-modal-kit";
import {
  type BrowseType,
  deleteFile,
  EXT_NAME,
  fetchBasePaths,
  fetchListing,
  fullSrcURL,
  IMG_EXTS,
  imageThumbURL,
  joinAbs,
  type ListingFile,
  moveFile,
  renameFile,
  SANDBOXED_TYPES,
  VIDEO_EXTS,
  videoSrcURL,
} from "./api.js";
import { confirmAction, OVERLAY_CSS, openOverlay, promptText } from "./overlay.js";

const STYLE_ID = "ib-style";
const SORT_STORAGE_KEY = "comfyui-image-browser:sort";
const VALID_SORTS = new Set([
  "mtime:desc",
  "mtime:asc",
  "name:asc",
  "name:desc",
  "size:desc",
  "pixels:desc",
]);

interface BrowserState {
  type: BrowseType;
  subfolder: string;
  absPath: string;
  dirs: { name: string }[];
  files: ListingFile[];
  sortKey: string;
  sortDir: string;
  query: string;
}

interface SavedSort {
  key: string;
  dir: string;
}

function loadSavedSort(): SavedSort | null {
  try {
    const raw = localStorage.getItem(SORT_STORAGE_KEY);
    if (!raw || !VALID_SORTS.has(raw)) return null;
    const [key, dir] = raw.split(":");
    return { key: key as string, dir: dir as string };
  } catch {
    return null;
  }
}

function saveSort(key: string, dir: string): void {
  try {
    localStorage.setItem(SORT_STORAGE_KEY, `${key}:${dir}`);
  } catch {
    /* private-mode / disabled storage — non-fatal */
  }
}

interface ThumbDescriptor {
  kind: "img" | "video" | "icon";
  src?: string;
  text?: string;
}

// ============================================================
// Entry point
// ============================================================

export function openImageBrowser(): ModalShellController {
  ensureStyle();

  const state: BrowserState = {
    type: "output",
    subfolder: "",
    absPath: "",
    dirs: [],
    files: [],
    sortKey: "mtime",
    sortDir: "desc",
    query: "",
  };
  const savedSort = loadSavedSort();
  if (savedSort) {
    state.sortKey = savedSort.key;
    state.sortDir = savedSort.dir;
  }

  const modal = openModalShell({
    title: "Image Browser",
    placeholder: "Filter by filename…",
    // Fill the whole viewport — the browser stands in for the canvas.
    width: "100vw",
    height: "100vh",
    footerLeftHTML: "<kbd>Esc</kbd> close · tap a card to open · tap a folder to descend",
    footerRightHTML: '<span class="ib-count"></span>',
  });
  modal.dialog.classList.add("ib-dialog");

  // Root the smoke test asserts on; also the overlay host.
  const root = document.createElement("div");
  root.className = "image-browser-body";
  modal.bodyEl.appendChild(root);

  // ---- Toolbar: tabs + breadcrumbs + sort + refresh --------------
  const tabsEl = document.createElement("div");
  tabsEl.className = "ib-tabs";
  for (const t of ["input", "output", "temp", "path"] as BrowseType[]) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "ib-tab";
    b.dataset.type = t;
    b.textContent = t === "path" ? "browse…" : t;
    tabsEl.appendChild(b);
  }

  const crumbsEl = document.createElement("div");
  crumbsEl.className = "ib-crumbs";

  const sortEl = document.createElement("select");
  sortEl.className = "ib-control";
  sortEl.title = "Sort";
  sortEl.innerHTML = `
    <option value="mtime:desc">Newest</option>
    <option value="mtime:asc">Oldest</option>
    <option value="name:asc">Name A→Z</option>
    <option value="name:desc">Name Z→A</option>
    <option value="size:desc">Largest file</option>
    <option value="pixels:desc">Highest resolution</option>`;
  sortEl.value = `${state.sortKey}:${state.sortDir}`;

  const refreshEl = document.createElement("button");
  refreshEl.type = "button";
  refreshEl.className = "ib-control ib-icon";
  refreshEl.title = "Refresh";
  refreshEl.textContent = "⟳";

  modal.toolbarEl.append(tabsEl, crumbsEl, sortEl, refreshEl);

  // ---- Grid ------------------------------------------------------
  const gridEl = document.createElement("div");
  gridEl.className = "ib-grid";
  root.appendChild(gridEl);

  const countEl = modal.footerEl.querySelector(".ib-count") as HTMLElement | null;
  function setCount(visible: number, total: number): void {
    if (countEl) countEl.textContent = `${visible} / ${total}`;
  }

  // ---- Navigation helpers ---------------------------------------
  function navigateUp(): void {
    if (state.type === "path") {
      const p = (state.absPath || "/").replace(/\/+$/, "");
      if (p === "" || p === "/") return;
      const i = p.lastIndexOf("/");
      state.absPath = i <= 0 ? "/" : p.slice(0, i);
    } else {
      const p = state.subfolder.replace(/\/+$/, "");
      const i = p.lastIndexOf("/");
      state.subfolder = i <= 0 ? "" : p.slice(0, i);
    }
    loadAndRender();
  }

  function navigateInto(name: string): void {
    if (state.type === "path") {
      state.absPath = joinAbs(state.absPath, name);
    } else {
      const base = state.subfolder.replace(/\/+$/, "");
      state.subfolder = base ? `${base}/${name}` : name;
    }
    loadAndRender();
  }

  async function switchType(type: BrowseType): Promise<void> {
    state.type = type;
    state.subfolder = "";
    if (type === "path") {
      const bp = await fetchBasePaths();
      state.absPath = bp.base_path || "/";
    }
    loadAndRender();
  }

  // ---- Wiring ----------------------------------------------------
  modal.searchEl.addEventListener("input", () => {
    state.query = modal.searchEl.value.toLowerCase().trim();
    renderGrid();
  });
  sortEl.addEventListener("change", () => {
    const [k, d] = sortEl.value.split(":");
    state.sortKey = k as string;
    state.sortDir = d as string;
    saveSort(k as string, d as string);
    renderGrid();
  });
  refreshEl.addEventListener("click", () => loadAndRender());
  tabsEl.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest("[data-type]") as HTMLElement | null;
    if (!b) return;
    const t = b.dataset.type as BrowseType;
    if (state.type === t) return;
    switchType(t);
  });
  crumbsEl.addEventListener("click", (e) => {
    const c = (e.target as HTMLElement).closest("[data-sub], [data-abs]") as HTMLElement | null;
    if (!c) return;
    if (c.dataset.abs !== undefined) state.absPath = c.dataset.abs || "/";
    else state.subfolder = c.dataset.sub || "";
    loadAndRender();
  });

  gridEl.addEventListener("click", (e) => {
    const target = e.target as HTMLElement;
    const actionBtn = target.closest("[data-action]") as HTMLElement | null;
    const card = target.closest(".ib-card") as HTMLElement | null;
    if (!card) return;
    if (card.classList.contains("is-up")) {
      navigateUp();
      return;
    }
    if (card.classList.contains("is-dir")) {
      navigateInto(card.dataset.name as string);
      return;
    }
    // File card.
    const name = card.dataset.name as string;
    const ext = card.dataset.ext || "";
    if (actionBtn) {
      e.stopPropagation();
      const action = actionBtn.dataset.action;
      if (action === "open") openFull(name, ext);
      else if (action === "delete") onDelete(name);
      else if (action === "rename") onRename(name);
      else if (action === "move") onMove(name);
      return;
    }
    openFull(name, ext);
  });

  // ---- File actions ---------------------------------------------
  function openFull(name: string, _ext: string): void {
    const url = fullSrcURL(state.type, state.subfolder, name, state.absPath);
    window.open(url, "_blank", "noopener");
  }

  async function onDelete(name: string): Promise<void> {
    const ok = await confirmAction(modal, {
      title: "Delete file?",
      message: `Permanently delete "${name}"? This cannot be undone.`,
      confirmLabel: "Delete",
      danger: true,
    });
    if (!ok) return;
    try {
      await deleteFile(state.type, state.subfolder, name);
      state.files = state.files.filter((f) => f.name !== name);
      renderGrid();
    } catch (e) {
      reportError("Delete failed", e);
    }
  }

  async function onRename(name: string): Promise<void> {
    const dot = name.lastIndexOf(".");
    const ext = dot >= 0 ? name.slice(dot) : "";
    const newName = await promptText(modal, {
      title: "Rename file",
      label: "New filename",
      value: name,
      confirmLabel: "Rename",
      validate: (v) => {
        if (!v) return "Filename required";
        if (v.includes("/") || v.includes("\\")) return "No slashes allowed";
        if (v === "." || v === "..") return "Invalid name";
        if (ext && !v.toLowerCase().endsWith(ext.toLowerCase())) return `Keep the ${ext} extension`;
        return null;
      },
    });
    if (!newName || newName === name) return;
    try {
      await renameFile(state.type, state.subfolder, name, newName);
      const f = state.files.find((x) => x.name === name);
      if (f) f.name = newName;
      renderGrid();
    } catch (e) {
      reportError("Rename failed", e);
    }
  }

  async function onMove(name: string): Promise<void> {
    const dest = await pickDestination(modal, {
      type: state.type,
      subfolder: state.subfolder,
    });
    if (!dest) return;
    try {
      await moveFile(state.type, state.subfolder, name, dest.type, dest.subfolder);
      state.files = state.files.filter((f) => f.name !== name);
      renderGrid();
      notify({
        severity: "success",
        summary: "Moved",
        detail: `"${name}" → ${dest.type}${dest.subfolder ? `/${dest.subfolder}` : ""}`,
      });
    } catch (e) {
      reportError("Move failed", e);
    }
  }

  // ---- Render ----------------------------------------------------
  function renderTabs(): void {
    for (const b of tabsEl.querySelectorAll(".ib-tab")) {
      b.classList.toggle("is-active", (b as HTMLElement).dataset.type === state.type);
    }
  }

  function renderCrumbs(): void {
    crumbsEl.innerHTML = "";
    const mk = (text: string, attr: string, value: string) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "ib-crumb";
      b.setAttribute(attr, value);
      b.textContent = text;
      return b;
    };
    if (state.type === "path") {
      crumbsEl.appendChild(mk("/", "data-abs", "/"));
      let acc = "";
      for (const p of state.absPath.split("/").filter(Boolean)) {
        acc = `${acc}/${p}`;
        crumbsEl.appendChild(mk(p, "data-abs", acc));
      }
    } else {
      crumbsEl.appendChild(mk(state.type, "data-sub", ""));
      let acc = "";
      for (const p of state.subfolder.split("/").filter(Boolean)) {
        acc = acc ? `${acc}/${p}` : p;
        crumbsEl.appendChild(mk(p, "data-sub", acc));
      }
    }
  }

  async function loadAndRender(): Promise<void> {
    renderTabs();
    renderCrumbs();
    modal.setBusy(true);
    modal.setStatus("Loading…");
    try {
      const data = await fetchListing({
        type: state.type,
        subfolder: state.subfolder,
        path: state.absPath,
      });
      state.dirs = data.dirs || [];
      state.files = data.files || [];
      modal.setStatus(data.exists ? "" : "Directory not found.");
    } catch (e) {
      console.error(`[${EXT_NAME}] list failed:`, e);
      modal.setStatus(`Error: ${(e as Error).message}`);
      state.dirs = [];
      state.files = [];
    }
    modal.setBusy(false);
    renderGrid();
  }

  function thumbForFile(f: ListingFile): ThumbDescriptor {
    const ext = (f.ext || "").toLowerCase();
    if (IMG_EXTS.has(ext)) {
      return {
        kind: "img",
        src: imageThumbURL(state.type, state.subfolder, f.name, state.absPath),
      };
    }
    if (VIDEO_EXTS.has(ext)) {
      return {
        kind: "video",
        src: videoSrcURL(state.type, state.subfolder, f.name, state.absPath),
      };
    }
    return { kind: "icon", text: "📄" };
  }

  function renderGrid(): void {
    const q = state.query;
    gridEl.innerHTML = "";
    const canWrite = SANDBOXED_TYPES.includes(state.type);

    const showUp =
      state.type === "path" ? state.absPath && state.absPath !== "/" : !!state.subfolder;
    if (showUp) {
      const up = document.createElement("div");
      up.className = "ib-card is-up";
      up.innerHTML = `<div class="ib-thumb ib-thumb-icon">↑</div><div class="ib-name">..</div>`;
      gridEl.appendChild(up);
    }

    for (const d of state.dirs) {
      if (q && !d.name.toLowerCase().includes(q)) continue;
      const c = document.createElement("div");
      c.className = "ib-card is-dir";
      c.dataset.name = d.name;
      c.innerHTML = `<div class="ib-thumb ib-thumb-icon">📁</div><div class="ib-name" title="${escHTML(d.name)}">${escHTML(d.name)}</div>`;
      gridEl.appendChild(c);
    }

    let files = state.files;
    if (q) {
      const scored: { f: ListingFile; score: number }[] = [];
      for (const f of files) {
        const r = fuzzyScore(q, f.name);
        if (r) scored.push({ f, score: r.score });
      }
      scored.sort((a, b) => b.score - a.score);
      files = scored.map((x) => x.f);
    } else {
      files = sortFiles(files, state.sortKey, state.sortDir);
    }

    let visible = 0;
    for (const f of files) {
      const c = document.createElement("div");
      c.className = "ib-card is-file";
      c.dataset.name = f.name;
      c.dataset.ext = (f.ext || "").toLowerCase();
      const t = thumbForFile(f);
      const dims = f.width && f.height ? `${f.width}×${f.height}` : "";
      const when = new Date(f.mtime * 1000).toLocaleString();
      const titleText = dims ? `${f.name}\n${dims}\n${when}` : `${f.name}\n${when}`;
      const thumbInner =
        t.kind === "img"
          ? `<img loading="lazy" decoding="async" data-src="${t.src}" alt="">`
          : t.kind === "video"
            ? `<video muted playsinline preload="none" data-src="${t.src}"></video>`
            : `<div class="ib-thumb-icon">${t.text}</div>`;
      // Move is only offered for the sandboxed roots (backend rejects path writes).
      const moveBtn = canWrite
        ? `<button type="button" class="ib-act" data-action="move" title="Move">⇄</button>`
        : "";
      const writeBtns = canWrite
        ? `<button type="button" class="ib-act" data-action="rename" title="Rename">✎</button>
           ${moveBtn}
           <button type="button" class="ib-act ib-act-danger" data-action="delete" title="Delete">🗑</button>`
        : "";
      c.innerHTML = `
        <div class="ib-thumb">${thumbInner}</div>
        <div class="ib-name" title="${escHTML(titleText)}">${escHTML(f.name)}</div>
        ${dims ? `<div class="ib-meta">${dims}</div>` : ""}
        <div class="ib-actions">
          <button type="button" class="ib-act" data-action="open" title="Open full size">↗</button>
          ${writeBtns}
        </div>`;
      gridEl.appendChild(c);
      visible++;
    }

    if (!visible && !state.dirs.length && !showUp) {
      const el = document.createElement("div");
      el.className = "ib-empty";
      el.textContent = "No matching files in this folder.";
      gridEl.appendChild(el);
    }

    setCount(visible, state.files.length);
    installLazyThumbs(gridEl);
  }

  function installLazyThumbs(rootEl: HTMLElement): void {
    if (typeof IntersectionObserver === "undefined") return;
    const els = rootEl.querySelectorAll("img[data-src], video[data-src]");
    if (!els.length) return;
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          const el = e.target as HTMLImageElement | HTMLVideoElement;
          const src = (el as HTMLElement).dataset.src;
          if (src) {
            if (el.tagName === "VIDEO") (el as HTMLVideoElement).preload = "metadata";
            el.src = src;
            el.removeAttribute("data-src");
          }
          io.unobserve(el);
        }
      },
      { root: rootEl, rootMargin: "300px" },
    );
    for (const el of els) io.observe(el);
  }

  function reportError(summary: string, e: unknown): void {
    const detail = e instanceof Error ? e.message : String(e);
    console.warn(`[${EXT_NAME}] ${summary}:`, e);
    notify({ severity: "error", summary, detail });
  }

  loadAndRender();
  return modal;
}

// ============================================================
// Move-destination picker (folder navigator over the sandboxed roots)
// ============================================================

interface Destination {
  type: BrowseType;
  subfolder: string;
}

function pickDestination(
  modal: ModalShellController,
  start: Destination,
): Promise<Destination | null> {
  return new Promise((resolve) => {
    const ov = openOverlay(modal, () => resolve(null));
    ov.card.classList.add("ib-move-card");

    const cur: Destination = {
      type: SANDBOXED_TYPES.includes(start.type) ? start.type : "output",
      subfolder: start.subfolder,
    };

    const title = document.createElement("div");
    title.className = "ib-ov-title";
    title.textContent = "Move to…";

    const tabs = document.createElement("div");
    tabs.className = "ib-tabs";
    for (const t of SANDBOXED_TYPES) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "ib-tab";
      b.dataset.type = t;
      b.textContent = t;
      tabs.appendChild(b);
    }

    const crumbs = document.createElement("div");
    crumbs.className = "ib-crumbs";
    const list = document.createElement("div");
    list.className = "ib-move-list";
    const status = document.createElement("div");
    status.className = "ib-ov-msg";

    const row = document.createElement("div");
    row.className = "ib-ov-actions";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "ib-ov-btn";
    cancel.textContent = "Cancel";
    cancel.addEventListener("click", () => {
      ov.close();
      resolve(null);
    });
    const moveHere = document.createElement("button");
    moveHere.type = "button";
    moveHere.className = "ib-ov-btn ib-ov-primary";
    moveHere.addEventListener("click", () => {
      ov.close();
      resolve({ type: cur.type, subfolder: cur.subfolder });
    });
    row.append(cancel, moveHere);

    ov.card.append(title, tabs, crumbs, list, status, row);

    function renderCrumbs(): void {
      crumbs.innerHTML = "";
      const mk = (text: string, sub: string) => {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "ib-crumb";
        b.dataset.sub = sub;
        b.textContent = text;
        return b;
      };
      crumbs.appendChild(mk(cur.type, ""));
      let acc = "";
      for (const p of cur.subfolder.split("/").filter(Boolean)) {
        acc = acc ? `${acc}/${p}` : p;
        crumbs.appendChild(mk(p, acc));
      }
    }

    async function load(): Promise<void> {
      for (const b of tabs.querySelectorAll(".ib-tab"))
        b.classList.toggle("is-active", (b as HTMLElement).dataset.type === cur.type);
      renderCrumbs();
      moveHere.textContent = `Move to ${cur.type}${cur.subfolder ? `/${cur.subfolder}` : ""}`;
      list.innerHTML = "";
      status.textContent = "Loading…";
      try {
        const data = await fetchListing({ type: cur.type, subfolder: cur.subfolder });
        status.textContent = "";
        if (cur.subfolder) {
          const up = document.createElement("button");
          up.type = "button";
          up.className = "ib-move-row is-up";
          up.textContent = "↑ ..";
          list.appendChild(up);
        }
        if (!data.dirs.length && !cur.subfolder) {
          const none = document.createElement("div");
          none.className = "ib-ov-msg";
          none.textContent = "No subfolders — move into the root above.";
          list.appendChild(none);
        }
        for (const d of data.dirs) {
          const r = document.createElement("button");
          r.type = "button";
          r.className = "ib-move-row";
          r.dataset.name = d.name;
          r.textContent = `📁 ${d.name}`;
          list.appendChild(r);
        }
      } catch (e) {
        status.textContent = `Error: ${(e as Error).message}`;
      }
    }

    tabs.addEventListener("click", (e) => {
      const b = (e.target as HTMLElement).closest("[data-type]") as HTMLElement | null;
      if (!b) return;
      cur.type = b.dataset.type as BrowseType;
      cur.subfolder = "";
      load();
    });
    crumbs.addEventListener("click", (e) => {
      const c = (e.target as HTMLElement).closest("[data-sub]") as HTMLElement | null;
      if (!c) return;
      cur.subfolder = c.dataset.sub || "";
      load();
    });
    list.addEventListener("click", (e) => {
      const up = (e.target as HTMLElement).closest(".is-up");
      if (up) {
        const p = cur.subfolder.replace(/\/+$/, "");
        const i = p.lastIndexOf("/");
        cur.subfolder = i <= 0 ? "" : p.slice(0, i);
        load();
        return;
      }
      const r = (e.target as HTMLElement).closest("[data-name]") as HTMLElement | null;
      if (!r) return;
      const base = cur.subfolder.replace(/\/+$/, "");
      cur.subfolder = base ? `${base}/${r.dataset.name}` : (r.dataset.name as string);
      load();
    });

    load();
  });
}

// ============================================================
// Sorting
// ============================================================

function sortFiles(files: ListingFile[], key: string, dir: string): ListingFile[] {
  const mul = dir === "asc" ? 1 : -1;
  const nameCmp = (a: ListingFile, b: ListingFile) =>
    a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
  const numCmp =
    (getter: (f: ListingFile) => number | undefined) => (a: ListingFile, b: ListingFile) =>
      (getter(a) ?? 0) - (getter(b) ?? 0) || nameCmp(a, b);
  let cmp: (a: ListingFile, b: ListingFile) => number;
  switch (key) {
    case "name":
      cmp = nameCmp;
      break;
    case "size":
      cmp = numCmp((f) => f.size);
      break;
    case "pixels":
      cmp = numCmp((f) => (f.width && f.height ? f.width * f.height : 0));
      break;
    default:
      cmp = numCmp((f) => f.mtime);
      break;
  }
  return [...files].sort((a, b) => mul * cmp(a, b));
}

// ============================================================
// Styles
// ============================================================

function escHTML(s: unknown): string {
  return String(s).replace(
    /[&<>"']/g,
    (c) =>
      (
        ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }) as Record<
          string,
          string
        >
      )[c] as string,
  );
}

const BROWSER_CSS = `
.ib-dialog { width: 100vw !important; height: 100vh !important; max-height: 100vh !important; border-radius: 0; }
.image-browser-body { display: block; }
.ib-tabs {
    display: flex; gap: 2px; align-items: center;
    background: #1a1a22; border: 1px solid #2a2a32; border-radius: 4px; padding: 2px;
}
.ib-tab {
    background: transparent; color: #8a8a92; border: 0; border-radius: 3px;
    padding: 6px 12px; font-size: 12px; cursor: pointer; font-family: inherit;
    text-transform: capitalize; min-height: 32px;
}
.ib-tab:hover { background: #2a2a36; color: #e0e0e4; }
.ib-tab.is-active { background: #2f3a52; color: #9ec6ff; }
.ib-crumbs { display: flex; flex-wrap: wrap; gap: 4px; align-items: center; flex: 1; min-width: 0; }
.ib-crumb {
    background: #2a2a36; color: #b8b8c0; border: 1px solid #3a3a44; border-radius: 4px;
    padding: 6px 10px; font-size: 12px; cursor: pointer; font-family: inherit; min-height: 32px;
}
.ib-crumb:hover { background: #3a3a4a; color: #fff; }
.ib-control {
    background: #2a2a36; color: #d8d8dc; border: 1px solid #3a3a44; border-radius: 4px;
    padding: 6px 8px; font-size: 12px; cursor: pointer; font-family: inherit; min-height: 32px;
}
.ib-control:hover { background: #3a3a4a; color: #fff; }
.ib-icon { min-width: 34px; text-align: center; }
.ib-grid {
    display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
    gap: 10px; padding: 4px;
}
.ib-card {
    background: #21212a; border: 1px solid #2a2a32; border-radius: 6px; overflow: hidden;
    cursor: pointer; display: flex; flex-direction: column;
    transition: transform 0.06s ease, border-color 0.1s ease;
}
.ib-card:hover { border-color: #6ba6ff; transform: translateY(-1px); }
.ib-card.is-up, .ib-card.is-dir { background: #1f1f26; }
.ib-thumb {
    aspect-ratio: 1 / 1; display: flex; align-items: center; justify-content: center;
    background: #12121a; overflow: hidden;
}
.ib-thumb-icon { font-size: 32px; color: #777; }
.ib-thumb img, .ib-thumb video {
    width: 100%; height: 100%; object-fit: cover; display: block; background: #000;
}
.ib-name {
    padding: 6px 8px; font-size: 11.5px; color: #d8d8dc; white-space: nowrap;
    text-overflow: ellipsis; overflow: hidden;
    font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
}
.ib-meta { padding: 0 8px 4px; font-size: 10.5px; color: #888; }
.ib-actions { display: flex; gap: 2px; padding: 0 6px 6px; margin-top: auto; }
.ib-act {
    flex: 1; background: #2a2a36; color: #b8b8c0; border: 1px solid #33333f; border-radius: 4px;
    padding: 6px 0; font-size: 13px; line-height: 1; cursor: pointer; font-family: inherit;
    min-height: 34px;
}
.ib-act:hover { background: #3a3a4a; color: #fff; }
.ib-act-danger:hover { background: #5c2a3c; color: #ff9eb0; }
.ib-empty { grid-column: 1 / -1; padding: 48px; text-align: center; color: #777; font-style: italic; }
.ib-count { color: #888; }
.ib-move-card { width: min(560px, calc(100% - 24px)); }
.ib-move-list {
    display: flex; flex-direction: column; gap: 2px; max-height: 40vh; overflow-y: auto;
    border: 1px solid #2a2a32; border-radius: 6px; padding: 4px; background: #17171e;
}
.ib-move-row {
    text-align: left; background: transparent; color: #cfcfd6; border: 0; border-radius: 4px;
    padding: 10px 12px; font-size: 13px; cursor: pointer; font-family: inherit; min-height: 40px;
}
.ib-move-row:hover { background: #2a2a3a; color: #fff; }
.cmp-match { color: #ffd866; font-weight: 700; }
`;

function ensureStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement("style");
  s.id = STYLE_ID;
  s.textContent = BROWSER_CSS + OVERLAY_CSS;
  document.head.appendChild(s);
}
