// lightbox.ts — the Image Browser's own full-screen viewer.
//
// A card tap used to open the file in a new browser tab. This replaces that with
// an in-dialog viewer that steps through the grid in its CURRENT order and
// filter, and carries the same rate + delete verdicts the stock-lightbox
// injector (lightbox-actions.ts) adds to ComfyUI's MediaLightbox.
//
// Why not ComfyUI's MediaLightbox itself: it has no extension point. Its
// visibility is a component-local ref, and every parent (Media Assets sidebar,
// queue overlay, agent panel) mounts a private copy bound to its own item list
// — there is no store or command an extension can hand a file list to. It also
// only knows output assets, while this browser shows input, temp and absolute
// paths.
//
// Three constraints are load-bearing:
//
// 1. IT IS NOT AN openShellOverlay. The kit's overlay binds its own ESC
//    dismissal, and a nested confirmInShell (the delete question) re-adds the
//    shell's ESC handler when IT closes. With the kit overlay, ESC on the delete
//    confirm would dismiss the confirm AND the viewer, and after it the next ESC
//    would close the whole browser from inside the viewer. So this owns its key
//    handling, ignores every key while the question is up, and re-suspends the
//    shell's handler once the question answers.
//
// 2. THE ROOT CARRIES `cmp-ov-backdrop`. The browser's window-level key handler
//    bails whenever that class is present in the dialog; that is the contract
//    every in-dialog overlay relies on, so without it `d d` would delete the
//    focused grid file behind the viewer.
//
// 3. NAVIGATION RE-READS THE LIST ON EVERY STEP and tracks the FILE, never an
//    index. A delete re-renders the grid, which replaces `renderedFiles`; an
//    index captured at open would then address a different file.
//
// The info panel (issue #112) shows the viewed file's embedded generation
// metadata beside it, through the same renderer as the grid's ⓘ card
// (meta-view.ts). It is read per item, cached for the viewer's lifetime, and
// a late answer for a file already stepped past is dropped. A Safe View match
// that arrives blurred has its metadata WITHHELD until it is revealed: the
// prompt is exactly the text the blur is standing in for.

import type { ModalShellController } from "@laurigates/comfy-modal-kit";
import {
  applyStars,
  ensureStyleOnce,
  escapeHTML as escHTML,
  makeRevealButton,
  nextRating,
  setBlurred,
  starsHTML,
} from "@laurigates/comfy-modal-kit";
import type { ImageMetadata } from "./api.js";
import { META_LOADING_HTML, renderMeta, wireMetaCopy } from "./meta-view.js";

const STYLE_ID = "ib-lightbox-style";

/** Per-device memory of whether the info panel is open. */
const INFO_STORAGE_KEY = "comfyui-image-browser:lightbox-info";

/** Viewers at least this wide open the info panel by default, as a side column. */
const INFO_WIDE_PX = 900;
const INFO_WIDE_QUERY = `(min-width: ${INFO_WIDE_PX}px)`;

/**
 * Saved choice, else open when the VIEWER is wide and closed on a phone. The
 * viewer's own width, not the viewport's: docked (src/dock.ts) it lives in a
 * ~480px panel on a wide screen. A zero width (jsdom, not yet laid out) falls
 * back to the viewport query.
 */
function initialInfoOpen(host: HTMLElement): boolean {
  try {
    const raw = localStorage.getItem(INFO_STORAGE_KEY);
    if (raw === "1") return true;
    if (raw === "0") return false;
  } catch {
    /* private-mode / disabled storage — fall through to the default */
  }
  if (host.clientWidth > 0) return host.clientWidth >= INFO_WIDE_PX;
  // jsdom and very old engines have no matchMedia; closed is the cheap default.
  return typeof window.matchMedia === "function" && window.matchMedia(INFO_WIDE_QUERY).matches;
}

function saveInfoOpen(open: boolean): void {
  try {
    localStorage.setItem(INFO_STORAGE_KEY, open ? "1" : "0");
  } catch {
    /* non-fatal */
  }
}

/** Minimum horizontal travel, in px, for a swipe to count as navigation. */
export const SWIPE_MIN_PX = 50;

