// lightbox-actions.ts — rate and delete from inside ComfyUI's stock lightbox,
// the full-screen viewer that "Inspect asset" opens from the Media Assets
// sidebar (and that the Queue sidebar reuses).
//
// WHY THIS EXISTS
//
// The sidebar cards already carry stars (sidebar-stars.ts), but a card is a
// thumbnail: judging a fresh generation means opening it full-screen, and the
// lightbox already has ←/→ navigation. Adding the two verdict actions there —
// a rating and a delete — turns it into a cull pass: open the newest output,
// rate, delete the duds, arrow to the next, without ever going back to the grid.
//
// WHY IT IS DOM INJECTION (same argument as sidebar-stars.ts)
//
// MediaLightbox.vue takes props and emits `update:activeIndex`; it has no slot,
// and ComfyExtension exposes no hook for it. Verified identical in the shipped
// 1.47.10 bundle and the 1.50.0 source: a Teleport-to-body
// `[role=dialog][aria-modal=true][data-mask]` whose own keydown handler maps
// ArrowLeft/ArrowRight to navigation and Escape to close. Those three
// attributes and that key contract are the whole integration surface.
//
// THE FOUR THINGS THAT MAKE IT SURVIVABLE
//
// 1. One dialog element outlives many items. Navigating swaps the media
//    element's `src` in place, so — exactly like a recycled sidebar card — no
//    state may be bound to the bar. Every pass re-derives the address from the
//    live media `src` and repaints; a changed address blanks the stars to 0
//    before the read lands, because a neutral 0 beats a confident wrong rating
//    on someone else's image.
// 2. Identity is the `/api/view` URL, shared with sidebar-stars via
//    rating-cache.ts. Rating here therefore updates the card underneath, which
//    repaints when the lightbox tears down and the sidebar's observer fires.
// 3. Navigation is driven through the component's OWN key contract
//    (dispatch ArrowRight / Escape), never by clicking its buttons — those
//    carry i18n'd aria-labels and utility-class icons, both of which move.
// 4. Everything is best-effort. A rotted selector renders no bar; each pass is
//    wrapped; the bar never swallows the dialog's own mask-close (it carries no
//    `data-mask`, so the stock mouseup check ignores it).

import type { RatingAddress } from "@laurigates/comfy-modal-kit";
import {
  applyStars,
  ensureStyleOnce,
  nextRating,
  notify,
  postRating,
  starsHTML,
} from "@laurigates/comfy-modal-kit";
import { deleteFile, EXT_NAME, RATING_URL } from "./api.js";
import { addressKey, fetchRatings, parseAssetAddress, ratingCache } from "./rating-cache.js";

const STYLE_ID = "ib-lightbox-actions-style";
const BAR_CLASS = "ibl-bar";
const ROW_CLASS = "ibl-stars";
const DEL_CLASS = "ibl-del";
/** Records which address the bar is currently painted for, so a pass is idempotent. */
const KEY_ATTR = "data-ibl";
/** Coalesce the mutation storm a navigation produces into one pass. */
const SETTLE_MS = 80;

/**
 * The stock MediaLightbox root. All three attributes are load-bearing:
 * `data-mask` is what distinguishes it from every other dialog the frontend
 * teleports to body (settings, manager, our own shell), and it is present in
 * both 1.47.x and 1.50.
 */
const LIGHTBOX_SELECTOR = '[role="dialog"][aria-modal="true"][data-mask]';

/**
 * Files deleted in this session. The lightbox's item list is a prop owned by
 * the sidebar; we cannot refresh it, so a deleted file stays navigable until
 * the sidebar reloads. Rather than let it look rateable, a known-deleted
 * address paints a plain "Deleted" notice in place of the controls.
 */
const deleted = new Set<string>();

/** In-flight read, so a fast arrow-through does not paint a stale response. */
let readToken = 0;

