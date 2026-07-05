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
  removeDir,
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

// Last successful move destination — the picker opens there next time, so
// sorting a batch of files into the same folder is one tap per file.
const MOVE_DEST_STORAGE_KEY = "comfyui-image-browser:move-dest";

function loadSavedDest(): Destination | null {
  try {
    const raw = localStorage.getItem(MOVE_DEST_STORAGE_KEY);
    if (!raw) return null;
    const i = raw.indexOf(":");
    if (i < 0) return null;
    const type = raw.slice(0, i) as BrowseType;
    if (!SANDBOXED_TYPES.includes(type)) return null;
    return { type, subfolder: raw.slice(i + 1) };
  } catch {
    return null;
  }
}

function saveDest(d: Destination): void {
  try {
    localStorage.setItem(MOVE_DEST_STORAGE_KEY, `${d.type}:${d.subfolder}`);
  } catch {
    /* private-mode / disabled storage — non-fatal */
  }
}

// Per-directory scroll positions — traversing up/down (or hopping via tabs,
// crumbs, siblings, pins) returns each folder to where you left it. Module
// level so reopening the browser restores too; entering a never-visited
// folder still starts at the top.
const scrollMemory = new Map<string, number>();

// Pinned directories — quick-nav chips in the toolbar and shortcut rows in
// the move-destination picker, for sorting big batches between a few folders.
// Sandboxed roots only (pins exist to reach write targets fast).
const PINS_STORAGE_KEY = "comfyui-image-browser:pins";

interface Pin {
  type: BrowseType;
  subfolder: string;
}

function pinKey(p: Pin): string {
  return `${p.type}:${p.subfolder}`;
}

function pinLabel(p: Pin): string {
  return `${p.type}${p.subfolder ? `/${p.subfolder}` : ""}`;
}

function loadPins(): Pin[] {
  try {
    const raw = localStorage.getItem(PINS_STORAGE_KEY);
    if (!raw) return [];
    const arr: unknown = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr.filter(
      (p): p is Pin =>
        !!p &&
        typeof (p as Pin).subfolder === "string" &&
        SANDBOXED_TYPES.includes((p as Pin).type),
    );
  } catch {
    return [];
  }
}