/** What the viewer needs from the browser — the file object is opaque here. */
export interface LightboxDeps<F> {
  shell: ModalShellController;
  /** The grid's files in display order. Read on every step, never cached. */
  files: () => readonly (F | null | undefined)[];
  name: (f: F) => string;
  kind: (f: F) => "image" | "video" | "other";
  /** Full-size URL, or a sentence explaining why this file cannot be shown. */
  src: (f: F) => { url: string } | { blocked: string };
  /** Current rating, or null when this file cannot be rated (read-only root). */
  rating: (f: F) => number | null;
  /** Persist a rating. Resolves to the rating the server confirmed. */
  rate: (f: F, next: number) => Promise<number>;
  canDelete: (f: F) => boolean;
  /** Ask, then delete. Resolves true only when the file is gone. */
  remove: (f: F) => Promise<boolean>;
  /** Safe View: whether this file should be blurred right now. */
  hidden: (f: F) => boolean;
  reveal: (f: F) => void;
  openInTab: (f: F) => void;
  /**
   * Embedded metadata for the info panel, or null when this file's container
   * has no reader. Omit it and the viewer has no info panel at all.
   */
  metadata?: (f: F) => Promise<ImageMetadata> | null;
  /** Called once, with the file on screen when the viewer closed. */
  onClose: (last: F | null) => void;
}

export interface LightboxHandle<F> {
  close: () => void;
  current: () => F | null;
}

function neighbour<F>(
  list: readonly (F | null | undefined)[],
  from: number,
  dir: -1 | 1,
): F | null {
  for (let i = from + dir; i >= 0 && i < list.length; i += dir) {
    const f = list[i];
    if (f) return f;
  }
  return null;
}