/**
 * Pull the address of the item currently on screen out of the lightbox.
 *
 * The lightbox renders an image, a video, an audio player or a text view
 * depending on the item, so this walks the media elements rather than assuming
 * an `<img>`. Returns null for anything not addressable (a cloud asset, a
 * blob: placeholder), which is the honest answer — the caller renders no bar.
 *
 * ## Do NOT widen this to accept `/api/viewvideo`
 *
 * VHS-format videos render no bar, and the tempting one-line "fix" is to let
 * `parseAssetAddress` take `/api/viewvideo` too. **That would delete the wrong
 * file.** The two URLs are built from different sources, and only one is
 * trustworthy (read out of the 1.50.0 source, reproduced live on 1.47.10):
 *
 * - `AssetsSidebarTab.vue` maps each asset to a `ResultItemImpl` with
 *   `subfolder: ''` **hard-coded**, then overrides *only* the `url` getter to
 *   return the asset's real `preview_url`. So `/api/view` carries the true
 *   subfolder — that is why rating an image here addresses the right file.
 * - `ResultVideo.vue` uses `vhsAdvancedPreviewUrl` for VHS formats, which is
 *   rebuilt from `urlParams` — i.e. from that discarded `subfolder: ''`. The
 *   resulting URL points at the wrong path entirely.
 *
 * Measured on the live box: a `.webm` in `output/nsfw/2026-08-04/` gave
 * `/api/viewvideo?...&subfolder=` → **HTTP 204, empty** (the stock viewer shows
 * a blank player — an upstream bug in its own right), while the sidebar card's
 * correctly-subfoldered `/api/view` for the same file gave 206. Accepting that
 * URL would have addressed `output/<name>`, and a delete would then have hit
 * whatever unrelated file sits at the output root under that name.
 *
 * So the `/api/view` restriction is not incidental — it is the discriminator
 * between "this URL is the asset's real address" and "this URL was rebuilt
 * from state the frontend threw away". Videos get no bar until upstream stops
 * dropping the subfolder.
 */
export function activeAddress(dialog: ParentNode): RatingAddress | null {
  for (const el of dialog.querySelectorAll("img, video, audio, source")) {
    const addr = parseAssetAddress(el.getAttribute("src"));
    if (addr) return addr;
  }
  return null;
}

/**
 * Whether the lightbox is showing more than one item, read off the presence of
 * its next-item control (`v-if="hasMultiple"`).
 *
 * The icon class is the least stable thing this module touches, so the failure
 * is chosen deliberately: a rotted match reads as "single item", and the delete
 * path then CLOSES the lightbox instead of advancing. Closing is always safe;
 * advancing on a one-item list would land back on the file just deleted.
 */
export function hasMultipleItems(dialog: ParentNode): boolean {
  return !!dialog.querySelector('[class*="chevron-right"]');
}

/** Drive the lightbox through its own documented key contract. */
function sendKey(dialog: HTMLElement, key: string): void {
  dialog.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
}

/**
 * A yes/no overlay inside the lightbox dialog.
 *
 * The kit's `confirmInShell` wants a ModalShellController (it suspends the
 * shell's ESC handler via `_onKey`), and there is no shell here — the dialog is
 * the frontend's. So this is a small local overlay. It stops keydown in the
 * capture phase while up, so ESC dismisses the confirm rather than closing the
 * lightbox out from under it, and arrow keys cannot navigate to a different
 * file between the question and the answer — which would delete the wrong one.
 */
function confirmInLightbox(dialog: HTMLElement, name: string): Promise<boolean> {
  return new Promise((resolve) => {
    const backdrop = document.createElement("div");
    backdrop.className = "ibl-ov";
    backdrop.innerHTML = `
<div class="ibl-ov-card">
  <div class="ibl-ov-title">Delete file?</div>
  <div class="ibl-ov-msg"></div>
  <div class="ibl-ov-actions">
    <button type="button" class="ibl-ov-btn" data-act="cancel">Cancel</button>
    <button type="button" class="ibl-ov-btn ibl-ov-danger" data-act="ok">Delete</button>
  </div>
</div>`;
    // textContent, not innerHTML: a filename is user data and lands in markup.
    const msg = backdrop.querySelector(".ibl-ov-msg") as HTMLElement;
    msg.textContent = `${name} will be permanently deleted from disk. This cannot be undone.`;

    let done = false;
    const finish = (v: boolean) => {
      if (done) return;
      done = true;
      document.removeEventListener("keydown", onKey, true);
      backdrop.remove();
      resolve(v);
    };
    const onKey = (e: KeyboardEvent) => {
      // Swallow everything: the lightbox's own handler owns ←/→/ESC, and none
      // of them may act while a delete confirm is open.
      e.stopPropagation();
      if (e.key === "Escape") {
        e.preventDefault();
        finish(false);
      } else if (e.key === "Enter") {
        e.preventDefault();
        finish(true);
      }
    };
    backdrop.addEventListener("click", (e) => {
      const act = (e.target as HTMLElement).closest("[data-act]")?.getAttribute("data-act");
      if (act) {
        e.stopPropagation();
        finish(act === "ok");
      } else if (e.target === backdrop) {
        finish(false);
      }
    });
    document.addEventListener("keydown", onKey, true);
    dialog.appendChild(backdrop);
    (backdrop.querySelector('[data-act="ok"]') as HTMLElement | null)?.focus();
  });
}

