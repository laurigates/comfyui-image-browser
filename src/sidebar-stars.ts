// sidebar-stars.ts — star ratings on ComfyUI's stock "Media Assets" sidebar.
//
// WHY THIS IS DOM INJECTION AND NOT AN EXTENSION POINT
//
// ComfyExtension (src/types/comfy.ts in the frontend) offers commands,
// keybindings, menu commands, settings, bottom-panel tabs, sidebar TABS,
// topbar/action-bar buttons and canvas/node context-menu items. It offers
// nothing for media-asset cards: MediaAssetCard.vue has no slot, and
// MediaAssetContextMenu has no extension hook. Registering a whole rival
// sidebar tab would duplicate the stock one to add one row of stars, so the
// injection is the honest option — with the fail-soft rules below, and a
// setting to switch it off.
//
// This is NOT a comfyui-touch-shim shim: those paper over upstream BUGS and
// carry a filed issue plus a death date. This adds a capability the stock UI
// never had, so it lives with the pack that already owns the rating endpoint
// and the XMP code.
//
// THE THREE THINGS THAT MAKE THIS SURVIVABLE
//
// 1. The card grid is VIRTUALIZED (each card sits under a
//    [data-virtual-grid-item] wrapper). Card nodes are RECYCLED as you
//    scroll: the same DOM element is reused for a different file. So no state
//    may be bound to a node — every pass re-reads the address off the card's
//    own <img> and repaints from an address-keyed cache. Binding a rating to
//    an element is the bug that would show file A's stars on file B.
// 2. Identity comes from the preview URL, not a data-attribute. At
//    comfyui-frontend-package 1.47.x the card root carries no data-asset-id
//    (`main` has since added one), and the <img src> is the only per-card
//    identity present in both. It is also exactly the address the rating
//    endpoints take, so it needs no translation.
// 3. Everything is best-effort. A selector that rots must render NOTHING —
//    never throw, never block the card's own click handling, never leave the
//    app chrome in a broken state. Each pass is wrapped; a failed pass is a
//    console warning and no stars.

import type { RatingAddress, SafeViewConfig } from "@laurigates/comfy-modal-kit";
import {
  applyStars,
  ensureStyleOnce,
  isSensitive,
  nextRating,
  notify,
  onSafeViewChange,
  postRating,
  readSafeViewConfig,
  SAFE_VIEW_BLUR_CLASS,
  SAFE_VIEW_SPOILER_CLASS,
  setBlurred,
  setSpoilered,
  starsHTML,
} from "@laurigates/comfy-modal-kit";
import { EXT_NAME, RATING_URL } from "./api.js";
import {
  addressKey,
  clearRatingState,
  fetchRatings,
  MAX_BATCH,
  parseAssetAddress,
  ratingCache,
  requested,
} from "./rating-cache.js";

// Re-exported: the addressing helpers moved to rating-cache.ts when the
// lightbox injector needed them too, but they are still this module's public
// surface for the unit tests.
export { addressKey, parseAssetAddress };

const STYLE_ID = "ib-sidebar-stars-style";
const ROW_CLASS = "ibs-stars";
/** Marks a card we have already given a row, so a repaint pass is idempotent. */
const DONE_ATTR = "data-ibs";
/**
 * Mutation storms are the norm here — a virtualized grid rewrites many nodes
 * per scroll frame. Coalesce to one pass per idle gap instead of per record.
 */
const SETTLE_MS = 120;

/**
 * The stock MediaAssetCard root — the only structural anchor present in both
 * 1.47.x and `main`, and the thing that distinguishes a sidebar card from the
 * other places ComfyUI renders an /api/view image (canvas node previews, the
 * lightbox). Scoping every query through it is what keeps the injection inside
 * the sidebar.
 */
const CARD_SELECTOR = "[data-selected]";

function cardRootOf(img: Element): HTMLElement | null {
  return img.closest(CARD_SELECTOR) as HTMLElement | null;
}

/** Marks a card Safe View is currently hiding, for the CSS below and for tests. */
const SAFE_CARD_CLASS = "ibs-safe-hidden";

/**
 * Apply (or clear) Safe View on one stock card.
 *
 * NO TOGGLE IS INJECTED HERE, by design: nothing in ComfyUI's own chrome should
 * advertise that this filter exists. It follows the global setting silently;
 * the controls live in our modal, the settings dialog and the Touch Tools
 * chooser.
 *
 * CLEARED UNCONDITIONALLY BEFORE IT IS RE-APPLIED. The grid is virtualized —
 * card nodes are recycled for different files — so a card that carried the blur
 * for a sensitive file and is handed a harmless one must lose it, or the filter
 * becomes a permanent smear on whatever scrolled through that slot. Clearing by
 * CLASS rather than by re-deriving the previous file's name is what makes that
 * independent of what the node used to show: the same reason nothing else in
 * this module binds state to a node.
 *
 * The spoiler is applied to the elements whose text IS the filename, found by
 * CONTENT rather than by a stock class name. That is deliberate — the stock
 * card's internal classes are exactly the kind of thing that moves between
 * frontend versions, whereas "the element that renders this file's name" is
 * defined by the data we already hold. A miss renders nothing, and the
 * thumbnail blur (the part that matters) is unaffected.
 */
