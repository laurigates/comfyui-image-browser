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
  confirmInShell,
  copyTextToClipboard,
  ensureStyleOnce,
  escapeHTML as escHTML,
  fuzzyScore,
  installBackGuard,
  installLazyMedia,
  nextRating,
  notify,
  openModalShell,
  openShellOverlay,
  postRating,
  promptInShell,
  ratingOf,
  sortFiles,
  starsHTML,
} from "@laurigates/comfy-modal-kit";
// Runtime import, left unbundled by `bun build --external '/scripts/*'` and
// resolved against ComfyUI's served module. Used only by loadWorkflow(), which
// hands a File to the app's own loader rather than reimplementing graph parsing.
import { app } from "/scripts/app.js";
import {
  type BatchItem,
  type BrowseType,
  deleteFile,
  deleteMany,
  EXT_NAME,
  embeddedWorkflowJSON,
  fetchBasePaths,
  fetchListing,
  fetchMetadata,
  fullSrcURL,
  IMG_EXTS,
  type ImageMetadata,
  imageThumbURL,
  joinAbs,
  type ListingFile,
  META_EXTS,
  META_VIDEO_EXTS,
  type MetaRow,
  makeDir,
  metaClipboardText,
  metaRows,
  moveDir,
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
  viewMode: ViewMode;
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

// View mode: "folder" is the classic one-directory-at-a-time grid; "flat"
// recursively merges the current subfolder's whole subtree into one grid, each
// card labelled with its relative subpath (for finding recent renders wherever
// they landed). Persisted so the preference survives reopening the browser.
type ViewMode = "folder" | "flat";
const VIEW_STORAGE_KEY = "comfyui-image-browser:view";
// Breadcrumb set while a flat load is in flight and cleared once the grid has
// painted. If it is STILL set at open time, the previous flat attempt never
// finished — the tab died under it — so the persisted preference would reopen
// straight into the same failure with no way to reach the toggle. Recovering to
// folder view keeps the preference from becoming a trap.
const VIEW_PENDING_KEY = "comfyui-image-browser:view-pending";

interface SavedView {
  mode: ViewMode;
  recovered: boolean;
}

function loadSavedView(): SavedView {
  try {
    if (localStorage.getItem(VIEW_PENDING_KEY) === "1") {
      localStorage.removeItem(VIEW_PENDING_KEY);
      localStorage.setItem(VIEW_STORAGE_KEY, "folder");
      return { mode: "folder", recovered: true };
    }
    return {
      mode: localStorage.getItem(VIEW_STORAGE_KEY) === "flat" ? "flat" : "folder",
      recovered: false,
    };
  } catch {
    return { mode: "folder", recovered: false };
  }
}

function saveView(mode: ViewMode): void {
  try {
    localStorage.setItem(VIEW_STORAGE_KEY, mode);
  } catch {
    /* private-mode / disabled storage — non-fatal */
  }
}

function markFlatPending(pending: boolean): void {
  try {
    if (pending) localStorage.setItem(VIEW_PENDING_KEY, "1");
    else localStorage.removeItem(VIEW_PENDING_KEY);
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
  ensureStyleOnce(STYLE_ID, BROWSER_CSS);

  const savedView = loadSavedView();
  const state: BrowserState = {
    type: "output",
    subfolder: "",
    absPath: "",
    dirs: [],
    files: [],
    sortKey: "mtime",
    sortDir: "desc",
    query: "",
    viewMode: savedView.mode,
  };
  const savedSort = loadSavedSort();
  if (savedSort) {
    state.sortKey = savedSort.key;
    state.sortDir = savedSort.dir;
  }

  // Assigned just after the shell exists (the guard hit-tests modal.dialog),
  // but onClose below closes over it, so it is declared here and nulled on
  // teardown rather than being a const the closure would read in its TDZ.
  let disposeBackGuard: (() => void) | null = null;

  const modal = openModalShell({
    title: "Image Browser",
    placeholder: "Filter by filename…",
    // Fill the whole viewport — the browser stands in for the canvas.
    width: "100vw",
    height: "100vh",
    footerLeftHTML:
      "<kbd>j/k</kbd> navigate · <kbd>i</kbd> metadata · <kbd>w</kbd> workflow · <kbd>?</kbd> help · <kbd>Esc</kbd> close",
    footerRightHTML: '<span class="ib-count"></span>',
    // Fires on EVERY teardown path (Esc, × button, backdrop, coordinator
    // dismiss) — the controller.close wrapper does not, so keyboard cleanup
    // must hang off onClose or the window listener leaks after close.
    onClose: () => {
      // Remember where this folder was scrolled to so reopening the browser
      // (scrollMemory is module-level) resumes in place.
      rememberScroll();
      // Closing mid-load is a deliberate exit, not a crash — don't leave the
      // breadcrumb armed or the next open falls back to folder view for nothing.
      markFlatPending(false);
      disposeLazyThumbs?.();
      disposeLazyThumbs = null;
      // A restore may still be re-asserting the offset frame by frame; the
      // dialog is already gone, so cancel it here rather than letting it run
      // out against a detached element (same reason the observer is
      // disconnected — nothing scheduled may outlive the modal).
      cancelScrollRestore();
      window.removeEventListener("keydown", onWindowKey, true);
      window.removeEventListener("keydown", onScrollKey, true);
      disposeBackGuard?.();
      disposeBackGuard = null;
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

  // Flat view toggle: fold the whole subtree into one grid. Sandboxed roots
  // only (recursion over an arbitrary base path is out of scope), so it hides
  // on the browse-only path tab like the other write-gated controls.
  const viewToggleEl = document.createElement("button");
  viewToggleEl.type = "button";
  viewToggleEl.className = "ib-control ib-icon ib-view-toggle";
  viewToggleEl.title = "Flat view (all subfolders)";
  viewToggleEl.textContent = "≣";

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

  // Create a folder in the current directory; hidden on the browse-only path
  // tab (folder creation is a sandboxed write, like delete/rename/move).
  const newFolderEl = document.createElement("button");
  newFolderEl.type = "button";
  newFolderEl.className = "ib-control ib-icon ib-newfolder";
  newFolderEl.title = "New folder";
  newFolderEl.textContent = "📁+";

  // One-tap navigation chips for the pinned folders; hidden while empty.
  const pinsEl = document.createElement("div");
  pinsEl.className = "ib-pins";

  modal.toolbarEl.append(
    tabsEl,
    crumbsEl,
    viewToggleEl,
    selectToggleEl,
    pinToggleEl,
    newFolderEl,
    sortEl,
    refreshEl,
    pinsEl,
  );

  // ---- Grid ------------------------------------------------------
  const gridEl = document.createElement("div");
  gridEl.className = "ib-grid";
  root.appendChild(gridEl);

  // The modal shell's body (.cmp-body) is the overflow-y:auto container the
  // grid scrolls in — renderGrid saves/restores its scrollTop so deletes,
  // moves, renames and rating changes don't fling the view back to the top.
  const scrollHost = modal.bodyEl;

  // ---- Scroll restore --------------------------------------------
  // Restoring a remembered offset is NOT one assignment. Three separate things
  // break `scrollHost.scrollTop = n`, measured in a real engine at a phone
  // viewport:
  //
  //  1. THE READ AT CLOSE IS TAKEN FROM A DETACHED ELEMENT — the actual bug.
  //     The kit's shell teardown does `backdrop.remove(); dialog.remove();`
  //     and only THEN calls `onClose`, so onClose's rememberScroll() reads
  //     scrollTop off a node that is no longer in the document, which every
  //     real engine answers with 0. Measured: parked at 31185, the one read
  //     during close reported `{value: 0, connected: false}` — so the Map
  //     stored 0 and no later restore could undo it. The position was never
  //     saved, not lost. jsdom returns the last value ASSIGNED whether the
  //     node is attached or not, which is exactly why the jsdom test is green
  //     and structurally cannot see this. `liveScrollTop` below is the mirror
  //     the close path reads instead of the element.
  //  2. `scrollTop = n` CLAMPS to `scrollHeight - clientHeight` at the instant
  //     of assignment, silently. Measured: 162370 requested on a 62370-max
  //     scroller reads back 62370 in the same statement. A single write is
  //     therefore only as good as the layout that happened to be in force.
  //  3. Momentum scrolling — iOS keeps decelerating a fling after the finger
  //     is up and an assignment mid-deceleration is unreliable. DEFENSIVE AND
  //     UNVERIFIED: this repo's browser harness is Chromium-only
  //     (`-webkit-overflow-scrolling: touch` is inert outside WebKit), so the
  //     re-assert loop below is hardening against a reported behaviour, NOT
  //     something measured here. It is free in Chromium — the loop finds the
  //     offset already correct and writes nothing.
  //
  // Hence restoreScroll(): assign synchronously (the common case, and the one
  // the lazy-thumb observer must see), then re-assert for a BOUNDED number of
  // frames against the clamp bound in force at each of them.

  // Mirror of scrollHost.scrollTop. The scroller keeps it fresh itself —
  // `scroll` fires for touch, wheel, keyboard and programmatic movement alike —
  // so it is still valid at teardown, when the element has already been
  // detached and answers 0. One caveat that any new scroll mutator has to
  // respect: `scroll` is dispatched at the frame's RENDERING step, after that
  // frame's input events, so a mutator whose result can be read later in the
  // same frame must write the mirror itself (setScrollTop does; applyFocus's
  // scrollIntoView has to, and does).
  let liveScrollTop = 0;
  // Set by a user gesture: the user has taken the scroller, so a pending
  // restore stops re-asserting. A wrong offset is better than a scroller that
  // fights a finger.
  let userTookOver = false;
  let restoreRaf = 0;

  scrollHost.addEventListener(
    "scroll",
    () => {
      liveScrollTop = scrollHost.scrollTop;
    },
    { passive: true },
  );

  // The user's input outranks a pending restore, unconditionally. Cancel as
  // well as flag: `step` checks the flag, but it only gets to check it on the
  // next frame, and one re-assert against a gesture already in flight is one
  // too many.
  function yieldScroller(): void {
    userTookOver = true;
    cancelScrollRestore();
  }

  for (const ev of ["pointerdown", "wheel", "touchstart"]) {
    // Capture, so a card handler that stops propagation cannot hide the
    // gesture; passive, so registering on the scroller never costs the engine
    // its fast path (nothing here calls preventDefault).
    scrollHost.addEventListener(ev, yieldScroller, { passive: true, capture: true });
  }

  // Keys that scroll a scroller natively. A keyboard scroll produces NONE of
  // the events above, so without this the loop fights it — measured, and it
  // does not merely delay the keypress, it swallows it: End pressed inside the
  // restore window left the offset pinned at the remembered 31185 across 8
  // samples spanning ~360 ms, while the identical press 500 ms later (window
  // expired) reached the bottom at 62370. The listener is on `window` because
  // the focus is on <body>, not on the scroller — a scroller-level listener
  // never sees the key. The pack's own vim keys need no entry here: they route
  // through applyFocus(), which cancels the restore itself.
  const SCROLL_KEYS = new Set([
    "ArrowUp",
    "ArrowDown",
    "ArrowLeft",
    "ArrowRight",
    "PageUp",
    "PageDown",
    "Home",
    "End",
    // Space is deliberately absent: onWindowKey claims it for the selection
    // toggle and preventDefaults it, so it never scrolls the view here. Listing
    // it would disarm a restore on a keypress that moves nothing.
  ]);
  function onScrollKey(e: KeyboardEvent): void {
    // In a text field these keys move the caret, not the view — and the search
    // field is autofocused, so treating them as a scroll gesture there would
    // disarm the restore on every keystroke of a filter.
    if (!SCROLL_KEYS.has(e.key) || isInInput()) return;
    yieldScroller();
  }
  window.addEventListener("keydown", onScrollKey, true);

  // Honest read of where the view is. While the scroller is in the document the
  // element is the truth (and refreshes the mirror); once it is detached — the
  // close path, mechanism 1 above — only the mirror is.
  function currentScrollTop(): number {
    if (scrollHost.isConnected) liveScrollTop = scrollHost.scrollTop;
    return liveScrollTop;
  }

  function setScrollTop(v: number): void {
    scrollHost.scrollTop = v;
    // Read back rather than trusting `v` — this is where a clamp becomes
    // visible, and the mirror must hold what the engine kept, not what we asked
    // for.
    liveScrollTop = scrollHost.scrollTop;
  }

  function cancelScrollRestore(): void {
    if (restoreRaf !== 0) {
      cancelAnimationFrame(restoreRaf);
      restoreRaf = 0;
    }
  }

  // Frames a restore keeps re-asserting for — ~200 ms at 60 Hz. BOUNDED on
  // purpose: an open-ended loop (or an interval) would outlive the modal the
  // way a leaked IntersectionObserver used to — see disposeLazyThumbs. onClose
  // cancels whatever is still pending.
  const RESTORE_FRAMES = 12;

  /**
   * Put the scroller at `target` and make it stick.
   *
   * Contract:
   *  - the first assignment is SYNCHRONOUS, so callers — and the lazy-thumb
   *    observer, which is installed after it — see the final viewport
   *    immediately;
   *  - `target <= 0` is finished by that one assignment: the top cannot be
   *    clamped and needs no defending (search, sort and first-visit-to-a-folder
   *    all land at the top and must STAY there);
   *  - otherwise the offset is re-asserted once per frame for RESTORE_FRAMES
   *    frames, each time against the clamp bound in force at that frame;
   *  - if the target is genuinely out of reach — the folder got shorter because
   *    files were deleted or a filter narrowed it — it settles at the bottom
   *    rather than fighting for an offset that no longer exists;
   *  - any user input that scrolls — pointer, wheel, touch or a native
   *    keyboard scroll — ends it early, as does the dialog detaching; and
   *    nothing is left scheduled after RESTORE_FRAMES either way.
   */
  function restoreScroll(target: number): void {
    cancelScrollRestore();
    userTookOver = false;
    setScrollTop(target);
    if (target <= 0) return;
    // No layout box (jsdom, or a scroller that is not rendered) → nothing
    // clamps and there are no frames to correct in; the assignment above is the
    // whole behaviour, which is what keeps the bookkeeping test meaningful.
    if (typeof requestAnimationFrame !== "function" || scrollHost.clientHeight <= 0) return;
    let frames = 0;
    const step = (): void => {
      restoreRaf = 0;
      if (userTookOver || !scrollHost.isConnected) return;
      const max = Math.max(0, scrollHost.scrollHeight - scrollHost.clientHeight);
      const reachable = Math.min(target, max);
      // Sub-pixel differences are the engine's own rounding on a fractional
      // scroll position, not a lost restore — writing them back would fight
      // the compositor for nothing.
      if (Math.abs(scrollHost.scrollTop - reachable) > 1) setScrollTop(reachable);
      if (++frames >= RESTORE_FRAMES) return;
      restoreRaf = requestAnimationFrame(step);
    };
    restoreRaf = requestAnimationFrame(step);
  }

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
  // Flat view is only in effect on a sandboxed root — the toggle is hidden on
  // the path tab and the backend ignores `recursive` there, so guard both.
  function isFlat(): boolean {
    return state.viewMode === "flat" && SANDBOXED_TYPES.includes(state.type);
  }

  // A file's effective subfolder: in folder view every file lives in
  // state.subfolder; in flat view each carries its own subpath, joined onto the
  // request subfolder. Every per-file address (thumbnail, open, delete, rename,
  // move, rating, selection key) routes through this so both views share one
  // code path.
  function fileSub(f: ListingFile): string {
    const sp = f.subpath || "";
    if (!sp) return state.subfolder;
    const base = state.subfolder.replace(/\/+$/, "");
    return base ? `${base}/${sp}` : sp;
  }

  // Key for the CURRENT location's scroll-memory slot. Distinct namespaces
  // for the sandboxed roots (`type:subfolder`) and path mode (`path:/abs`).
  // Flat view gets its own slot so toggling doesn't restore the wrong offset.
  function locationKey(): string {
    const view = isFlat() ? ":flat" : "";
    return state.type === "path"
      ? `path:${state.absPath}`
      : `${state.type}:${state.subfolder}${view}`;
  }

  // Called on every navigation BEFORE the location mutates, so returning to
  // this folder later (up, chip, tab, crumb) lands where the user left off.
  // Goes through currentScrollTop() — NOT scrollHost.scrollTop — because the
  // close path calls this after the shell has already detached the dialog, and
  // a detached element reads 0 (see the scroll-restore block above).
  function rememberScroll(): void {
    scrollMemory.set(locationKey(), currentScrollTop());
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

  disposeBackGuard = installBackGuard(() => {
    const hasOverlay = !!modal.dialog.querySelector(".cmp-ov-backdrop");
    if (hasOverlay) {
      // Route through the overlay's ESC path so its onDismiss fires.
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", cancelable: true }));
      return true;
    }
    if (canGoUp()) {
      navigateUp();
      return true;
    }
    modal.close();
    return false;
  });

  // ---- Wiring ----------------------------------------------------
  modal.searchEl.addEventListener("input", () => {
    state.query = modal.searchEl.value.toLowerCase().trim();
    // New filter → read results from the top (renderGrid otherwise restores
    // the previous scroll position, which is for in-place mutations). Handed
    // IN rather than assigned after: renderGrid's restore defends the offset
    // it was given for a few frames, so a follow-up `scrollTop = 0` would be
    // a race against it.
    renderGrid({ scrollTo: 0 });
  });
  sortEl.addEventListener("change", () => {
    const [k, d] = sortEl.value.split(":");
    state.sortKey = k as string;
    state.sortDir = d as string;
    saveSort(k as string, d as string);
    renderGrid({ scrollTo: 0 });
  });
  refreshEl.addEventListener("click", () => loadAndRender({ preserveScroll: true }));
  newFolderEl.addEventListener("click", () => void onNewFolder());
  viewToggleEl.addEventListener("click", () => {
    if (!SANDBOXED_TYPES.includes(state.type)) return;
    rememberScroll();
    state.viewMode = state.viewMode === "flat" ? "folder" : "flat";
    saveView(state.viewMode);
    // Flat needs a recursive re-fetch; the folder→flat and flat→folder slots
    // are distinct in scrollMemory, so loadAndRender lands each at its own place.
    loadAndRender();
  });
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
      if (actionBtn?.dataset.action === "movedir") {
        e.stopPropagation();
        void onMoveDir(card.dataset.name as string);
        return;
      }
      navigateInto(card.dataset.name as string);
      return;
    }
    // File card. Resolve the exact file by index — in flat view a bare name is
    // not unique across subfolders, so every handler takes the file object.
    const idx = Number(card.dataset.idx);
    const f = renderedFiles[idx];
    // Subpath label (flat view) — a tap jumps to that folder in folder view.
    const subEl = target.closest(".ib-subpath") as HTMLElement | null;
    if (subEl) {
      e.stopPropagation();
      rememberScroll();
      state.viewMode = "folder";
      saveView("folder");
      state.subfolder = subEl.dataset.sub || "";
      loadAndRender();
      return;
    }
    if (!f) return;
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
      setStarRating(f, row, nextRating(cur, Number(star.dataset.val)));
      return;
    }
    if (actionBtn) {
      e.stopPropagation();
      const action = actionBtn.dataset.action;
      if (action === "open") openFull(f);
      else if (action === "meta") void openMetadata(f);
      else if (action === "workflow") void loadWorkflow(f);
      else if (action === "delete") onDelete(f);
      else if (action === "rename") onRename(f);
      else if (action === "move") onMove(f);
      return;
    }
    // In select mode a card tap toggles selection instead of opening.
    if (selectMode && SANDBOXED_TYPES.includes(state.type)) {
      toggleSelectionAt(idx);
      return;
    }
    openFull(f);
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
  // Every handler takes the ListingFile (not a bare name) so it addresses the
  // right file in flat view, where names repeat across subfolders. fileSub(f)
  // resolves the file's real subfolder; view updates filter by object identity
  // (x !== f) so a same-named sibling in another folder is never touched.
  function setStarRating(f: ListingFile, row: HTMLElement, next: number): void {
    const prev = Number(row.dataset.rating || "0");
    applyStars(row, next);
    f.rating = next;
    const addr: RatingAddress = {
      type: state.type,
      subfolder: fileSub(f),
      absDir: state.absPath,
      name: f.name,
    };
    postRating(RATING_URL, addr, next)
      .then((confirmed) => {
        if (confirmed !== next) {
          applyStars(row, confirmed);
          f.rating = confirmed;
        }
      })
      .catch((e) => {
        reportError("Rating failed", e);
        applyStars(row, prev);
        f.rating = prev;
      });
  }

  function openFull(f: ListingFile): void {
    const url = fullSrcURL(state.type, fileSub(f), f.name, state.absPath);
    window.open(url, "_blank", "noopener");
  }

  // Copy feedback lives on the button itself: label → "Copied ✓" → back.
  // DELIBERATELY no notify() toast on success — the toast stack is a child of
  // <body> above the dialog, so on the installed kit a toast raised over an open
  // overlay parks its ✕ on top of the shell's, and tapping it dismisses the whole
  // browser. The label flip is also the clearer confirmation: it names which
  // field went to the clipboard. copyTextToClipboard (not navigator.clipboard
  // directly) carries the non-secure-context fallback plain-http LAN ComfyUI needs.
  //
  // `restore` is PASSED IN, never read back off the button: reading
  // btn.textContent at click time captures the TRANSIENT label whenever a second
  // click lands inside the 1500 ms window, so the feedback latches permanently —
  // and in the fail-then-succeed order the button settles on "Copy failed" after
  // a copy that worked, i.e. it lies about whether the value is on the clipboard.
  // One feedback slot per button (copyFeedback): a new click supersedes the
  // previous click's pending restore AND its late-resolving promise (the `seq`
  // check), so the label always shows the LAST copy's outcome and then `restore`.
  const copyFeedback = new WeakMap<
    HTMLButtonElement,
    { seq: number; timer: ReturnType<typeof setTimeout> | null }
  >();
  function copyInto(btn: HTMLButtonElement, text: string, restore: string): void {
    let fb = copyFeedback.get(btn);
    if (!fb) {
      fb = { seq: 0, timer: null };
      copyFeedback.set(btn, fb);
    }
    const slot = fb;
    const seq = ++slot.seq;
    // Hold the current feedback until this copy answers — no flicker back to
    // `restore` mid-flight — but drop the stale restore timer that would fire
    // out of order once this click's own timer is armed.
    if (slot.timer !== null) {
      clearTimeout(slot.timer);
      slot.timer = null;
    }
    void copyTextToClipboard(text).then((ok) => {
      if (slot.seq !== seq) return; // a later click owns the label now
      btn.textContent = ok ? "Copied ✓" : "Copy failed";
      btn.classList.toggle("is-copied", ok);
      slot.timer = setTimeout(() => {
        slot.timer = null;
        btn.textContent = restore;
        btn.classList.remove("is-copied");
      }, 1500);
    });
  }

  // Load the graph embedded in an image onto the canvas.
  //
  // Two-step on purpose. The /metadata READ is the gate: it seeks past the pixel
  // data to reach the text chunks, so asking "is there a graph?" costs a fraction
  // of the full-size bytes, and — more importantly — it lets a workflow-less image
  // get an honest message. handleFile()'s own no-workflow path is a quiet return,
  // which would read to the user as a dead button rather than as "this PNG has no
  // graph in it". Only once the gate passes do we fetch the bytes and hand the
  // File to ComfyUI's OWN loader, which is also what a drag-and-drop onto the
  // canvas calls — so workflow-vs-prompt precedence, API-format reconstruction
  // and the missing-node-types dialog all come from the app, not from us.
  //
  // The browser closes first: loadGraphData swaps the canvas underneath, and
  // leaving a full-viewport modal parked over the graph the user just asked to
  // see is the wrong end state.
  async function loadWorkflow(f: ListingFile): Promise<void> {
    const sub = fileSub(f);
    try {
      const meta = await fetchMetadata(state.type, sub, f.name, state.absPath);
      const graphJSON = embeddedWorkflowJSON(meta);
      if (!graphJSON) {
        notify({
          severity: "warn",
          summary: "No workflow in this file",
          detail: `${f.name} carries no embedded graph. Files saved by another tool (or re-encoded, e.g. by a phone gallery or a chat app) lose ComfyUI's metadata.`,
        });
        return;
      }
      // Videos take a different route to the SAME app loader, because
      // handing the video bytes to handleFile() is not reliable for them.
      // getWorkflowDataFromFile() reads the mdta `keys`+`ilst` MP4 layout core
      // SaveVideo writes, but returns early when the `keys` box is absent —
      // which is exactly how kijai's writers store it (a bare `©cmt` atom
      // holding a double-encoded envelope; 26% of the videos on the reference
      // install, verified by walking their box trees). handleFile's
      // no-workflow branch then PASTES A LoadVideo NODE rather than loading
      // the graph: a silently wrong outcome, worse than the dead button this
      // change removes.
      //
      // So a video hands over the graph the BACKEND already parsed, as a JSON
      // file. That still goes through app.handleFile → getDataFromJSON, which
      // owns the lenient non-finite parse, the API-vs-UI format detection, and
      // the workflow/prompt precedence — none of which is reimplemented here.
      // A malformed graph ends at the app's own showErrorOnFileLoad, never at
      // a pasted node. Images keep the byte path: it is unchanged, and their
      // containers are ones handleFile reads natively.
      if (META_VIDEO_EXTS.has((f.ext || "").toLowerCase())) {
        // handleFile names the workflow tab after the file, minus one
        // extension — so ".json" here would leave the video's own extension
        // showing. Strip it first and let the graph tab carry the bare name.
        const base = f.name.replace(/\.[^./]+$/, "");
        const file = new File([graphJSON], `${base}.json`, { type: "application/json" });
        modal.close();
        await app.handleFile(file);
        return;
      }
      const res = await fetch(fullSrcURL(state.type, sub, f.name, state.absPath));
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      // handleFile keys the workflow's tab name off file.name, so pass the real
      // filename rather than a synthesized one.
      const file = new File([blob], f.name, { type: blob.type });
      modal.close();
      await app.handleFile(file);
    } catch (e) {
      notify({
        severity: "error",
        summary: "Could not load workflow",
        detail: `${f.name}: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
  }

  // Embedded generation metadata for one image, in an IN-DIALOG overlay
  // (openShellOverlay — a second openModalShell would break single-modal
  // discipline and close the browser under itself).
  async function openMetadata(f: ListingFile): Promise<void> {
    // The overlay is dismissible while the read is in flight, so a late response
    // must not paint into a closed card.
    let live = true;
    const ov = openShellOverlay(modal, {
      onDismiss: () => {
        live = false;
      },
    });
    ov.card.classList.add("ib-meta-card");
    const close = (): void => {
      live = false;
      ov.close();
    };
    const title = `Metadata — ${escHTML(f.name)}`;
    // Painted synchronously: an overlay that appears only after the read would
    // feel like a dead button on a big file / slow disk.
    ov.card.innerHTML = `
      <div class="cmp-ov-title">${title}</div>
      <div class="ib-meta-body"><div class="ib-meta-status">Reading metadata…</div></div>
      <div class="cmp-ov-actions">
        <button type="button" class="cmp-ov-btn" data-meta-close>Close</button>
      </div>`;
    ov.card.querySelector("[data-meta-close]")?.addEventListener("click", close);

    let data: ImageMetadata;
    try {
      data = await fetchMetadata(state.type, fileSub(f), f.name, state.absPath);
    } catch (e) {
      // Close FIRST, then report: the copyable error toast must not land on an
      // open overlay (same toast-over-dialog constraint as copyInto above).
      close();
      reportError("Metadata read failed", e);
      return;
    }
    if (!live) return;

    const rows: MetaRow[] = metaRows(data.summary);
    const rawKeys = Object.keys(data.raw);
    const srcLabel =
      data.source === "comfyui"
        ? "ComfyUI"
        : data.source === "a1111"
          ? "A1111"
          : "no generation data";
    const rowsHTML = rows
      .map(
        (r, i) => `
        <div class="ib-meta-row">
          <div class="ib-meta-k">${escHTML(r.label)}</div>
          <div class="ib-meta-v">${escHTML(r.value)}</div>
          <button type="button" class="ib-meta-copy" data-copy-row="${i}">Copy</button>
        </div>`,
      )
      .join("");
    // Never invent a row. With nothing recognised the honest report is which of
    // the two cases it is: no embedded text at all, or text we couldn't map (in
    // which case the raw disclosure below is the whole answer).
    const emptyHTML = rows.length
      ? ""
      : `<div class="ib-meta-empty">${
          rawKeys.length ? "No recognised generation parameters." : "No generation metadata found."
        }</div>`;
    const rawJSON = JSON.stringify(data.raw, null, 2);
    const rawHTML = rawKeys.length
      ? `
        <details class="ib-meta-raw">
          <summary>Raw metadata (${rawKeys.length} key${rawKeys.length === 1 ? "" : "s"})</summary>
          <pre>${escHTML(rawJSON)}</pre>
          <button type="button" class="ib-meta-copy" data-copy-raw>Copy JSON</button>
        </details>`
      : "";
    const noteHTML = data.truncated
      ? `<div class="ib-meta-note">Some values were truncated by the server.</div>`
      : "";
    const copyAll = rows.length
      ? `<button type="button" class="cmp-ov-btn cmp-ov-primary" data-copy-all>Copy all</button>`
      : "";
    ov.card.innerHTML = `
      <div class="cmp-ov-title">${title}</div>
      <div class="ib-meta-body">
        <div class="ib-meta-src">${escHTML(srcLabel)}${
          data.format ? `<span class="ib-meta-fmt">${escHTML(data.format)}</span>` : ""
        }</div>
        ${emptyHTML}
        ${rowsHTML}
        ${noteHTML}
        ${rawHTML}
      </div>
      <div class="cmp-ov-actions">
        ${copyAll}
        <button type="button" class="cmp-ov-btn" data-meta-close>Close</button>
      </div>`;
    ov.card.querySelector("[data-meta-close]")?.addEventListener("click", close);
    // Each restore label is read ONCE here, off the freshly painted markup —
    // never inside the click handler, where a mid-feedback label would stick.
    for (const btn of ov.card.querySelectorAll<HTMLButtonElement>("[data-copy-row]")) {
      const row = rows[Number(btn.dataset.copyRow)];
      const label = btn.textContent || "Copy";
      if (row) btn.addEventListener("click", () => copyInto(btn, row.value, label));
    }
    const rawBtn = ov.card.querySelector<HTMLButtonElement>("[data-copy-raw]");
    const rawLabel = rawBtn?.textContent || "Copy JSON";
    rawBtn?.addEventListener("click", () => copyInto(rawBtn, rawJSON, rawLabel));
    const allBtn = ov.card.querySelector<HTMLButtonElement>("[data-copy-all]");
    const allLabel = allBtn?.textContent || "Copy all";
    allBtn?.addEventListener("click", () => copyInto(allBtn, metaClipboardText(rows), allLabel));
  }

  async function onDelete(f: ListingFile): Promise<void> {
    const ok = await confirmInShell(modal, {
      title: "Delete file?",
      message: `Permanently delete "${f.name}"? This cannot be undone.`,
      confirmLabel: "Delete",
      danger: true,
    });
    if (!ok) return;
    try {
      await deleteFile(state.type, fileSub(f), f.name);
      state.files = state.files.filter((x) => x !== f);
      renderGrid();
    } catch (e) {
      reportError("Delete failed", e);
    }
  }

  async function onRename(f: ListingFile): Promise<void> {
    const name = f.name;
    const dot = name.lastIndexOf(".");
    const ext = dot >= 0 ? name.slice(dot) : "";
    const newName = await promptInShell(modal, {
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
      await renameFile(state.type, fileSub(f), name, newName);
      f.name = newName;
      renderGrid();
    } catch (e) {
      reportError("Rename failed", e);
    }
  }

  async function onMove(f: ListingFile): Promise<void> {
    const dest = await pickDestination(modal, {
      type: state.type,
      subfolder: fileSub(f),
    });
    if (!dest) return;
    try {
      await moveFile(state.type, fileSub(f), f.name, dest.type, dest.subfolder);
      saveDest(dest);
      state.files = state.files.filter((x) => x !== f);
      renderGrid();
      notify({
        severity: "success",
        summary: "Moved",
        detail: `"${f.name}" → ${dest.type}${dest.subfolder ? `/${dest.subfolder}` : ""}`,
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
    // The browse…/path tab is read-only — no selection to toggle and no folder
    // to create there (both are sandboxed writes). Flat view is likewise
    // sandboxed-only, so its toggle hides there too.
    const canWrite = SANDBOXED_TYPES.includes(state.type);
    selectToggleEl.style.display = canWrite ? "" : "none";
    newFolderEl.style.display = canWrite ? "" : "none";
    viewToggleEl.style.display = canWrite ? "" : "none";
    viewToggleEl.classList.toggle("is-active", isFlat());
    viewToggleEl.title = isFlat() ? "Folder view" : "Flat view (all subfolders)";
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
    // Arm the recovery breadcrumb around the whole flat load+render. It is
    // cleared below once the grid has painted, so only an attempt that never
    // got there (a tab the render killed) leaves it set.
    markFlatPending(isFlat());
    try {
      const data = await fetchListing({
        type: state.type,
        subfolder: state.subfolder,
        path: state.absPath,
        recursive: isFlat(),
      });
      state.dirs = data.dirs || [];
      state.files = data.files || [];
      modal.setStatus(data.exists ? "" : "Directory not found.");
      if (data.truncated) {
        notify({
          severity: "warn",
          summary: `Showing the newest ${state.files.length}`,
          detail:
            "This folder's subtree has more files than the flat view returns; older ones are not listed.",
        });
      }
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
    // Pins render into the toolbar, which lives INSIDE the scroller — do it
    // before the grid so the restore below measures the final content height.
    renderPins();
    // Navigating restores the folder's remembered scroll position (0 for a
    // never-visited one) — each directory keeps its own place while you
    // traverse up and down. Refresh-in-place (refresh button, paste/move
    // re-list) keeps the position renderGrid restored.
    //
    // The destination's offset is handed INTO renderGrid rather than assigned
    // after it. renderGrid would otherwise restore the offset it captured
    // before `innerHTML = ""` — which belongs to the folder we just LEFT — and
    // that write gets clamped into the new listing's range (measured
    // 31185 → 1865 going up out of a deep folder). It survives today only
    // because the corrected write lands 0.2 ms later in the same task; that is
    // a dead write to delete, not a coincidence to rely on.
    renderGrid({
      scrollTo: opts?.preserveScroll ? undefined : (scrollMemory.get(locationKey()) ?? 0),
    });
    markFlatPending(false);
  }

  function thumbForFile(f: ListingFile): ThumbDescriptor {
    const ext = (f.ext || "").toLowerCase();
    const sub = fileSub(f);
    if (IMG_EXTS.has(ext)) {
      return {
        kind: "img",
        src: imageThumbURL(state.type, sub, f.name, state.absPath, thumbVersion(f.mtime, f.size)),
      };
    }
    if (VIDEO_EXTS.has(ext)) {
      return {
        kind: "video",
        src: videoSrcURL(state.type, sub, f.name, state.absPath),
      };
    }
    return { kind: "icon", text: "📄" };
  }

  function renderGrid(opts?: { scrollTo?: number }): void {
    const q = state.query;
    // Re-renders happen after delete/move/rename/sort — wiping innerHTML
    // resets the body's scrollTop, so capture and restore it. Keyboard focus
    // moves scroll separately via applyFocus. `scrollTo` overrides the capture
    // for callers that already know where the view belongs (a navigation's
    // remembered offset, or 0 for a new search/sort) — see loadAndRender.
    const targetScrollTop = opts?.scrollTo ?? currentScrollTop();
    gridEl.innerHTML = "";
    const canWrite = SANDBOXED_TYPES.includes(state.type);
    // Flat view collapses the subtree into files only — no ".." card and no
    // folder cards (the backend returns dirs:[] recursively anyway).
    const flat = isFlat();

    const showUp = !flat && canGoUp();
    if (showUp) {
      const up = document.createElement("div");
      up.className = "ib-card is-up";
      up.innerHTML = `<div class="ib-thumb ib-thumb-icon">↑</div><div class="ib-name">..</div>`;
      gridEl.appendChild(up);
    }

    if (!flat) {
      for (const d of state.dirs) {
        if (q && !d.name.toLowerCase().includes(q)) continue;
        const c = document.createElement("div");
        c.className = "ib-card is-dir";
        c.dataset.name = d.name;
        // Folder move/delete ride the same write gate as the file mutations. Move
        // opens the destination picker (excluding the folder's own subtree); an
        // empty folder deletes outright, a non-empty one confirms with the nested
        // file count (see onMoveDir / onDeleteDir).
        const dirBtns = canWrite
          ? `<button type="button" class="ib-dir-move" data-action="movedir" title="Move folder">⇄</button>` +
            `<button type="button" class="ib-dir-del" data-action="rmdir" title="Delete folder">🗑</button>`
          : "";
        c.innerHTML = `<div class="ib-thumb ib-thumb-icon">📁</div><div class="ib-name" title="${escHTML(d.name)}">${escHTML(d.name)}</div>${dirBtns}`;
        gridEl.appendChild(c);
      }
    }

    let files = state.files;
    if (q) {
      const scored: { f: ListingFile; score: number }[] = [];
      for (const f of files) {
        // In flat view the query matches "subpath/name" so you can filter by
        // folder too; folder view matches the bare filename as before.
        const hay = flat && f.subpath ? `${f.subpath}/${f.name}` : f.name;
        const r = fuzzyScore(q, hay);
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
      // Flat cards carry a subpath row above the thumb — the marker lets CSS
      // drop the selection checkbox below it so the two don't overlap.
      if (flat) c.classList.add("is-flat");
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
      // The ⓘ metadata button is the ONE card control deliberately outside the
      // canWrite mirror: /metadata is a READ and accepts type=path, so it belongs
      // on the browse…/path tab too. Don't "fix" this into canWrite. It is gated
      // on META_EXTS instead — same ext source thumbForFile uses — which mirrors
      // the endpoint's own gate: every image, plus the video containers the
      // backend can parse. A .avi has no reader and would 400, so it gets no ⓘ.
      const hasMeta = META_EXTS.has((f.ext || "").toLowerCase());
      const metaBtn = hasMeta
        ? `<button type="button" class="ib-act" data-action="meta" title="Metadata (i)">ⓘ</button>`
        : "";
      // Load-workflow rides the same gate as ⓘ (both are READS through /metadata,
      // which accepts type=path), so it appears on the browse…/path tab too and
      // stays outside the canWrite mirror. It is offered for every readable file
      // rather than only for those known to carry a graph: knowing that requires
      // the per-file metadata read, and doing that for every card in a listing
      // would cost one request per thumbnail. The click path reads it and says so.
      const wfBtn = hasMeta
        ? `<button type="button" class="ib-act" data-action="workflow" title="Load workflow (w)">⤓</button>`
        : "";
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
      // Flat view: show the file's folder above the thumbnail. It's a button —
      // tapping it drops back to folder view at that directory. Top-level files
      // (subpath "") get a muted "/" so the row height stays consistent.
      const subLabel = flat
        ? f.subpath
          ? `<button type="button" class="ib-subpath" data-sub="${escHTML(fileSub(f))}" title="Go to ${escHTML(f.subpath)}">${escHTML(f.subpath)}</button>`
          : `<div class="ib-subpath is-root" title="Top level">/</div>`
        : "";
      c.innerHTML = `
        ${subLabel}
        ${checkBtn}
        <div class="ib-thumb">${thumbInner}</div>
        <div class="ib-name" title="${escHTML(titleText)}">${escHTML(f.name)}</div>
        ${dims ? `<div class="ib-meta">${dims}</div>` : ""}
        ${starsRow}
        <div class="ib-actions">
          <button type="button" class="ib-act" data-action="open" title="Open full size">↗</button>
          ${metaBtn}
          ${wfBtn}
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
    // Restore BEFORE installing the observer, so its first pass is computed
    // against the final viewport. The old order (observe, then scroll) was
    // latent rather than broken — IntersectionObserver delivers its callbacks
    // asynchronously, after the task holding the write — but restoreScroll now
    // also corrects across later frames, and an observer registered against the
    // pre-restore viewport would have queued the top-of-list band for fetching
    // before that. In flat view that is thousands of wrong /thumb requests.
    restoreScroll(targetScrollTop);
    installLazyThumbs(gridEl);
  }

  // The root MUST be the scrolling ancestor (`.cmp-body` / scrollHost), NEVER
  // `.ib-grid`: the grid has no overflow clip, so rooting on it makes the root
  // rectangle its whole bounding box and every card in the listing reports as
  // intersecting on the first callback — thousands of simultaneous /thumb
  // requests in flat view. The kit takes the root as a required parameter for
  // exactly this reason. Disposed on every re-install and in onClose; nothing
  // scheduled may outlive the modal.
  let disposeLazyThumbs: (() => void) | null = null;

  function installLazyThumbs(rootEl: HTMLElement): void {
    disposeLazyThumbs?.();
    disposeLazyThumbs = installLazyMedia(rootEl, { root: scrollHost, rootMargin: "300px" });
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
    return selected.has(selectionKey(state.type, fileSub(f), f.name));
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
    // Moving the keyboard focus IS a scroll intent — drop any restore still
    // re-asserting from the render that preceded it, or the two fight.
    cancelScrollRestore();
    focused?.scrollIntoView({ block: "nearest", inline: "nearest" });
    // scrollIntoView is the one in-pack scroll mutator that bypasses
    // setScrollTop, and the `scroll` event that would refresh the mirror is
    // dispatched at the frame's rendering step — AFTER this task's input
    // events. A close in the same frame (key autorepeat plus a tap on ✕, or any
    // long frame while thumbnails decode) would then remember a stale mirror:
    // measured 12279 on screen, 0 stored. The scroller is attached here by
    // construction, so this read is the real position.
    liveScrollTop = scrollHost.scrollTop;
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
    const sub = fileSub(f);
    const key = selectionKey(state.type, sub, f.name);
    if (selected.has(key)) selected.delete(key);
    else selected.set(key, { file: f, type: state.type, subfolder: sub });
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
      const sub = fileSub(f);
      const key = selectionKey(state.type, sub, f.name);
      if (on) selected.set(key, { file: f, type: state.type, subfolder: sub });
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
      const sub = fileSub(f);
      const key = selectionKey(state.type, sub, f.name);
      if (!selected.has(key)) selected.set(key, { file: f, type: state.type, subfolder: sub });
    }
    refreshSelectionClasses();
    updateSelectedCount();
  }

  function selectAllVisible(): void {
    if (!SANDBOXED_TYPES.includes(state.type)) return;
    for (const f of renderedFiles) {
      const sub = fileSub(f);
      const key = selectionKey(state.type, sub, f.name);
      if (!selected.has(key)) selected.set(key, { file: f, type: state.type, subfolder: sub });
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
    return [{ type: state.type, subfolder: fileSub(f), name: f.name }];
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
    const ok = await confirmInShell(modal, {
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
      // items span all folders (selection persists across tabs, and flat view
      // shows many at once); state.files is only what's on screen — so scope the
      // view removal by full selection key (type+subfolder+name), not bare name,
      // so a same-named file in another folder is never removed by mistake.
      const succeeded = new Set(
        items
          .filter((it) => it.type === state.type && !errored.has(it.name))
          .map((it) => selectionKey(it.type, it.subfolder, it.name)),
      );
      state.files = state.files.filter(
        (f) => !succeeded.has(selectionKey(state.type, fileSub(f), f.name)),
      );
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
      if (isFlat() || (dest.type === state.type && dest.subfolder === state.subfolder)) {
        // Flat view spans the whole subtree (a moved file may still be in view),
        // and in folder view files may have arrived INTO the current folder —
        // either way the surgical removal below can't be trusted, so re-list.
        await loadAndRender({ preserveScroll: true });
      } else {
        const succeeded = new Set(
          items
            .filter((it) => it.type === state.type && !errored.has(it.name))
            .map((it) => selectionKey(it.type, it.subfolder, it.name)),
        );
        state.files = state.files.filter(
          (f) => !succeeded.has(selectionKey(state.type, fileSub(f), f.name)),
        );
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

  async function onNewFolder(): Promise<void> {
    if (!SANDBOXED_TYPES.includes(state.type)) return;
    const existing = new Set(state.dirs.map((d) => d.name));
    const name = await promptInShell(modal, {
      title: "New folder",
      label: `Create in ${state.type}${state.subfolder ? `/${state.subfolder}` : ""}`,
      value: "",
      confirmLabel: "Create",
      validate: (v) => {
        if (!v) return "Folder name required";
        if (v.includes("/") || v.includes("\\")) return "No slashes allowed";
        if (v === "." || v === "..") return "Invalid name";
        if (existing.has(v)) return "A folder with that name already exists";
        return null;
      },
    });
    if (!name) return;
    try {
      await makeDir(state.type, state.subfolder, name);
      // Re-list so the new folder appears sorted among the others (and lands at
      // its correct alphabetical slot) without flinging the view to the top.
      await loadAndRender({ preserveScroll: true });
      notify({ severity: "success", summary: "Folder created", detail: `"${name}"` });
    } catch (e) {
      reportError("Create folder failed", e);
    }
  }

  async function onMoveDir(name: string): Promise<void> {
    if (!SANDBOXED_TYPES.includes(state.type)) return;
    // The folder's own path, so the picker can hide it (and its subtree) — the
    // backend also refuses a self-nested move, this just keeps the UI from
    // offering an impossible destination.
    const srcSub = state.subfolder ? `${state.subfolder}/${name}` : name;
    const dest = await pickDestination(
      modal,
      { type: state.type, subfolder: state.subfolder },
      { type: state.type, subfolder: srcSub },
    );
    if (!dest) return;
    try {
      const result = await moveDir(state.type, state.subfolder, name, dest.type, dest.subfolder);
      saveDest(dest);
      const conflicts = result.errors ?? [];
      if (conflicts.length > 0) {
        // Merged into an existing folder, but some files already existed there —
        // they were left in the source, so the folder still exists. Re-list to
        // show what actually moved (keep pins: the source path is still live).
        await loadAndRender({ preserveScroll: true });
        reportError(
          `Folder merged, ${conflicts.length} item(s) left in place`,
          new Error(conflicts.map((c) => c.name).join(", ")),
        );
        return;
      }
      state.dirs = state.dirs.filter((d) => d.name !== name);
      // A pin at (or under) the moved folder now points at a dead path — the
      // folder lives elsewhere. Drop it (same treatment as folder delete).
      savePins(
        loadPins().filter(
          (p) =>
            p.type !== state.type ||
            (p.subfolder !== srcSub && !p.subfolder.startsWith(`${srcSub}/`)),
        ),
      );
      renderPins();
      renderGrid();
      notify({
        severity: "success",
        summary: result.merged ? "Folder merged" : "Folder moved",
        detail: `"${name}" → ${dest.type}${dest.subfolder ? `/${dest.subfolder}` : ""}`,
      });
    } catch (e) {
      reportError("Move folder failed", e);
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
        const ok = await confirmInShell(modal, {
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
    const ov = openShellOverlay(modal);
    ov.card.classList.add("ib-help-card");
    ov.card.innerHTML = `
      <div class="cmp-ov-title">Keyboard shortcuts</div>
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
            <dt>i</dt><dd>metadata</dd>
            <dt>w</dt><dd>load workflow</dd>
            <dt>/</dt><dd>focus search</dd>
            <dt>?</dt><dd>this help</dd>
            <dt>Esc</dt><dd>close (priority)</dd>
          </dl>
        </div>
      </div>
      <div class="cmp-ov-actions">
        <button type="button" class="cmp-ov-btn cmp-ov-primary" data-help-close>Close</button>
      </div>`;
    const closeBtn = ov.card.querySelector("[data-help-close]") as HTMLButtonElement | null;
    closeBtn?.addEventListener("click", () => ov.close());
  }

  function onWindowKey(e: KeyboardEvent): void {
    // Skip when any overlay is open (confirm / prompt / help / move-picker).
    if (modal.dialog.querySelector(".cmp-ov-backdrop")) return;
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
        if (f) openFull(f);
        break;
      case "w":
        // Same gate as the ⤓ button: META_EXTS, every tab (a read, not a write).
        e.preventDefault();
        e.stopPropagation();
        if (f && META_EXTS.has((f.ext || "").toLowerCase())) void loadWorkflow(f);
        break;
      case "i":
        // Same gate as the ⓘ button: META_EXTS, every tab (a read, not a write).
        e.preventDefault();
        e.stopPropagation();
        if (f && META_EXTS.has((f.ext || "").toLowerCase())) void openMetadata(f);
        break;
      case "r":
        if (SANDBOXED_TYPES.includes(state.type) && f) {
          e.preventDefault();
          e.stopPropagation();
          void onRename(f);
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
  if (savedView.recovered) {
    notify({
      severity: "warn",
      summary: "Reopened in folder view",
      detail: "The last flat-view load didn't finish, so the browser fell back to folder view.",
    });
  }
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
  // When moving a folder, its own path — the picker hides that folder and its
  // subtree (a folder can't be its own destination) and disables "Move here"
  // on the folder's current parent (a no-op move).
  exclude?: Destination,
): Promise<Destination | null> {
  return new Promise((resolve) => {
    const ov = openShellOverlay(modal, { onDismiss: () => resolve(null) });
    ov.card.classList.add("ib-move-card");

    // The excluded folder's current parent — moving back there is a no-op.
    const excludeParent = exclude
      ? exclude.subfolder.includes("/")
        ? exclude.subfolder.slice(0, exclude.subfolder.lastIndexOf("/"))
        : ""
      : "";
    const inExcluded = (type: BrowseType, sub: string): boolean =>
      exclude !== undefined &&
      type === exclude.type &&
      (sub === exclude.subfolder || sub.startsWith(`${exclude.subfolder}/`));

    // Open at the last successful move destination (sorting a batch into the
    // same folder is the common case); fall back to the current location.
    const remembered = loadSavedDest();
    const cur: Destination = remembered ?? {
      type: SANDBOXED_TYPES.includes(start.type) ? start.type : "output",
      subfolder: start.subfolder,
    };

    const title = document.createElement("div");
    title.className = "cmp-ov-title";
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
    status.className = "cmp-ov-msg";

    const row = document.createElement("div");
    row.className = "cmp-ov-actions";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "cmp-ov-btn";
    cancel.textContent = "Cancel";
    cancel.addEventListener("click", () => {
      ov.close();
      resolve(null);
    });
    const moveHere = document.createElement("button");
    moveHere.type = "button";
    moveHere.className = "cmp-ov-btn cmp-ov-primary";
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
      // Disable "Move here" when the destination is the folder's current parent
      // (no-op) or somehow inside its own subtree (defensive — the rows below
      // are hidden, so this shouldn't be reachable by navigation).
      const noop =
        exclude !== undefined && cur.type === exclude.type && cur.subfolder === excludeParent;
      moveHere.disabled = noop || inExcluded(cur.type, cur.subfolder);
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
          if (inExcluded(p.type, p.subfolder)) continue;
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
          none.className = "cmp-ov-msg";
          none.textContent = "No subfolders — move into the root above.";
          list.appendChild(none);
        }
        for (const d of data.dirs) {
          const childSub = cur.subfolder ? `${cur.subfolder}/${d.name}` : d.name;
          // Hide the folder being moved (and its subtree) — it can't be its own
          // destination, and descending into it must be impossible.
          if (inExcluded(cur.type, childSub)) continue;
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

// ============================================================
// Styles
// ============================================================

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
/* Flat-view folder label above the thumbnail — a tap jumps to that folder. */
.ib-subpath {
    display: block; width: 100%; text-align: left; box-sizing: border-box;
    padding: 5px 8px; font-size: 10px; line-height: 1.3; min-height: 26px;
    color: #8a9bb5; background: transparent; border: 0;
    border-bottom: 1px solid #2a2a32;
    white-space: nowrap; text-overflow: ellipsis; overflow: hidden;
    font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; cursor: pointer;
}
.ib-subpath:hover { color: #9ec6ff; background: #23232e; }
.ib-subpath.is-root { color: #555; cursor: default; }
.ib-subpath.is-root:hover { background: transparent; color: #555; }
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
/* "Move here" is disabled on a folder's own parent/subtree (a no-op or illegal
   destination) — dim it so the reason for the dead button is legible. */
.ib-move-card .cmp-ov-primary:disabled { opacity: 0.4; cursor: not-allowed; }
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
.ib-view-toggle.is-active { background: #2f3a52; color: #9ec6ff; border-color: #4a5878; }
/* Keep the selection checkbox over the thumbnail corner, below the subpath row. */
.ib-card.is-flat .ib-check { top: 30px; }
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
/* Folder move — corner overlay on dir cards, mirroring the delete button on the
   opposite side (write-gated). */
.ib-dir-move {
    position: absolute; top: 4px; left: 4px; z-index: 2;
    width: 34px; height: 34px; padding: 0; border-radius: 6px;
    border: 1px solid rgba(255, 255, 255, 0.2); background: rgba(0, 0, 0, 0.45);
    color: #b8b8c0; font-size: 14px; line-height: 1; cursor: pointer;
}
.ib-dir-move:hover { background: #3a3a4a; color: #fff; }
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
/* Metadata overlay (the ⓘ card). The ib-meta-* namespace is distinct from the
   card's own .ib-meta dimensions line — class selectors match whole tokens, so
   .ib-meta never catches .ib-meta-row and vice versa. */
.ib-meta-card { width: min(680px, calc(100% - 24px)); max-height: calc(100% - 24px); }
.ib-meta-body {
    display: flex; flex-direction: column; gap: 8px;
    overflow-y: auto; padding: 8px 0; -webkit-overflow-scrolling: touch;
}
.ib-meta-status { padding: 14px 2px; font-size: 12.5px; color: #888; font-style: italic; }
.ib-meta-src {
    display: flex; align-items: baseline; gap: 8px; font-size: 11.5px; color: #9ec6ff;
    text-transform: uppercase; letter-spacing: 0.5px;
}
.ib-meta-fmt { color: #777; text-transform: none; letter-spacing: 0; }
.ib-meta-row { display: grid; grid-template-columns: 84px 1fr auto; gap: 8px; align-items: start; }
.ib-meta-k {
    padding-top: 7px; font-size: 11px; color: #8a8a92;
    text-transform: uppercase; letter-spacing: 0.4px;
}
.ib-meta-v {
    /* A long positive prompt scrolls inside its own box instead of pushing the
       Copy buttons and the overlay actions off the card. Selectable: the card is
       a reading surface, unlike the grid (which suppresses selection for
       long-press). */
    max-height: 7.5em; overflow-y: auto;
    padding: 6px 8px; font-size: 12px; line-height: 1.45; color: #d8d8dc;
    background: #17171e; border: 1px solid #2a2a32; border-radius: 4px;
    font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
    white-space: pre-wrap; overflow-wrap: anywhere;
    user-select: text; -webkit-user-select: text;
}
.ib-meta-copy {
    background: #2a2a36; color: #b8b8c0; border: 1px solid #33333f; border-radius: 4px;
    padding: 0 10px; font-size: 12px; cursor: pointer; font-family: inherit; min-height: 32px;
}
.ib-meta-copy:hover { background: #3a3a4a; color: #fff; }
.ib-meta-copy.is-copied { background: #25402f; color: #8fe0a8; border-color: #37624a; }
.ib-meta-empty { padding: 16px 2px; font-size: 12.5px; color: #777; font-style: italic; }
.ib-meta-note { font-size: 11.5px; color: #c8a95c; }
.ib-meta-raw > summary {
    padding: 7px 0; font-size: 12px; color: #9ec6ff; cursor: pointer; min-height: 32px;
}
.ib-meta-raw pre {
    margin: 4px 0 8px; padding: 8px; max-height: 30vh; overflow: auto;
    background: #17171e; border: 1px solid #2a2a32; border-radius: 4px;
    font-size: 11px; color: #b8b8c0; white-space: pre-wrap; overflow-wrap: anywhere;
    user-select: text; -webkit-user-select: text;
}
@media (max-width: 600px) {
    /* Stack the label above the value — an 84px gutter leaves the prompt column
       unreadably narrow on a phone. */
    .ib-meta-row { grid-template-columns: 1fr auto; }
    .ib-meta-k { grid-column: 1 / -1; padding-top: 0; }
}
`;