async function runDelete(dialog: HTMLElement, addr: RatingAddress): Promise<void> {
  if (!(await confirmInLightbox(dialog, addr.name))) return;
  const advance = hasMultipleItems(dialog);
  try {
    await deleteFile(addr.type as Parameters<typeof deleteFile>[0], addr.subfolder, addr.name);
  } catch (err) {
    notify({
      severity: "error",
      summary: "Delete failed",
      detail: `${addr.name}: ${err instanceof Error ? err.message : String(err)}`,
    });
    return;
  }
  const key = addressKey(addr);
  deleted.add(key);
  ratingCache.delete(key);
  notify({ severity: "success", summary: "Deleted", detail: addr.name });
  // The sidebar still holds the deleted item in its list, so advancing leaves a
  // dead entry behind us; stepping onto it later shows the "Deleted" notice
  // instead of rateable stars. Closing is the right move for the last item —
  // there is nothing else to advance to.
  sendKey(dialog, advance ? "ArrowRight" : "Escape");
}

export function installLightboxActions(): () => void {
  ensureStyleOnce(
    STYLE_ID,
    `
.${BAR_CLASS} {
  position: absolute; bottom: 16px; left: 50%; transform: translateX(-50%);
  z-index: 10; display: flex; align-items: center; gap: 18px;
  padding: 8px 14px; border-radius: 999px;
  background: rgba(20, 20, 26, 0.82); border: 1px solid #33333f;
  backdrop-filter: blur(6px); user-select: none; touch-action: manipulation;
}
.${ROW_CLASS} { display: flex; gap: 2px; }
.${ROW_CLASS} button {
  background: none; border: 0; padding: 2px 4px; cursor: pointer; line-height: 1;
  /* Deliberately larger than the sidebar's 13px row: this is the tap target
     you use one-handed while flicking through a batch. */
  font-size: 26px; min-width: 34px; min-height: 34px; color: #55555f;
}
.${ROW_CLASS} button.is-on { color: #ffb02e; }
.${ROW_CLASS} button:hover { color: #ffc95e; }
.${DEL_CLASS} {
  background: #4a2230; border: 1px solid #78384a; color: #ff9eb0;
  font: inherit; font-size: 15px; border-radius: 8px; cursor: pointer;
  min-width: 44px; min-height: 34px; padding: 0 12px;
}
.${DEL_CLASS}:hover { background: #5c2a3c; color: #fff; }
.ibl-note { color: #b8b8c0; font-size: 13px; padding: 0 6px; }
.ibl-ov {
  position: absolute; inset: 0; z-index: 20; display: flex;
  align-items: center; justify-content: center; padding: 16px;
  background: rgba(0, 0, 0, 0.6); touch-action: manipulation;
}
.ibl-ov-card {
  background: #1c1c24; border: 1px solid #33333f; border-radius: 10px;
  padding: 18px; width: min(460px, calc(100% - 24px));
  display: flex; flex-direction: column; gap: 12px;
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.5);
}
.ibl-ov-title { font-size: 15px; font-weight: 600; color: #e8e8ec; }
.ibl-ov-msg { font-size: 13px; color: #b8b8c0; line-height: 1.5; word-break: break-word; }
.ibl-ov-actions { display: flex; justify-content: flex-end; gap: 8px; }
.ibl-ov-btn {
  font-size: 13px; padding: 9px 16px; border-radius: 6px; min-height: 38px;
  border: 1px solid #3a3a44; background: #2a2a36; color: #d8d8dc;
  cursor: pointer; font-family: inherit;
}
.ibl-ov-btn:hover { background: #3a3a4a; color: #fff; }
.ibl-ov-danger { background: #4a2230; color: #ff9eb0; border-color: #78384a; }
.ibl-ov-danger:hover { background: #5c2a3c; color: #fff; }
`,
  );

  let timer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  // Delegated + capture phase, for the same reason as the sidebar: the bar is
  // created and destroyed with the dialog, and the dialog stops propagation on
  // its own root.
  const onClick = (e: Event) => {
    const target = e.target as Element | null;
    const bar = target?.closest?.(`.${BAR_CLASS}`) as HTMLElement | null;
    if (!bar) return;
    const dialog = bar.closest(LIGHTBOX_SELECTOR) as HTMLElement | null;
    const addr = dialog ? activeAddress(dialog) : null;
    if (!dialog || !addr || deleted.has(addressKey(addr))) return;

    if (target?.closest(`.${DEL_CLASS}`)) {
      e.preventDefault();
      e.stopPropagation();
      void runDelete(dialog, addr);
      return;
    }

    const star = target?.closest(`.${ROW_CLASS} [data-val]`) as HTMLElement | null;
    const row = bar.querySelector(`.${ROW_CLASS}`) as HTMLElement | null;
    if (!star || !row) return;
    e.preventDefault();
    e.stopPropagation();
    const prev = Number(row.dataset.rating || "0");
    const next = nextRating(prev, Number(star.dataset.val));
    // Optimistic paint, reverted if the write fails.
    applyStars(row, next);
    void postRating(RATING_URL, addr, next)
      .then((confirmed) => {
        ratingCache.set(addressKey(addr), confirmed);
        applyStars(row, confirmed);
      })
      .catch((err) => {
        ratingCache.set(addressKey(addr), prev);
        applyStars(row, prev);
        notify({
          severity: "error",
          summary: "Rating failed",
          detail: `${addr.name}: ${err instanceof Error ? err.message : String(err)}`,
        });
      });
  };
  document.addEventListener("click", onClick, true);

  function paint(): void {
    const dialog = document.querySelector(LIGHTBOX_SELECTOR) as HTMLElement | null;
    if (!dialog) return;
    const addr = activeAddress(dialog);
    const existing = dialog.querySelector(`.${BAR_CLASS}`) as HTMLElement | null;
    if (!addr) {
      // Not an addressable file (cloud asset, blob: placeholder). Show nothing
      // rather than a bar whose buttons would have nothing to act on.
      existing?.remove();
      return;
    }
    const key = addressKey(addr);
    let bar = existing;
    if (bar && bar.getAttribute(KEY_ATTR) === key) {
      // Same file as the last pass — the cache may have moved under us (the
      // sidebar's batch read), so repaint from it but do not re-request.
      const known = ratingCache.get(key);
      const row = bar.querySelector(`.${ROW_CLASS}`) as HTMLElement | null;
      if (row && typeof known === "number") applyStars(row, known);
      return;
    }

    // A new file: rebuild rather than repaint. The controls differ between the
    // deleted and live states, and a kept bar would show the previous file's
    // rating over the new image until the read lands.
    bar?.remove();
    bar = document.createElement("div");
    bar.className = BAR_CLASS;
    bar.setAttribute(KEY_ATTR, key);
    bar.setAttribute("draggable", "false");

    if (deleted.has(key)) {
      const note = document.createElement("div");
      note.className = "ibl-note";
      note.textContent = "Deleted — reopen the sidebar to refresh this list";
      bar.appendChild(note);
      dialog.appendChild(bar);
      return;
    }

    const holder = document.createElement("div");
    holder.innerHTML = starsHTML("ibl", ratingCache.get(key) ?? 0);
    const row = holder.firstElementChild as HTMLElement | null;
    if (!row) return;
    row.classList.add(ROW_CLASS);
    const del = document.createElement("button");
    del.type = "button";
    del.className = DEL_CLASS;
    del.title = "Delete this file from disk";
    del.setAttribute("aria-label", "Delete file");
    del.textContent = "🗑";
    bar.append(row, del);
    dialog.appendChild(bar);

    // Always re-read on navigation instead of trusting the shared cache. It is
    // one request per item viewed — trivial next to loading the full-size image
    // — and it is what keeps a rating changed in the Image Browser modal from
    // showing stale here (the staleness the sidebar injector documents).
    const token = ++readToken;
    void fetchRatings([addr])
      .then(([r]) => {
        if (disposed || token !== readToken) return;
        // null means "could not read", distinct from 0 ("unrated") — leave the
        // cache alone rather than recording a confident zero.
        if (typeof r !== "number") return;
        ratingCache.set(key, r);
        // Re-find the row: a navigation during the request would have replaced
        // the bar, and painting the captured one would paint the wrong file.
        const live = document.querySelector(
          `${LIGHTBOX_SELECTOR} .${BAR_CLASS}[${KEY_ATTR}="${CSS.escape(key)}"] .${ROW_CLASS}`,
        ) as HTMLElement | null;
        if (live) applyStars(live, r);
      })
      .catch((err) => {
        console.warn(`[${EXT_NAME}] lightbox rating read failed`, err);
      });
  }

  function schedule(): void {
    if (disposed) return;
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      // Fail soft: a rotted selector renders nothing rather than throwing into
      // the framework's mutation callback.
      try {
        paint();
      } catch (err) {
        console.warn(`[${EXT_NAME}] lightbox pass failed`, err);
      }
    }, SETTLE_MS);
  }

  const observer = new MutationObserver(schedule);
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["src"],
  });
  schedule();

  return () => {
    disposed = true;
    if (timer !== null) clearTimeout(timer);
    observer.disconnect();
    document.removeEventListener("click", onClick, true);
    for (const el of document.querySelectorAll(`.${BAR_CLASS}, .ibl-ov`)) el.remove();
  };
}