function savePins(pins: Pin[]): void {
  try {
    localStorage.setItem(PINS_STORAGE_KEY, JSON.stringify(pins));
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

  // Set when the hardware/gesture back button (popstate) closed the browser —
  // on that path the sentinel history entry is already consumed (see onPopState).
  let closedByBack = false;

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
    onClose: () => {
      // Remember where this folder was scrolled to so reopening the browser
      // (scrollMemory is module-level) resumes in place.
      rememberScroll();
      window.removeEventListener("keydown", onWindowKey, true);
      window.removeEventListener("popstate", onPopState);
      // Pop the back-button sentinel unless back itself closed the browser.
      if (!closedByBack) history.back();
    },
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

  // Touch entry point into multi-select — the keyboard path (Space / v) has no
  // affordance on a phone. Hidden on the browse-only path tab (renderTabs).
  const selectToggleEl = document.createElement("button");
  selectToggleEl.type = "button";
  selectToggleEl.className = "ib-control ib-icon ib-select-toggle";
  selectToggleEl.title = "Select multiple";
  selectToggleEl.textContent = "☑";

  // Pin the folder you're looking at; hidden on the browse-only path tab
  // (pins are write-target shortcuts, and pin state renders in renderPins).
  const pinToggleEl = document.createElement("button");
  pinToggleEl.type = "button";
  pinToggleEl.className = "ib-control ib-icon ib-pin-toggle";
  pinToggleEl.title = "Pin this folder";
  pinToggleEl.textContent = "📌";

  // One-tap navigation chips for the pinned folders; hidden while empty.
  const pinsEl = document.createElement("div");
  pinsEl.className = "ib-pins";

  modal.toolbarEl.append(tabsEl, crumbsEl, selectToggleEl, pinToggleEl, sortEl, refreshEl, pinsEl);

  // ---- Grid ------------------------------------------------------
  const gridEl = document.createElement("div");
  gridEl.className = "ib-grid";
  root.appendChild(gridEl);

  // The modal shell's body (.cmp-body) is the overflow-y:auto container the
  // grid scrolls in — renderGrid saves/restores its scrollTop so deletes,
  // moves, renames and rating changes don't fling the view back to the top.
  const scrollHost = modal.bodyEl;

  // ---- Floating batch-action bar (visible while a selection exists) ----
  const selBar = document.createElement("div");
  selBar.className = "ib-selbar";
  selBar.innerHTML = `
    <span class="ib-selbar-count"></span>
    <button type="button" class="ib-selbar-btn" data-selbar="move">⇄ Move…</button>
    <button type="button" class="ib-selbar-btn ib-selbar-danger" data-selbar="delete">🗑 Delete</button>
    <button type="button" class="ib-selbar-btn" data-selbar="clear">✕</button>`;
  const selBarCount = selBar.querySelector(".ib-selbar-count") as HTMLElement;
  modal.dialog.appendChild(selBar);

  const countEl = modal.footerEl.querySelector(".ib-count") as HTMLElement | null;
  function setCount(visible: number, total: number): void {
    if (countEl) countEl.textContent = `${visible} / ${total}`;
  }

  // ---- Vim-style keyboard navigation state ----------------------
  // Selection persists across tabs/dirs; key `${type}:${subfolder}:${name}`.
  // `type=path` is never selectable (backend rejects path writes).
  const selected = new Map<string, { file: ListingFile; type: BrowseType; subfolder: string }>();
  // Touch select mode: while on, tapping a card toggles selection instead of
  // opening it. Entered via the ☑ toolbar toggle or a long-press on a card.
  let selectMode = false;
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
  // Key for the CURRENT location's scroll-memory slot. Distinct namespaces
  // for the sandboxed roots (`type:subfolder`) and path mode (`path:/abs`).
  function locationKey(): string {
    return state.type === "path" ? `path:${state.absPath}` : `${state.type}:${state.subfolder}`;
  }

  // Called on every navigation BEFORE the location mutates, so returning to
  // this folder later (up, chip, tab, crumb) lands where the user left off.
  function rememberScroll(): void {
    scrollMemory.set(locationKey(), scrollHost.scrollTop);
  }

  function navigateUp(): void {
    rememberScroll();
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
    rememberScroll();
    if (state.type === "path") {
      state.absPath = joinAbs(state.absPath, name);
    } else {
      const base = state.subfolder.replace(/\/+$/, "");
      state.subfolder = base ? `${base}/${name}` : name;
    }
    loadAndRender();
  }

  async function switchType(type: BrowseType): Promise<void> {
    rememberScroll();
    state.type = type;
    state.subfolder = "";
    if (type === "path") {
      const bp = await fetchBasePaths();
      state.absPath = bp.base_path || "/";
    }
    loadAndRender();
  }

  // ---- Android/mobile back button --------------------------------
  // A sentinel history entry is pushed while the browser is open, so the
  // hardware/gesture back pops it instead of leaving ComfyUI. The pop handler
  // dismisses an open overlay, else ascends one directory (re-arming the
  // sentinel each time), and only closes the browser at a root. Every other
  // close path pops the still-unconsumed sentinel from onClose instead.
  function canGoUp(): boolean {
    return state.type === "path" ? !!state.absPath && state.absPath !== "/" : !!state.subfolder;
  }

  function onPopState(): void {
    const hasOverlay = !!modal.dialog.querySelector(".ib-ov-backdrop");
    if (hasOverlay || canGoUp()) {
      history.pushState({ modal: EXT_NAME }, ""); // re-arm before acting
      if (hasOverlay) {
        // Route through the overlay's ESC path so its onDismiss fires.
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", cancelable: true }));
      } else {
        navigateUp();
      }
      return;
    }
    closedByBack = true;
    modal.close();
  }
  history.pushState({ modal: EXT_NAME }, "");
  window.addEventListener("popstate", onPopState);

  // ---- Wiring ----------------------------------------------------
  modal.searchEl.addEventListener("input", () => {
    state.query = modal.searchEl.value.toLowerCase().trim();
    renderGrid();
    // New filter → read results from the top (renderGrid otherwise restores
    // the previous scroll position, which is for in-place mutations).
    scrollHost.scrollTop = 0;
  });
  sortEl.addEventListener("change", () => {
    const [k, d] = sortEl.value.split(":");
    state.sortKey = k as string;
    state.sortDir = d as string;
    saveSort(k as string, d as string);
    renderGrid();
    scrollHost.scrollTop = 0;
  });
  refreshEl.addEventListener("click", () => loadAndRender({ preserveScroll: true }));
  selectToggleEl.addEventListener("click", () => setSelectMode(!selectMode));
  pinToggleEl.addEventListener("click", () => {
    if (!SANDBOXED_TYPES.includes(state.type)) return;
    const cur: Pin = { type: state.type, subfolder: state.subfolder };
    const pins = loadPins();
    const next = pins.filter((p) => pinKey(p) !== pinKey(cur));
    if (next.length === pins.length) next.push(cur);
    savePins(next);
    renderPins();
  });
  pinsEl.addEventListener("click", (e) => {
    const t = e.target as HTMLElement;
    const chip = t.closest("[data-pin-type]") as HTMLElement | null;
    if (!chip) return;
    const type = chip.dataset.pinType as BrowseType;
    if (!SANDBOXED_TYPES.includes(type)) return;
    const pin: Pin = { type, subfolder: chip.dataset.pinSub || "" };
    if (t.closest(".ib-pin-x")) {
      savePins(loadPins().filter((p) => pinKey(p) !== pinKey(pin)));
      renderPins();
      return;
    }
    if (pin.type === state.type && pin.subfolder === state.subfolder) return;
    rememberScroll();
    state.type = pin.type;
    state.subfolder = pin.subfolder;
    loadAndRender();
  });
  selBar.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest("[data-selbar]") as HTMLElement | null;
    if (!b) return;
    const action = b.dataset.selbar;
    if (action === "move") void doMoveSelected();
    else if (action === "delete") void doDelete();
    else if (action === "clear") {
      setSelectMode(false);
      clearSelection();
    }
  });
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
    rememberScroll();
    if (c.dataset.abs !== undefined) state.absPath = c.dataset.abs || "/";
    else state.subfolder = c.dataset.sub || "";
    loadAndRender();
  });

  gridEl.addEventListener("click", (e) => {
    // A completed long-press or drag-select already consumed this gesture —
    // the trailing click must not also open/toggle.
    if (suppressClick) {
      suppressClick = false;
      e.stopPropagation();
      return;
    }
    const target = e.target as HTMLElement;
    const actionBtn = target.closest("[data-action]") as HTMLElement | null;
    const card = target.closest(".ib-card") as HTMLElement | null;
    if (!card) return;
    if (card.classList.contains("is-up")) {
      navigateUp();
      return;
    }
    if (card.classList.contains("is-dir")) {
      if (actionBtn?.dataset.action === "rmdir") {
        e.stopPropagation();
        void onDeleteDir(card.dataset.name as string);
        return;
      }
      navigateInto(card.dataset.name as string);
      return;
    }
    // File card.
    const name = card.dataset.name as string;
    const ext = card.dataset.ext || "";
    const idx = Number(card.dataset.idx);
    // Checkbox tap — toggle selection (drag-selects are handled on pointermove
    // and suppress this click).
    if (target.closest("[data-check]")) {
      e.stopPropagation();
      toggleSelectionAt(idx);
      return;
    }
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
    // In select mode a card tap toggles selection instead of opening.
    if (selectMode && SANDBOXED_TYPES.includes(state.type)) {
      toggleSelectionAt(idx);
      return;
    }
    openFull(name, ext);
  });

  // ---- Touch gestures: long-press → select mode; drag over ☑ → range select
  let suppressClick = false;
  let dragSel: { on: boolean; last: number; moved: boolean } | null = null;
  let lpTimer: ReturnType<typeof setTimeout> | null = null;
  let lpX = 0;
  let lpY = 0;

  function cancelLongPress(): void {
    if (lpTimer) {
      clearTimeout(lpTimer);
      lpTimer = null;
    }
  }

  gridEl.addEventListener("pointerdown", (e) => {
    // A suppress flag can go stale when its gesture never produces a click
    // (long-press followed by a scroll) — a new gesture always starts clean.
    suppressClick = false;
    if (!SANDBOXED_TYPES.includes(state.type)) return;
    // Secondary mouse buttons never select — and must not arm the long-press,
    // or the contextmenu guard below would eat desktop right-click.
    if (e.pointerType === "mouse" && e.button !== 0) return;
    const target = e.target as HTMLElement;
    const card = target.closest(".ib-card.is-file") as HTMLElement | null;
    if (!card) return;
    const idx = Number(card.dataset.idx);
    if (!Number.isFinite(idx)) return;
    if (target.closest("[data-check]")) {
      // Drag starting on a checkbox sweeps a range; the checkbox has
      // touch-action:none so the gesture selects instead of scrolling.
      const f = renderedFiles[idx];
      dragSel = { on: !(f && isSelected(f)), last: idx, moved: false };
      try {
        gridEl.setPointerCapture(e.pointerId);
      } catch {
        /* jsdom / detached node — capture is an optimization only */
      }
      return;
    }
    // Long-press anywhere on the card enters select mode (Google-Photos
    // style). Touch/pen only — desktop has hover checkboxes and a slow mouse
    // click must stay a click.
    if (e.pointerType === "mouse") return;
    lpX = e.clientX;
    lpY = e.clientY;
    cancelLongPress();
    lpTimer = setTimeout(() => {
      lpTimer = null;
      suppressClick = true;
      if (!selectMode) setSelectMode(true);
      toggleSelectionAt(idx);
    }, 450);
  });

  gridEl.addEventListener("pointermove", (e) => {
    if (dragSel) {
      if (!dragSel.moved) {
        dragSel.moved = true;
        setSelectedRange(dragSel.last, dragSel.last, dragSel.on);
      }
      const el = document.elementFromPoint(e.clientX, e.clientY);
      const card =
        el instanceof Element ? (el.closest(".ib-card.is-file") as HTMLElement | null) : null;
      if (card) {
        const idx = Number(card.dataset.idx);
        if (Number.isFinite(idx) && idx !== dragSel.last) {
          // Cover the whole span since the last event so a fast swipe can't
          // skip cards between two pointermove samples.
          setSelectedRange(dragSel.last, idx, dragSel.on);
          dragSel.last = idx;
        }
      }
      return;
    }
    // A real scroll/pan cancels the pending long-press.
    if (lpTimer && (Math.abs(e.clientX - lpX) > 8 || Math.abs(e.clientY - lpY) > 8)) {
      cancelLongPress();
    }
  });

  function endPointerGesture(e: PointerEvent): void {
    if (dragSel) {
      // A swept range already applied — the trailing click must not re-toggle.
      if (dragSel.moved) suppressClick = true;
      dragSel = null;
      try {
        gridEl.releasePointerCapture(e.pointerId);
      } catch {
        /* capture may never have been taken */
      }
    }
    cancelLongPress();
  }
  gridEl.addEventListener("pointerup", endPointerGesture);
  gridEl.addEventListener("pointercancel", endPointerGesture);
  // Long-press on a thumbnail also raises the native context menu (esp. on
  // Android over <img>) — swallow it while it would fight the selection UX.
  gridEl.addEventListener("contextmenu", (e) => {
    if (selectMode || suppressClick || lpTimer) e.preventDefault();
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
      saveDest(dest);
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
    // The browse…/path tab is read-only — no selection to toggle there.
    selectToggleEl.style.display = SANDBOXED_TYPES.includes(state.type) ? "" : "none";
  }

  function renderPins(): void {
    const pins = loadPins();
    const canPin = SANDBOXED_TYPES.includes(state.type);
    pinToggleEl.style.display = canPin ? "" : "none";
    const herePinned =
      canPin && pins.some((p) => p.type === state.type && p.subfolder === state.subfolder);
    pinToggleEl.classList.toggle("is-active", herePinned);
    pinToggleEl.title = herePinned ? "Unpin this folder" : "Pin this folder";
    pinsEl.innerHTML = "";
    pinsEl.style.display = pins.length ? "" : "none";
    for (const p of pins) {
      const chip = document.createElement("span");
      chip.className = "ib-pin-chip";
      chip.dataset.pinType = p.type;
      chip.dataset.pinSub = p.subfolder;
      if (p.type === state.type && p.subfolder === state.subfolder)
        chip.classList.add("is-current");
      const go = document.createElement("button");
      go.type = "button";
      go.className = "ib-pin-go";
      go.title = `Go to ${pinLabel(p)}`;
      go.textContent = `📌 ${pinLabel(p)}`;
      const x = document.createElement("button");
      x.type = "button";
      x.className = "ib-pin-x";
      x.title = `Unpin ${pinLabel(p)}`;
      x.textContent = "✕";
      chip.append(go, x);
      pinsEl.appendChild(chip);
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

  async function loadAndRender(opts?: { preserveScroll?: boolean }): Promise<void> {
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
      // Surface via the copyable notify() popup (reportError) in addition to
      // the inline status text — a list-load failure was previously
      // console-only from the user's perspective.
      reportError("Failed to load directory", e);
      modal.setStatus(`Error: ${(e as Error).message}`);
      state.dirs = [];
      state.files = [];
    }
    modal.setBusy(false);
    renderGrid();
    renderPins();
    // Navigating restores the folder's remembered scroll position (0 for a
    // never-visited one) — each directory keeps its own place while you
    // traverse up and down. Refresh-in-place (refresh button, paste/move
    // re-list) keeps the position renderGrid restored.
    if (!opts?.preserveScroll) scrollHost.scrollTop = scrollMemory.get(locationKey()) ?? 0;
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
    // Re-renders happen after delete/move/rename/sort — wiping innerHTML
    // resets the body's scrollTop, so capture and restore it. Keyboard focus
    // moves scroll separately via applyFocus.
    const savedScrollTop = scrollHost.scrollTop;
    gridEl.innerHTML = "";
    const canWrite = SANDBOXED_TYPES.includes(state.type);

    const showUp = canGoUp();
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
      // Folder delete rides the same write gate as the file mutations. An
      // empty folder deletes outright; a non-empty one confirms with the
      // nested file count (see onDeleteDir).
      const dirDelBtn = canWrite
        ? `<button type="button" class="ib-dir-del" data-action="rmdir" title="Delete folder">🗑</button>`
        : "";
      c.innerHTML = `<div class="ib-thumb ib-thumb-icon">📁</div><div class="ib-name" title="${escHTML(d.name)}">${escHTML(d.name)}</div>${dirDelBtn}`;
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
      c.dataset.idx = String(fi);
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
      // The selection checkbox is the touch affordance for multi-select: it
      // has touch-action:none, so a drag starting on it sweeps a range
      // instead of scrolling. Only where writes are allowed.
      const checkBtn = canWrite
        ? `<button type="button" class="ib-check" data-check aria-label="Select ${escHTML(f.name)}">✓</button>`
        : "";
      c.innerHTML = `
        ${checkBtn}
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
    scrollHost.scrollTop = savedScrollTop;
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
    selBar.classList.toggle("is-visible", n > 0);
    selBarCount.textContent = `${n} selected`;
  }

  function setSelectMode(on: boolean): void {
    if (on && !SANDBOXED_TYPES.includes(state.type)) return;
    selectMode = on;
    selectToggleEl.classList.toggle("is-active", on);
    modal.dialog.classList.toggle("is-selecting", on);
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

  function setSelectedRange(a: number, b: number, on: boolean): void {
    if (!SANDBOXED_TYPES.includes(state.type)) return;
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    for (let i = lo; i <= hi; i++) {
      const f = renderedFiles[i];
      if (!f) continue;
      const key = selectionKey(state.type, state.subfolder, f.name);
      if (on) selected.set(key, { file: f, type: state.type, subfolder: state.subfolder });
      else selected.delete(key);
    }
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
    // No tab gate: selected items carry their own sandboxed type/subfolder,
    // so acting on a selection is valid even while viewing the path tab
    // (collectSelectedOrFocused never yields a path-tab item).
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

  async function doMoveSelected(): Promise<void> {
    // Batch move: the selection if there is one, else the focused file.
    const items = collectSelectedOrFocused();
    if (items.length === 0) return;
    const dest = await pickDestination(modal, {
      type: state.type,
      subfolder: state.subfolder,
    });
    if (!dest) return;
    try {
      const result = await moveMany(items, dest.type, dest.subfolder);
      const errored = new Set((result.errors ?? []).map((er) => er.name));
      for (const it of items) {
        if (!errored.has(it.name)) selected.delete(selectionKey(it.type, it.subfolder, it.name));
      }
      updateSelectedCount();
      if (result.moved > 0) saveDest(dest);
      if (dest.type === state.type && dest.subfolder === state.subfolder) {
        // Files may have arrived INTO the current folder — re-list it.
        await loadAndRender({ preserveScroll: true });
      } else {
        const removedHere = new Set(
          items
            .filter(
              (it) =>
                it.type === state.type && it.subfolder === state.subfolder && !errored.has(it.name),
            )
            .map((it) => it.name),
        );
        state.files = state.files.filter((f) => !removedHere.has(f.name));
        renderGrid();
      }
      if (result.errors && result.errors.length > 0) {
        const names = result.errors.map((er) => er.name).join(", ");
        reportError(`Moved ${result.moved}, ${result.errors.length} failed`, new Error(names));
      } else {
        notify({
          severity: "success",
          summary: "Moved",
          detail: `${result.moved} file(s) → ${dest.type}${dest.subfolder ? `/${dest.subfolder}` : ""}`,
        });
      }
    } catch (e) {
      reportError("Move failed", e);
    }
  }

  async function onDeleteDir(name: string): Promise<void> {
    if (!SANDBOXED_TYPES.includes(state.type)) return;
    try {
      // First attempt is non-recursive: an empty folder deletes outright; a
      // non-empty one answers with the nested counts for the confirm below.
      const res = await removeDir(state.type, state.subfolder, name, false);
      if (res.status === "not_empty") {
        const parts = [`${res.files} file${res.files === 1 ? "" : "s"}`];
        if (res.dirs > 0) parts.push(`${res.dirs} subfolder${res.dirs === 1 ? "" : "s"}`);
        const ok = await confirmAction(modal, {
          title: "Delete folder and contents?",
          message: `"${name}" contains ${parts.join(" and ")}. Permanently delete everything inside? This cannot be undone.`,
          confirmLabel: `Delete ${res.files} file${res.files === 1 ? "" : "s"}`,
          danger: true,
        });
        if (!ok) return;
        await removeDir(state.type, state.subfolder, name, true);
      }
      state.dirs = state.dirs.filter((d) => d.name !== name);
      // A pin pointing at (or under) the deleted folder is now a dead end.
      const gone = state.subfolder ? `${state.subfolder}/${name}` : name;
      savePins(
        loadPins().filter(
          (p) =>
            p.type !== state.type || (p.subfolder !== gone && !p.subfolder.startsWith(`${gone}/`)),
        ),
      );
      renderPins();
      renderGrid();
      notify({
        severity: "success",
        summary: "Folder deleted",
        detail: res.status === "not_empty" ? `"${name}" (${res.files} files)` : `"${name}" (empty)`,
      });
    } catch (e) {
      reportError("Delete folder failed", e);
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
      if (result.moved > 0) saveDest({ type: state.type, subfolder: state.subfolder });
      await loadAndRender({ preserveScroll: true });
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
    rememberScroll();
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
            <dt>long-press</dt><dd>select mode (touch)</dd>
            <dt>drag ✓</dt><dd>range select (touch)</dd>
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
            <dt>m</dt><dd>move selected…</dd>
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
      } else if (selectMode || selected.size > 0) {
        setSelectMode(false);
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
        // Moves the selection when one exists, else the focused file.
        if (selected.size > 0 || (SANDBOXED_TYPES.includes(state.type) && f)) {
          e.preventDefault();
          e.stopPropagation();
          void doMoveSelected();
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

    // Open at the last successful move destination (sorting a batch into the
    // same folder is the common case); fall back to the current location.
    const remembered = loadSavedDest();
    const cur: Destination = remembered ?? {
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
        // A remembered destination may have been deleted since — climb to the
        // root of the same tab (which always exists) instead of a dead end.
        if (!data.exists && cur.subfolder) {
          cur.subfolder = "";
          return load();
        }
        status.textContent = "";
        // Pinned folders jump the picker straight to a frequent destination —
        // the current location is omitted (moving here would be a no-op).
        for (const p of loadPins()) {
          if (p.type === cur.type && p.subfolder === cur.subfolder) continue;
          const r = document.createElement("button");
          r.type = "button";
          r.className = "ib-move-row is-pin";
          r.dataset.pinType = p.type;
          r.dataset.pinSub = p.subfolder;
          r.textContent = `📌 ${pinLabel(p)}`;
          list.appendChild(r);
        }
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
      const pin = (e.target as HTMLElement).closest(".is-pin") as HTMLElement | null;
      if (pin) {
        const t = pin.dataset.pinType as BrowseType;
        if (!SANDBOXED_TYPES.includes(t)) return;
        cur.type = t;
        cur.subfolder = pin.dataset.pinSub || "";
        load();
        return;
      }
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
.ib-dialog {
    width: 100vw !important; height: 100vh !important; max-height: 100vh !important;
    /* Full-bleed: pin to the top-left instead of the shell's 50%/-50% centering.
       On Android, 100vh is the LARGE viewport (URL bar hidden) — while the URL
       bar is visible the dialog is taller than the visible area and centering
       shoves the header off the top of the screen. */
    top: 0 !important; left: 0 !important; transform: none !important;
    border-radius: 0;
    /* Keep the header/footer clear of notches + gesture bars in fullscreen. */
    padding-top: env(safe-area-inset-top);
    padding-bottom: env(safe-area-inset-bottom);
}
@supports (height: 100dvh) {
    /* Track the dynamic viewport (URL bar show/hide) where supported. */
    .ib-dialog { height: 100dvh !important; max-height: 100dvh !important; }
}
.image-browser-body { display: block; }
.ib-tabs {
    display: flex; flex-wrap: wrap; gap: 2px; align-items: center;
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
@media (max-width: 700px) {
    /* Narrow screens: crumbs get their own full-width toolbar row. Squeezed to
       the flex leftovers, the crumb buttons overflow their container and paint
       underneath the sort dropdown. */
    .ib-crumbs { order: 9; flex-basis: 100%; }
}
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
    /* Anchor for the corner overlays (selection check / folder delete); the
       text-selection + touch-callout suppression keeps long-press clean. */
    position: relative;
    user-select: none; -webkit-user-select: none; -webkit-touch-callout: none;
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
/* Selection checkbox — the touch affordance for multi-select. Hidden until
   hover on fine pointers; always visible on touch, in select mode, and on
   already-selected cards. touch-action:none makes a drag starting here a
   range-select instead of a scroll. */
.ib-check {
    position: absolute; top: 4px; left: 4px; z-index: 2;
    width: 34px; height: 34px; padding: 0; border-radius: 50%;
    border: 2px solid rgba(255, 255, 255, 0.7); background: rgba(0, 0, 0, 0.45);
    color: transparent; font-size: 16px; line-height: 1; cursor: pointer;
    display: none; align-items: center; justify-content: center;
    touch-action: none;
}
.ib-card:hover .ib-check,
.ib-card.is-selected .ib-check,
.ib-dialog.is-selecting .ib-check { display: flex; }
@media (pointer: coarse) { .ib-check { display: flex; } }
.ib-check:hover { border-color: #ffd866; color: rgba(255, 255, 255, 0.85); }
.ib-card.is-selected .ib-check { background: #ffd866; border-color: #ffd866; color: #1a1a22; }
.ib-select-toggle.is-active { background: #2f3a52; color: #9ec6ff; border-color: #4a5878; }
.ib-pin-toggle.is-active { background: #52452f; color: #ffd866; border-color: #78683a; }
/* Pinned-folder chips — a full-width toolbar row of one-tap destinations.
   order:10 keeps them below the crumbs row when the toolbar wraps on phones. */
.ib-pins {
    order: 10; flex-basis: 100%;
    display: flex; flex-wrap: wrap; gap: 4px; align-items: center;
}
.ib-pin-chip { display: inline-flex; align-items: stretch; }
.ib-pin-go {
    background: #23283a; color: #9ec6ff; border: 1px solid #3a4560; border-right: 0;
    border-radius: 4px 0 0 4px; padding: 6px 8px; font-size: 12px; cursor: pointer;
    font-family: inherit; min-height: 32px; max-width: 45vw;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.ib-pin-go:hover { background: #2f3a52; color: #fff; }
.ib-pin-chip.is-current .ib-pin-go { color: #ffd866; border-color: #78683a; }
.ib-pin-chip.is-current .ib-pin-x { border-color: #78683a; }
.ib-pin-x {
    background: #23283a; color: #667; border: 1px solid #3a4560;
    border-radius: 0 4px 4px 0; padding: 6px 8px; font-size: 11px; cursor: pointer;
    font-family: inherit; min-height: 32px; min-width: 28px;
}
.ib-pin-x:hover { background: #5c2a3c; color: #ff9eb0; }
.ib-move-row.is-pin { color: #9ec6ff; }
/* Folder delete — corner overlay on dir cards (write-gated). */
.ib-dir-del {
    position: absolute; top: 4px; right: 4px; z-index: 2;
    width: 34px; height: 34px; padding: 0; border-radius: 6px;
    border: 1px solid rgba(255, 255, 255, 0.2); background: rgba(0, 0, 0, 0.45);
    color: #b8b8c0; font-size: 14px; line-height: 1; cursor: pointer;
}
.ib-dir-del:hover { background: #5c2a3c; color: #ff9eb0; }
/* Floating batch-action bar — appears while a selection exists. */
.ib-selbar {
    position: absolute; left: 50%; transform: translateX(-50%);
    bottom: calc(52px + env(safe-area-inset-bottom, 0px));
    z-index: 4; display: none; align-items: center; gap: 8px;
    max-width: calc(100% - 16px); white-space: nowrap;
    background: #1c1c24; border: 1px solid #3a3a44; border-radius: 24px;
    padding: 8px 12px; box-shadow: 0 8px 24px rgba(0, 0, 0, 0.5);
}
.ib-selbar.is-visible { display: flex; }
.ib-selbar-count { font-size: 12.5px; font-weight: 600; color: #9ec6ff; padding: 0 4px; }
.ib-selbar-btn {
    background: #2a2a36; color: #d8d8dc; border: 1px solid #3a3a44; border-radius: 16px;
    padding: 8px 14px; font-size: 13px; cursor: pointer; font-family: inherit; min-height: 38px;
}
.ib-selbar-btn:hover { background: #3a3a4a; color: #fff; }
.ib-selbar-danger { background: #4a2230; color: #ff9eb0; border-color: #78384a; }
.ib-selbar-danger:hover { background: #5c2a3c; color: #fff; }
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