function applyCardSafeView(card: HTMLElement, addr: RatingAddress, cfg: SafeViewConfig): void {
  for (const el of card.querySelectorAll(`.${SAFE_VIEW_SPOILER_CLASS}`)) setSpoilered(el, false);
  for (const el of card.querySelectorAll(`.${SAFE_VIEW_BLUR_CLASS}`)) setBlurred(el, false);
  card.classList.remove(SAFE_CARD_CLASS);

  // The path haystack is the file's LOGICAL address, root included — the same
  // string browser.ts builds and the same one the backend matches, so a file is
  // never hidden in one surface and plain in another.
  if (!isSensitive({ name: addr.name, path: `${addr.type}/${addr.subfolder}` }, cfg)) return;

  card.classList.add(SAFE_CARD_CLASS);
  for (const el of card.querySelectorAll("img, video")) setBlurred(el, true);
  if (!cfg.blurNames) return;
  for (const el of card.querySelectorAll("*")) {
    // Deepest match only: an ancestor whose whole text happens to be the
    // filename would otherwise be blocked out too, taking the stars row with it.
    if (el.textContent?.trim() === addr.name && !el.querySelector("*")) setSpoilered(el, true);
  }
}

export function installSidebarStars(): () => void {
  // Start from disk on every install. The batch-read cache has no invalidation
  // channel — rating the same file from the Image Browser modal writes the XMP
  // without telling this module — so a long session can hold a stale star row.
  // Toggling the setting off and on is therefore the documented refresh, and a
  // page reload is always correct. Cheap to re-read (the backend caches by
  // path+mtime+size), so nothing is lost by dropping it here. The LIGHTBOX
  // injector does not share this staleness: it re-reads its one address on
  // every navigation, and writes land in this same shared cache.
  clearRatingState();

  ensureStyleOnce(
    STYLE_ID,
    `
.${ROW_CLASS} { display: flex; gap: 1px; justify-content: center; padding: 2px 0 0; }
.${ROW_CLASS} button {
  background: none; border: 0; padding: 0 1px; cursor: pointer; line-height: 1;
  /* Big enough to hit on a phone without stretching the stock card's row. */
  font-size: 13px; min-width: 16px; color: #55555f;
}
.${ROW_CLASS} button.is-on { color: #ffb02e; }
.${ROW_CLASS} button:hover { color: #ffc95e; }
/* The stock card sets draggable=true; a drag started on a star must not
   detach the card, and the row must never become a drag handle. */
.${ROW_CLASS} { -webkit-user-drag: none; user-select: none; touch-action: manipulation; }
`,
  );

  let timer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  // One delegated listener on document, not one per row: rows are created and
  // destroyed constantly by the virtualizer, and per-row listeners would leak
  // with the nodes the framework recycles out from under us.
  const onClick = (e: Event) => {
    const target = e.target as Element | null;
    const star = target?.closest?.(`.${ROW_CLASS} [data-val]`) as HTMLElement | null;
    if (!star) return;
    const row = star.closest(`.${ROW_CLASS}`) as HTMLElement | null;
    const card = row ? cardRootOf(row) : null;
    const img = card?.querySelector("img");
    const addr = parseAssetAddress(img?.getAttribute("src"));
    if (!row || !addr) return;
    // Claim the event before the card's own select/zoom handlers see it.
    e.preventDefault();
    e.stopPropagation();
    const prev = Number(row.dataset.rating || "0");
    const next = nextRating(prev, Number(star.dataset.val));
    // Optimistic paint, reverted if the write fails — a star that does not
    // light until a round-trip completes feels broken on a slow LAN.
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
  // Capture phase: the stock card stops propagation on its own root, so a
  // bubble-phase listener on document would never see the click.
  document.addEventListener("click", onClick, true);

  function paint(): void {
    const pending: RatingAddress[] = [];
    // ONE read per pass, handed to every card — the kit's contract, and it
    // matters more here than in the modal: this pass runs on every scroll
    // frame's settle over every card on screen.
    const safeCfg = readSafeViewConfig();
    // Scoped to media-asset CARDS rather than every <img> on the page.
    // /api/view is also how a PreviewImage node renders its output on the
    // canvas and how the lightbox shows a full-size image, so an unscoped
    // query would walk all of those every pass.
    //
    // This is a cost/clarity choice, NOT the correctness guard: the
    // `cardRootOf(img)` check below already rejects a non-card image, and it
    // is what actually keeps stars off the canvas (verified — the scoping test
    // below still passes with this selector widened back to "img"). Keep both;
    // just don't mistake this line for the thing holding the invariant.
    for (const img of document.querySelectorAll(`${CARD_SELECTOR} img`)) {
      const addr = parseAssetAddress(img.getAttribute("src"));
      if (!addr) continue;
      const card = cardRootOf(img);
      if (!card) continue;
      // Before the star bookkeeping, and unconditionally — a card that is NOT
      // sensitive still has to be cleared, because the virtualizer may have
      // just handed this node a different file (see applyCardSafeView).
      applyCardSafeView(card, addr, safeCfg);
      const key = addressKey(addr);
      const known = ratingCache.get(key);

      // Re-derive rather than trusting the node: the virtualizer may have
      // handed this element a different file since the last pass, in which
      // case the existing row is showing the WRONG file's rating.
      //
      // The window this closes is TRANSIENT, and that is the whole point. The
      // steady state self-corrects — the applyStars() below repaints the row
      // once the batch read lands, guard or no guard. But between the src
      // swap and that response, a kept row keeps painting the PREVIOUS file's
      // stars over the new image: a confident, wrong, clickable rating. Tearing
      // it down means the worst case is a neutral 0 for a few hundred ms.
      let row = card.querySelector(`.${ROW_CLASS}`) as HTMLElement | null;
      if (row && card.getAttribute(DONE_ATTR) !== key) {
        row.remove();
        row = null;
      }
      if (!row) {
        const holder = document.createElement("div");
        holder.innerHTML = starsHTML("ibs", known ?? 0);
        row = holder.firstElementChild as HTMLElement | null;
        if (!row) continue;
        row.classList.add(ROW_CLASS);
        row.setAttribute("draggable", "false");
        card.appendChild(row);
        card.setAttribute(DONE_ATTR, key);
      }
      if (known === undefined) {
        if (!requested.has(key) && pending.length < MAX_BATCH) {
          requested.add(key);
          pending.push(addr);
        }
      } else {
        applyStars(row, known);
      }
    }
    if (!pending.length) return;
    void fetchRatings(pending)
      .then((ratings) => {
        pending.forEach((addr, i) => {
          const r = ratings[i];
          // null means "could not read" — distinct from 0 ("unrated"). Leave
          // it out of the cache so a later pass retries instead of painting a
          // confident zero over a file we never actually read.
          if (typeof r === "number") ratingCache.set(addressKey(addr), r);
          else requested.delete(addressKey(addr));
        });
        if (!disposed) schedule();
      })
      .catch((err) => {
        for (const a of pending) requested.delete(addressKey(a));
        console.warn(`[${EXT_NAME}] sidebar rating read failed`, err);
      });
  }

  function schedule(): void {
    if (disposed) return;
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      // Fail soft: a rotted selector renders nothing rather than throwing into
      // the framework's mutation callback, which would be its problem, not ours.
      try {
        paint();
      } catch (err) {
        console.warn(`[${EXT_NAME}] sidebar star pass failed`, err);
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
  // A Safe View change repaints nothing here on its own: this module only acts
  // when the DOM mutates, and flipping a setting mutates nothing. Without this
  // the sidebar would keep the old blur until the next scroll — i.e. switching
  // the filter ON would appear not to work on whatever is already on screen,
  // which is the worst possible moment for it to look broken.
  const disposeSafeView = onSafeViewChange(schedule);
  schedule();

  return () => {
    disposed = true;
    if (timer !== null) clearTimeout(timer);
    observer.disconnect();
    disposeSafeView();
    document.removeEventListener("click", onClick, true);
    for (const row of document.querySelectorAll(`.${ROW_CLASS}`)) row.remove();
    for (const card of document.querySelectorAll(`[${DONE_ATTR}]`)) card.removeAttribute(DONE_ATTR);
    // Switching the injector off must leave the stock cards exactly as found —
    // a left-behind blur would look like a broken frontend, with no control
    // anywhere to clear it.
    for (const el of document.querySelectorAll(`.${SAFE_VIEW_SPOILER_CLASS}`)) {
      setSpoilered(el, false);
    }
    for (const el of document.querySelectorAll(`.${SAFE_VIEW_BLUR_CLASS}`)) setBlurred(el, false);
    for (const el of document.querySelectorAll(`.${SAFE_CARD_CLASS}`)) {
      el.classList.remove(SAFE_CARD_CLASS);
    }
  };
}
