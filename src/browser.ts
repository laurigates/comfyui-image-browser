// browser.ts — the full-canvas image browser view.
//
// Reuses the card-grid file-explorer pattern proven in comfyui-gallery-loader's
// image-picker (breadcrumbs, thumbnail grid, lazy-load, sort, fuzzy search), but
// as a STANDALONE full-viewport view launched from the app chrome rather than a
// per-widget modal — and it MANAGES files (delete / rename / move) instead of
// committing a value to a node widget.

import type { ModalShellController, RatingAddress } from "@laurigates/comfy-modal-kit";
import {
  applyStars,
  fuzzyScore,
  nextRating,
  notify,
  openModalShell,
  postRating,
  ratingOf,
  starsHTML,
} from "@laurigates/comfy-modal-kit";
import {
  type BatchItem,
  type BrowseType,
  deleteFile,
  deleteMany,
  EXT_NAME,
  fetchBasePaths,
  fetchListing,
  fullSrcURL,
  IMG_EXTS,
  imageThumbURL,
  joinAbs,
  type ListingFile,
  moveFile,
  moveMany,
  RATING_URL,
  renameFile,
  SANDBOXED_TYPES,
  thumbVersion,
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
  "rating:desc",
  "rating:asc",
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
    footerLeftHTML: "<kbd>j/k</kbd> navigate · <kbd>?</kbd> help · <kbd>Esc</kbd> close",
    footerRightHTML: '<span class="ib-count"></span>',
    // Fires on EVERY teardown path (Esc, × button, backdrop, coordinator
    // dismiss) — the controller.close wrapper does not, so keyboard cleanup
    // must hang off onClose or the window listener leaks after close.
    onClose: () => window.removeEventListener("keydown", onWindowKey, true),
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
    <option value="pixels:desc">Highest resolution</option>
    <option value="rating:desc">Highest rating</option>
    <option value="rating:asc">Lowest rating</option>`;
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

  // ---- Vim-style keyboard navigation state ----------------------
  // Selection persists across tabs/dirs; key `${type}:${subfolder}:${name}`.
  // `type=path` is never selectable (backend rejects path writes).
  const selected = new Map<string, { file: ListingFile; type: BrowseType; subfolder: string }>();
  let focusIndex = -1;
  let visualMode = false;
  let visualAnchor = 0;
  let pendingOp: "d" | "y" | "g" | null = null;
  let pendingTimer: ReturnType<typeof setTimeout> | null = null;
  let yanked: BatchItem[] | null = null;
  let renderedFiles: ListingFile[] = [];

  const selectedBadge = document.createElement("span");
  selectedBadge.className = "ib-selected-badge";
  selectedBadge.style.display = "none";
  modal.headerEl.appendChild(selectedBadge);

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
    const star = target.closest(".ib-star") as HTMLElement | null;
    if (star) {
      e.stopPropagation();
      const row = star.closest(".ib-stars") as HTMLElement | null;
      // Interactive stars only render for the sandboxed roots (canWrite);
      // the defensive gate keeps a stale DOM from posting a path write.
      if (!row || !SANDBOXED_TYPES.includes(state.type)) return;
      const cur = Number(row.dataset.rating || "0");
      setStarRating(name, row, nextRating(cur, Number(star.dataset.val)));
      return;
    }
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
  function setStarRating(name: string, row: HTMLElement, next: number): void {
    const prev = Number(row.dataset.rating || "0");
    applyStars(row, next);
    const f = state.files.find((x) => x.name === name);
    if (f) f.rating = next;
    const addr: RatingAddress = {
      type: state.type,
      subfolder: state.subfolder,
      absDir: state.absPath,
      name,
    };
    postRating(RATING_URL, addr, next)
      .then((confirmed) => {
        if (confirmed !== next) {
          applyStars(row, confirmed);
          if (f) f.rating = confirmed;
        }
      })
      .catch((e) => {
        reportError("Rating failed", e);
        applyStars(row, prev);
        if (f) f.rating = prev;
      });
  }

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
    focusIndex = 0;
    visualMode = false;
    modal.dialog.classList.remove("is-visual");
    clearPending();
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
        src: imageThumbURL(
          state.type,
          state.subfolder,
          f.name,
          state.absPath,
          thumbVersion(f.mtime, f.size),
        ),
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
    renderedFiles = files;
    if (files.length === 0) focusIndex = -1;
    else if (focusIndex < 0) focusIndex = 0;
    else if (focusIndex >= files.length) focusIndex = files.length - 1;

    let visible = 0;
    for (let fi = 0; fi < files.length; fi++) {
      const f = files[fi];
      if (!f) continue;
      const c = document.createElement("div");
      c.className = "ib-card is-file";
      if (fi === focusIndex) c.classList.add("is-focused");
      if (isSelected(f)) c.classList.add("is-selected");
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
      // Rating writes are sandboxed like the other mutations, so path mode
      // gets a read-only star display (when rated) instead of dead buttons.
      const starsRow = canWrite
        ? starsHTML("ib", ratingOf(f))
        : ratingOf(f)
          ? `<div class="ib-stars is-ro" data-rating="${ratingOf(f)}">${"★".repeat(ratingOf(f))}</div>`
          : "";
      c.innerHTML = `
        <div class="ib-thumb">${thumbInner}</div>
        <div class="ib-name" title="${escHTML(titleText)}">${escHTML(f.name)}</div>
        ${dims ? `<div class="ib-meta">${dims}</div>` : ""}
        ${starsRow}
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
    const focusedCard = gridEl.querySelector(".ib-card.is-focused") as HTMLElement | null;
    focusedCard?.scrollIntoView({ block: "nearest", inline: "nearest" });
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

  // ---- Vim-style keyboard navigation -----------------------------
  function isInInput(): boolean {
    const el = document.activeElement;
    if (!el) return false;
    const tag = el.tagName;
    return (
      tag === "INPUT" ||
      tag === "TEXTAREA" ||
      tag === "SELECT" ||
      (el as HTMLElement).isContentEditable
    );
  }

  function selectionKey(type: BrowseType, subfolder: string, name: string): string {
    return `${type}:${subfolder}:${name}`;
  }

  function isSelected(f: ListingFile): boolean {
    if (state.type === "path") return false;
    return selected.has(selectionKey(state.type, state.subfolder, f.name));
  }

  function fileCards(): HTMLElement[] {
    return Array.from(gridEl.querySelectorAll<HTMLElement>(".ib-card.is-file"));
  }

  function gridColumns(): number {
    const cards = fileCards();
    if (cards.length < 2) return 1;
    const top = cards[0]?.offsetTop ?? 0;
    let n = 0;
    for (const c of cards) {
      if (c.offsetTop !== top) break;
      n++;
    }
    return Math.max(1, n);
  }

  function applyFocus(): void {
    for (const [i, c] of fileCards().entries()) {
      c.classList.toggle("is-focused", i === focusIndex);
    }
    const focused = gridEl.querySelector(".ib-card.is-focused") as HTMLElement | null;
    focused?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }

  function refreshSelectionClasses(): void {
    for (const [i, c] of fileCards().entries()) {
      const f = renderedFiles[i];
      c.classList.toggle("is-selected", !!f && isSelected(f));
    }
  }

  function moveFocus(delta: number): void {
    const n = renderedFiles.length;
    if (n === 0) return;
    focusIndex = Math.max(0, Math.min(n - 1, focusIndex + delta));
    if (visualMode) extendSelectionTo(focusIndex);
    applyFocus();
  }

  function focusFirst(): void {
    const n = renderedFiles.length;
    if (n === 0) return;
    focusIndex = 0;
    if (visualMode) extendSelectionTo(focusIndex);
    applyFocus();
  }

  function focusLast(): void {
    const n = renderedFiles.length;
    if (n === 0) return;
    focusIndex = n - 1;
    if (visualMode) extendSelectionTo(focusIndex);
    applyFocus();
  }

  function updateSelectedCount(): void {
    const n = selected.size;
    selectedBadge.style.display = n > 0 ? "inline" : "none";
    selectedBadge.textContent = n > 0 ? `${n} selected` : "";
  }

  function toggleSelectionAt(i: number): void {
    if (!SANDBOXED_TYPES.includes(state.type)) return;
    const f = renderedFiles[i];
    if (!f) return;
    const key = selectionKey(state.type, state.subfolder, f.name);
    if (selected.has(key)) selected.delete(key);
    else selected.set(key, { file: f, type: state.type, subfolder: state.subfolder });
    refreshSelectionClasses();
    updateSelectedCount();
  }

  function extendSelectionTo(i: number): void {
    if (!SANDBOXED_TYPES.includes(state.type)) return;
    const lo = Math.min(visualAnchor, i);
    const hi = Math.max(visualAnchor, i);
    for (let k = lo; k <= hi; k++) {
      const f = renderedFiles[k];
      if (!f) continue;
      const key = selectionKey(state.type, state.subfolder, f.name);
      if (!selected.has(key))
        selected.set(key, { file: f, type: state.type, subfolder: state.subfolder });
    }
    refreshSelectionClasses();
    updateSelectedCount();
  }

  function selectAllVisible(): void {
    if (!SANDBOXED_TYPES.includes(state.type)) return;
    for (const f of renderedFiles) {
      const key = selectionKey(state.type, state.subfolder, f.name);
      if (!selected.has(key))
        selected.set(key, { file: f, type: state.type, subfolder: state.subfolder });
    }
    refreshSelectionClasses();
    updateSelectedCount();
  }

  function clearSelection(): void {
    selected.clear();
    refreshSelectionClasses();
    updateSelectedCount();
  }

  function toggleVisualMode(): void {
    if (!SANDBOXED_TYPES.includes(state.type)) return;
    if (renderedFiles.length === 0) return;
    visualMode = !visualMode;
    if (visualMode) {
      if (focusIndex < 0) focusIndex = 0;
      visualAnchor = focusIndex;
      extendSelectionTo(focusIndex);
    }
    modal.dialog.classList.toggle("is-visual", visualMode);
  }

  function collectSelectedOrFocused(): BatchItem[] {
    if (selected.size > 0) {
      return Array.from(selected.values()).map((v) => ({
        type: v.type,
        subfolder: v.subfolder,
        name: v.file.name,
      }));
    }
    const f = renderedFiles[focusIndex];
    if (!f || state.type === "path") return [];
    return [{ type: state.type, subfolder: state.subfolder, name: f.name }];
  }

  function setPending(op: "d" | "y" | "g"): void {
    clearPending();
    pendingOp = op;
    pendingTimer = setTimeout(clearPending, 1500);
    const hint =
      op === "d" ? "d… (d/y=delete, n=cancel)" : op === "y" ? "y… (y=yank)" : "g… (g=top)";
    modal.setStatus(hint);
  }

  function clearPending(): void {
    if (pendingTimer) {
      clearTimeout(pendingTimer);
      pendingTimer = null;
    }
    pendingOp = null;
    modal.setStatus("");
  }

  async function doDelete(): Promise<void> {
    if (!SANDBOXED_TYPES.includes(state.type)) return;
    const items = collectSelectedOrFocused();
    if (items.length === 0) return;
    const count = items.length;
    const ok = await confirmAction(modal, {
      title: count === 1 ? "Delete file?" : `Delete ${count} files?`,
      message:
        count === 1
          ? `Permanently delete "${items[0]?.name}"? This cannot be undone.`
          : `Permanently delete ${count} selected files? This cannot be undone.`,
      confirmLabel: "Delete",
      danger: true,
    });
    if (!ok) return;
    try {
      const result = await deleteMany(items);
      const errored = new Set((result.errors ?? []).map((e) => e.name));
      // items span all folders (selection persists across tabs); state.files is
      // only the current folder — so scope the view removal to items that match
      // this folder, not by bare name (a same-named file elsewhere must stay).
      const removedHere = new Set(
        items
          .filter(
            (it) =>
              it.type === state.type && it.subfolder === state.subfolder && !errored.has(it.name),
          )
          .map((it) => it.name),
      );
      state.files = state.files.filter((f) => !removedHere.has(f.name));
      for (const it of items) {
        if (!errored.has(it.name)) selected.delete(selectionKey(it.type, it.subfolder, it.name));
      }
      updateSelectedCount();
      renderGrid();
      if (result.errors && result.errors.length > 0) {
        const names = result.errors.map((e) => e.name).join(", ");
        reportError(`Deleted ${result.deleted}, ${result.errors.length} failed`, new Error(names));
      } else {
        notify({ severity: "success", summary: "Deleted", detail: `${result.deleted} file(s)` });
      }
    } catch (e) {
      reportError("Delete failed", e);
    }
  }

  function doYank(): void {
    if (!SANDBOXED_TYPES.includes(state.type)) return;
    const items = collectSelectedOrFocused();
    if (items.length === 0) return;
    yanked = items;
    notify({
      severity: "info",
      summary: "Yanked",
      detail: `${items.length} file(s) — press p to move here`,
    });
  }

  async function doPaste(): Promise<void> {
    if (!SANDBOXED_TYPES.includes(state.type)) return;
    if (!yanked || yanked.length === 0) {
      notify({ severity: "info", summary: "Nothing to paste", detail: "Yank files first with yy" });
      return;
    }
    try {
      const result = await moveMany(yanked, state.type, state.subfolder);
      for (const it of yanked) {
        const errored = result.errors?.some((e) => e.name === it.name);
        if (!errored) selected.delete(selectionKey(it.type, it.subfolder, it.name));
      }
      yanked = null;
      updateSelectedCount();
      await loadAndRender();
      if (result.errors && result.errors.length > 0) {
        const names = result.errors.map((e) => e.name).join(", ");
        reportError(`Moved ${result.moved}, ${result.errors.length} failed`, new Error(names));
      } else {
        notify({ severity: "success", summary: "Moved", detail: `${result.moved} file(s)` });
      }
    } catch (e) {
      reportError("Paste (move) failed", e);
    }
  }

  async function siblingNav(dir: -1 | 1): Promise<void> {
    // Navigate to the previous/next sibling directory (alphabetical).
    let parentType: BrowseType;
    let parentSub: string;
    let parentPath: string;
    let currentName: string;
    if (state.type === "path") {
      const p = (state.absPath || "/").replace(/\/+$/, "");
      if (p === "" || p === "/") return; // at root
      const i = p.lastIndexOf("/");
      parentPath = i <= 0 ? "/" : p.slice(0, i);
      parentType = "path";
      parentSub = "";
      currentName = p.slice(i + 1);
    } else {
      const p = state.subfolder.replace(/\/+$/, "");
      if (!p) return; // at root of this sandbox
      const i = p.lastIndexOf("/");
      parentSub = i <= 0 ? "" : p.slice(0, i);
      parentType = state.type;
      parentPath = "";
      currentName = p.slice(i + 1);
    }
    try {
      const data = await fetchListing({
        type: parentType,
        subfolder: parentSub,
        path: parentPath,
      });
      const dirs = (data.dirs || []).map((d) => d.name).sort();
      const idx = dirs.indexOf(currentName);
      if (idx < 0) return;
      const next = idx + dir;
      if (next < 0 || next >= dirs.length) return; // at end
      const target = dirs[next];
      if (!target) return;
      if (state.type === "path") {
        state.absPath = parentPath === "/" ? `/${target}` : `${parentPath}/${target}`;
      } else {
        state.subfolder = parentSub ? `${parentSub}/${target}` : target;
      }
      focusIndex = 0;
      await loadAndRender();
    } catch (e) {
      reportError("Sibling navigation failed", e);
    }
  }

  function showHelp(): void {
    const ov = openOverlay(modal, () => {});
    ov.card.classList.add("ib-help-card");
    ov.card.innerHTML = `
      <div class="ib-ov-title">Keyboard shortcuts</div>
      <div class="ib-help-body">
        <div class="ib-help-col">
          <div class="ib-help-h">Navigate</div>
          <dl>
            <dt>j / k</dt><dd>down / up row</dd>
            <dt>h / l</dt><dd>left / right</dd>
            <dt>g g</dt><dd>first file</dd>
            <dt>G</dt><dd>last file</dd>
            <dt>K</dt><dd>parent dir</dd>
            <dt>H / L</dt><dd>prev / next sibling</dd>
          </dl>
        </div>
        <div class="ib-help-col">
          <div class="ib-help-h">Select</div>
          <dl>
            <dt>Space</dt><dd>toggle focused</dd>
            <dt>v</dt><dd>visual mode</dd>
            <dt>Ctrl+A</dt><dd>select all visible</dd>
            <dt>Esc</dt><dd>clear selection</dd>
          </dl>
        </div>
        <div class="ib-help-col">
          <div class="ib-help-h">Act</div>
          <dl>
            <dt>d d</dt><dd>delete selected</dd>
            <dt>d y</dt><dd>confirm delete</dd>
            <dt>y y</dt><dd>yank (cut) selected</dd>
            <dt>p</dt><dd>paste (move) here</dd>
            <dt>r</dt><dd>rename focused</dd>
            <dt>m</dt><dd>move focused…</dd>
          </dl>
        </div>
        <div class="ib-help-col">
          <div class="ib-help-h">Other</div>
          <dl>
            <dt>Enter / o</dt><dd>open preview</dd>
            <dt>/</dt><dd>focus search</dd>
            <dt>?</dt><dd>this help</dd>
            <dt>Esc</dt><dd>close (priority)</dd>
          </dl>
        </div>
      </div>
      <div class="ib-ov-actions">
        <button type="button" class="ib-ov-btn ib-ov-primary" data-help-close>Close</button>
      </div>`;
    const closeBtn = ov.card.querySelector("[data-help-close]") as HTMLButtonElement | null;
    closeBtn?.addEventListener("click", () => ov.close());
  }

  function onWindowKey(e: KeyboardEvent): void {
    // Skip when any overlay is open (confirm / prompt / help / move-picker).
    if (modal.dialog.querySelector(".ib-ov-backdrop")) return;
    const inInput = isInInput();

    // ESC — priority: input → pending → visual → selection → let shell close.
    if (e.key === "Escape") {
      if (inInput) {
        (document.activeElement as HTMLElement | null)?.blur();
      } else if (pendingOp) {
        clearPending();
      } else if (visualMode) {
        visualMode = false;
        modal.dialog.classList.remove("is-visual");
      } else if (selected.size > 0) {
        clearSelection();
      } else {
        return; // let the modal shell close the browser
      }
      e.preventDefault();
      e.stopPropagation();
      return;
    }

    if (inInput) return;

    // Ctrl+A — select all visible.
    if (e.ctrlKey && !e.metaKey && !e.altKey && (e.key === "a" || e.key === "A")) {
      e.preventDefault();
      e.stopPropagation();
      selectAllVisible();
      return;
    }

    // Only plain keys — no Ctrl/Cmd/Alt (Shift is OK).
    if (e.ctrlKey || e.metaKey || e.altKey) return;

    // Pending operator sequences (d / y / g).
    if (pendingOp) {
      const op = pendingOp;
      clearPending();
      if (op === "d" && (e.key === "d" || e.key === "y" || e.key === "Enter")) {
        e.preventDefault();
        e.stopPropagation();
        void doDelete();
        return;
      }
      if (op === "d" && (e.key === "n" || e.key === "Escape")) {
        e.preventDefault();
        e.stopPropagation();
        return; // cancel
      }
      if (op === "y" && e.key === "y") {
        e.preventDefault();
        e.stopPropagation();
        doYank();
        return;
      }
      if (op === "g" && e.key === "g") {
        e.preventDefault();
        e.stopPropagation();
        focusFirst();
        return;
      }
      // Any other key cancels the pending op and falls through to the single-key switch.
    }

    const f = renderedFiles[focusIndex];

    switch (e.key) {
      case "j":
        e.preventDefault();
        e.stopPropagation();
        moveFocus(gridColumns());
        break;
      case "k":
        e.preventDefault();
        e.stopPropagation();
        moveFocus(-gridColumns());
        break;
      case "h":
        e.preventDefault();
        e.stopPropagation();
        moveFocus(-1);
        break;
      case "l":
        e.preventDefault();
        e.stopPropagation();
        moveFocus(1);
        break;
      case "G":
        e.preventDefault();
        e.stopPropagation();
        focusLast();
        break;
      case "K":
        e.preventDefault();
        e.stopPropagation();
        navigateUp();
        break;
      case "H":
        e.preventDefault();
        e.stopPropagation();
        void siblingNav(-1);
        break;
      case "L":
        e.preventDefault();
        e.stopPropagation();
        void siblingNav(1);
        break;
      case "g":
        e.preventDefault();
        e.stopPropagation();
        setPending("g");
        break;
      case "d":
        e.preventDefault();
        e.stopPropagation();
        setPending("d");
        break;
      case "y":
        e.preventDefault();
        e.stopPropagation();
        setPending("y");
        break;
      case "p":
        e.preventDefault();
        e.stopPropagation();
        void doPaste();
        break;
      case " ":
        e.preventDefault();
        e.stopPropagation();
        toggleSelectionAt(focusIndex);
        break;
      case "v":
        e.preventDefault();
        e.stopPropagation();
        toggleVisualMode();
        break;
      case "Enter":
      case "o":
        e.preventDefault();
        e.stopPropagation();
        if (f) openFull(f.name, f.ext || "");
        break;
      case "r":
        if (SANDBOXED_TYPES.includes(state.type) && f) {
          e.preventDefault();
          e.stopPropagation();
          void onRename(f.name);
        }
        break;
      case "m":
        if (SANDBOXED_TYPES.includes(state.type) && f) {
          e.preventDefault();
          e.stopPropagation();
          void onMove(f.name);
        }
        break;
      case "/":
        e.preventDefault();
        e.stopPropagation();
        modal.searchEl.focus();
        break;
      case "?":
        e.preventDefault();
        e.stopPropagation();
        showHelp();
        break;
      default:
        break;
    }
  }

  // Window capture fires BEFORE the shell's document capture, so ESC can be
  // intercepted and stopPropagation'd to keep the modal open while selection
  // is non-empty. Removed on close via the shell's onClose (see openModalShell)
  // — the shell's real close paths bypass controller.close, so wrapping it
  // would leak this listener.
  window.addEventListener("keydown", onWindowKey, true);

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
    case "rating":
      cmp = numCmp((f) => f.rating);
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
.ib-stars { display: flex; justify-content: center; gap: 1px; padding: 0 6px 4px; }
.ib-star {
    appearance: none; background: transparent; border: 0; padding: 5px 4px;
    font-size: 15px; line-height: 1; color: #555; cursor: pointer;
    min-width: 26px; min-height: 26px;
}
.ib-star.is-on, .ib-star:hover { color: #ffd866; }
@media (max-width: 600px) {
    .ib-star { font-size: 18px; padding: 7px 5px; min-width: 30px; min-height: 32px; }
}
.ib-stars.is-ro { color: #ffd866; font-size: 12px; cursor: default; }
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
.ib-card.is-focused { outline: 2px solid #6ba6ff; outline-offset: -2px; z-index: 1; }
.ib-card.is-selected { border-color: #ffd866; background: #2a2a1f; }
.ib-card.is-selected.is-focused { outline-color: #ffd866; }
.ib-dialog.is-visual .ib-grid { outline: 2px solid #ffd866; outline-offset: -2px; }
.ib-selected-badge {
    background: #2f3a52; color: #9ec6ff; border: 1px solid #4a5878; border-radius: 10px;
    padding: 2px 8px; font-size: 11px; margin-left: 8px; display: inline;
}
.ib-help-card { width: min(640px, calc(100% - 24px)); max-height: calc(100% - 24px); }
.ib-help-body {
    display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
    gap: 12px; overflow-y: auto; padding: 8px 0;
}
.ib-help-col { display: flex; flex-direction: column; gap: 4px; }
.ib-help-h { font-size: 12px; font-weight: 600; color: #9ec6ff; text-transform: uppercase; letter-spacing: 0.5px; }
.ib-help-body dl { margin: 0; display: flex; flex-direction: column; gap: 2px; }
.ib-help-body dt {
    font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
    font-size: 11.5px; color: #ffd866;
}
.ib-help-body dd { margin: 0 0 4px 0; font-size: 11.5px; color: #b8b8c0; }
`;

function ensureStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement("style");
  s.id = STYLE_ID;
  s.textContent = BROWSER_CSS + OVERLAY_CSS;
  document.head.appendChild(s);
}