export function openLightbox<F>(start: F, deps: LightboxDeps<F>): LightboxHandle<F> {
  ensureStyleOnce(STYLE_ID, CSS);
  const { shell } = deps;

  const root = document.createElement("div");
  root.className = "cmp-ov-backdrop ib-lb";
  root.setAttribute("role", "dialog");
  root.setAttribute("aria-modal", "true");
  root.setAttribute("aria-label", "Image viewer");
  root.innerHTML = `
    <button type="button" class="ib-lb-btn ib-lb-close" data-lb="close" aria-label="Close">✕</button>
    <button type="button" class="ib-lb-btn ib-lb-nav ib-lb-prev" data-lb="prev" aria-label="Previous">‹</button>
    <div class="ib-lb-stage"></div>
    <button type="button" class="ib-lb-btn ib-lb-nav ib-lb-next" data-lb="next" aria-label="Next">›</button>
    <aside class="ib-lb-info" aria-label="Metadata"></aside>
    <div class="ib-lb-bar"></div>`;
  const stage = root.querySelector(".ib-lb-stage") as HTMLElement;
  const bar = root.querySelector(".ib-lb-bar") as HTMLElement;
  const info = root.querySelector(".ib-lb-info") as HTMLElement;
  const prevBtn = root.querySelector(".ib-lb-prev") as HTMLButtonElement;
  const nextBtn = root.querySelector(".ib-lb-next") as HTMLButtonElement;

  let current: F | null = null;
  let closed = false;
  /** True while the delete question is up: every key belongs to it. */
  let busy = false;
  const hasInfo = typeof deps.metadata === "function";
  let infoOpen = hasInfo && initialInfoOpen(shell.dialog);
  /** One read per file per viewer session; stepping back reuses it. */
  const metaCache = new Map<F, Promise<ImageMetadata>>();
  root.classList.toggle("has-info", infoOpen);

  function paintInfo(f: F): void {
    if (!infoOpen || !deps.metadata) return;
    if (deps.hidden(f)) {
      info.innerHTML = `<div class="ib-meta-status">Hidden by Safe View. Reveal the image to show its metadata.</div>`;
      return;
    }
    let p = metaCache.get(f);
    if (!p) {
      const read = deps.metadata(f);
      if (!read) {
        info.innerHTML = `<div class="ib-meta-status">No metadata reader for this file type.</div>`;
        return;
      }
      p = read;
      metaCache.set(f, p);
    }
    info.innerHTML = `<div class="ib-lb-info-head">Metadata</div>${META_LOADING_HTML}`;
    p.then(
      (data) => {
        if (current !== f || !infoOpen || closed) return;
        const meta = renderMeta(data);
        info.innerHTML = `
          <div class="ib-lb-info-head">Metadata ${
            // Its own button class: the overlay's cmp-ov-btn styles are only
            // injected once a kit overlay has opened, which may be never.
            meta.rows.length
              ? `<button type="button" class="ib-meta-copy" data-copy-all>Copy all</button>`
              : ""
          }</div>
          <div class="ib-meta-body">${meta.html}</div>`;
        wireMetaCopy(info, meta);
      },
      (e: unknown) => {
        if (current !== f || !infoOpen || closed) return;
        const msg = e instanceof Error ? e.message : String(e);
        info.innerHTML = `<div class="ib-lb-info-head">Metadata</div><div class="ib-meta-status">Metadata read failed: ${escHTML(msg)}</div>`;
      },
    );
  }

  function toggleInfo(): void {
    if (!hasInfo) return;
    infoOpen = !infoOpen;
    saveInfoOpen(infoOpen);
    root.classList.toggle("has-info", infoOpen);
    bar.querySelector('[data-lb="info"]')?.setAttribute("aria-pressed", String(infoOpen));
    if (infoOpen && current) paintInfo(current);
    else info.innerHTML = "";
  }

  function indexOfCurrent(): number {
    return current ? deps.files().indexOf(current) : -1;
  }

  function show(f: F): void {
    current = f;
    const list = deps.files();
    const i = list.indexOf(f);
    prevBtn.hidden = !neighbour(list, i, -1);
    nextBtn.hidden = !neighbour(list, i, 1);

    // Media — rebuilt per item, so a playing video stops when you step off it.
    stage.innerHTML = "";
    const src = deps.src(f);
    const kind = deps.kind(f);
    if ("blocked" in src) {
      stage.innerHTML = `<div class="ib-lb-msg">🔒 ${escHTML(src.blocked)}</div>`;
    } else if (kind === "image") {
      const img = document.createElement("img");
      img.className = "ib-lb-media";
      img.alt = deps.name(f);
      // A drag starting on an <img> begins the native image drag, which fires
      // pointercancel and kills the swipe (measured in Chromium).
      img.draggable = false;
      img.src = src.url;
      stage.appendChild(img);
    } else if (kind === "video") {
      const v = document.createElement("video");
      v.className = "ib-lb-media";
      v.src = src.url;
      v.controls = true;
      v.autoplay = true;
      v.loop = true;
      v.playsInline = true;
      stage.appendChild(v);
    } else {
      stage.innerHTML = `<div class="ib-lb-msg">No preview for this file type.</div>`;
    }
    if (deps.hidden(f)) {
      for (const el of stage.querySelectorAll("img, video")) setBlurred(el, true);
      const btn = makeRevealButton({
        onReveal: () => {
          deps.reveal(f);
          if (current === f) show(f);
        },
      });
      btn.classList.add("ib-lb-reveal");
      stage.appendChild(btn);
    }

    // Bar — also rebuilt per item, so no rating can outlive the file it was for.
    const rating = deps.rating(f);
    const n = list.filter(Boolean).length;
    const pos = list.slice(0, i + 1).filter(Boolean).length;
    bar.innerHTML = `
      ${rating === null ? "" : starsHTML("ib", rating)}
      ${deps.canDelete(f) ? `<button type="button" class="ib-lb-btn" data-lb="delete" title="Delete…" aria-label="Delete">🗑</button>` : ""}
      ${hasInfo ? `<button type="button" class="ib-lb-btn" data-lb="info" title="Metadata (i)" aria-label="Metadata" aria-pressed="${infoOpen}">ⓘ</button>` : ""}
      <button type="button" class="ib-lb-btn" data-lb="tab" title="Open in new tab" aria-label="Open in new tab">↗</button>
      <span class="ib-lb-name" title="${escHTML(deps.name(f))}">${escHTML(deps.name(f))}</span>
      <span class="ib-lb-pos">${pos}/${n}</span>`;
    paintInfo(f);
  }

  function step(dir: -1 | 1): void {
    const next = neighbour(deps.files(), indexOfCurrent(), dir);
    if (next) show(next);
  }

  async function onDelete(): Promise<void> {
    const f = current;
    if (!f || busy) return;
    const before = deps.files();
    const at = before.indexOf(f);
    busy = true;
    let gone = false;
    try {
      gone = await deps.remove(f);
    } finally {
      busy = false;
      // confirmInShell restored the shell's ESC handler when it closed; the
      // viewer is still up, so take it back or the next ESC closes the browser.
      if (!closed) document.removeEventListener("keydown", shell._onKey, true);
    }
    if (closed || !gone) return;
    // The grid has re-rendered without `f`. Land on whatever now sits where it
    // was (the next file), else the one before it, else there is nothing left.
    const after = deps.files();
    const land = neighbour(after, at - 1, 1) ?? neighbour(after, at, -1);
    if (land) show(land);
    else close();
  }

  function onRate(star: HTMLElement): void {
    const f = current;
    const row = star.closest(".ib-stars") as HTMLElement | null;
    if (!f || !row) return;
    const prev = Number(row.dataset.rating || "0");
    const next = nextRating(prev, Number(star.dataset.val));
    applyStars(row, next);
    deps.rate(f, next).then(
      (confirmed) => {
        if (current === f && row.isConnected) applyStars(row, confirmed);
      },
      () => {
        if (current === f && row.isConnected) applyStars(row, prev);
      },
    );
  }

  root.addEventListener("click", (e) => {
    // The click a swipe's pointerup produces would otherwise land on the stage
    // and close the viewer.
    if (swiped) {
      swiped = false;
      return;
    }
    const t = e.target as HTMLElement;
    const star = t.closest(".ib-star") as HTMLElement | null;
    if (star) return onRate(star);
    const action = (t.closest("[data-lb]") as HTMLElement | null)?.dataset.lb;
    if (action === "close") close();
    else if (action === "prev") step(-1);
    else if (action === "next") step(1);
    else if (action === "delete") void onDelete();
    else if (action === "tab" && current) deps.openInTab(current);
    else if (action === "info") toggleInfo();
    // A tap on the empty area around the media closes, like the stock viewer.
    else if (t === root || t === stage) close();
  });

  // Swipe to navigate. Pointer events, not touch events, so a mouse drag works
  // the same way and there is one code path to test.
  let swipeX = 0;
  let swipeY = 0;
  let swiping = false;
  let swiped = false;
  root.addEventListener("pointerdown", (e) => {
    swiped = false;
    if ((e.target as HTMLElement).closest("button, video, .ib-lb-bar, .ib-lb-info")) return;
    swiping = true;
    swipeX = e.clientX;
    swipeY = e.clientY;
  });
  root.addEventListener("pointerup", (e) => {
    if (!swiping) return;
    swiping = false;
    const dx = e.clientX - swipeX;
    const dy = e.clientY - swipeY;
    if (Math.abs(dx) < SWIPE_MIN_PX || Math.abs(dx) < Math.abs(dy)) return;
    swiped = true;
    step(dx < 0 ? 1 : -1);
  });
  root.addEventListener("pointercancel", () => {
    swiping = false;
  });

  function onKey(e: KeyboardEvent): void {
    if (busy) return; // the delete question owns the keyboard
    let handled = true;
    if (e.key === "Escape") close();
    else if (e.key === "ArrowLeft") step(-1);
    else if (e.key === "ArrowRight") step(1);
    else if (e.key === "Delete" && current && deps.canDelete(current)) void onDelete();
    else if (e.key === "i" && hasInfo && !e.ctrlKey && !e.metaKey && !e.altKey) toggleInfo();
    else handled = false;
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
    }
  }

  function close(): void {
    if (closed) return;
    closed = true;
    document.removeEventListener("keydown", onKey, true);
    document.addEventListener("keydown", shell._onKey, true);
    root.remove();
    deps.onClose(current);
  }

  document.removeEventListener("keydown", shell._onKey, true);
  document.addEventListener("keydown", onKey, true);
  shell.dialog.appendChild(root);
  show(start);
  return { close, current: () => current };
}

const CSS = `
.ib-lb {
    position: absolute;
    inset: 0;
    z-index: 6;
    background: rgba(0, 0, 0, 0.92);
    display: flex;
    align-items: center;
    justify-content: center;
    touch-action: pan-y pinch-zoom;
    user-select: none;
    container-type: inline-size;
}
.ib-lb-stage {
    position: absolute;
    inset: 0 0 64px 0;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 12px;
}
.ib-lb-media {
    max-width: 100%;
    max-height: 100%;
    object-fit: contain;
}
.ib-lb-msg { color: #b8b8c0; font-size: 14px; max-width: 420px; text-align: center; line-height: 1.5; }
.ib-lb-reveal { position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); }
.ib-lb-btn {
    min-width: 44px;
    min-height: 44px;
    border-radius: 22px;
    border: 1px solid #3a3a44;
    background: rgba(28, 28, 36, 0.85);
    color: #e8e8ec;
    font-size: 18px;
    cursor: pointer;
    font-family: inherit;
}
.ib-lb-btn:hover { background: #3a3a4a; color: #fff; }
.ib-lb-btn[hidden] { display: none; }
.ib-lb-close { position: absolute; top: 12px; right: 12px; z-index: 1; }
.ib-lb-nav { position: absolute; top: calc(50% - 32px); z-index: 1; font-size: 26px; }
.ib-lb-prev { left: 12px; }
.ib-lb-next { right: 12px; }
.ib-lb-bar {
    position: absolute;
    left: 0;
    right: 0;
    bottom: 0;
    height: 64px;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 10px;
    padding: 0 12px;
    background: rgba(18, 18, 26, 0.9);
    color: #d8d8dc;
    font-size: 13px;
}
.ib-lb-bar .ib-stars { padding: 0; }
.ib-lb-bar .ib-star { font-size: 22px; padding: 8px 5px; min-width: 32px; min-height: 44px; }
.ib-lb-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; max-width: 40%; }
.ib-lb-pos { color: #8a8a96; font-variant-numeric: tabular-nums; }
.ib-lb-btn[aria-pressed="true"] { border-color: #6ba6ff; color: #fff; }
/* Info panel. Wide: a column beside the media, which shrinks to make room.
   Narrow: a sheet over the lower half of the stage, so the image keeps the
   full width a phone has. "Narrow" is a CONTAINER query on the viewer, not a
   media query: docked, the viewer is a ~480px panel on a wide screen. */
.ib-lb-info {
    display: none;
    position: absolute;
    right: 0;
    top: 0;
    bottom: 64px;
    width: 360px;
    overflow-y: auto;
    overscroll-behavior: contain;
    padding: 64px 14px 14px;
    box-sizing: border-box;
    background: rgba(18, 18, 26, 0.96);
    border-left: 1px solid #2a2a32;
    color: #d8d8dc;
    user-select: text;
    z-index: 0;
}
.ib-lb.has-info .ib-lb-info { display: block; }
.ib-lb.has-info .ib-lb-stage { right: 360px; }
.ib-lb.has-info .ib-lb-next { right: 372px; }
.ib-lb-info-head {
    display: flex; align-items: center; justify-content: space-between; gap: 8px;
    font-size: 12px; text-transform: uppercase; letter-spacing: 0.06em; color: #8a8a96;
    margin-bottom: 8px; min-height: 36px;
}
.ib-lb-info .ib-meta-row { grid-template-columns: 72px 1fr auto; }
.ib-lb-info .ib-meta-v { max-height: 16em; }
@container (max-width: 899px) {
    .ib-lb-info {
        top: auto; left: 0; width: auto; max-height: 50%;
        padding-top: 10px; border-left: 0; border-top: 1px solid #2a2a32;
    }
    .ib-lb.has-info .ib-lb-stage { right: 0; }
    .ib-lb.has-info .ib-lb-next { right: 12px; }
}
`;
