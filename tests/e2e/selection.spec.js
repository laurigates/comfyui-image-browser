// REGRESSION — a TAP on a card's selection checkbox selects the card.
//
// This file exists because the jsdom suite structurally cannot fail for this
// bug, and the test that is named for the interaction (tests/js/index.test.js,
// "selection checkbox") passed against it for the whole time it was broken:
//
//   * `HTMLElement.click()` dispatches a bare MouseEvent. It produces no
//     pointerdown/pointerup, so the pointer path under test never runs.
//   * jsdom implements no `Element.prototype.setPointerCapture` at all, so the
//     call that CAUSED the bug threw into its own `catch` on every jsdom run.
//
// The bug: `pointerdown` on `[data-check]` took pointer capture on `gridEl`.
// Pointer Events L3 §4.2.12.3 delivers a `click` whose `pointerup` was
// dispatched under capture to the CAPTURING element, not to the common
// ancestor of the down/up targets — and the spec note says this holds even
// after `lostpointercapture` has fired, so releasing capture in `pointerup`
// (which is what the code did) is too late by construction. Every tap's click
// therefore arrived with `target === gridEl`, where the grid handler's
// `target.closest(".ib-card")` is null and it returns immediately — dozens of
// lines above the `[data-check]` branch meant to toggle.
//
// The symptom users reported was "selection needs a drag". It was not that
// selection was dead: `pointermove` has no distance threshold, so the first
// move sample sweeps a one-card range directly and selects. A tap that jitters
// works; a clean tap does nothing. That intermittency is why it read as a
// touch quirk rather than a broken code path — and it is why the assertions
// below drive down/up with NO movement in between.
//
// Grouping follows scroll-restore.spec.js:
//   REGRESSION — fails against the pre-fix bundle. These are the defect.
//   LOCK       — passes before and after; pins what the fix must not break.

import { expect, test } from "@playwright/test";
import { DIALOG, FILE_CARD, openBrowser, SCROLLER, waitForFileCards } from "./harness.js";
import { folderSpec } from "./server.mjs";

const ROOT_FILES = folderSpec("").fileCount;
const CHECK = ".ib-check";
const SELECTED = ".ib-card.is-selected";
// The floating batch bar the selection raises. Its presence is the second,
// independent witness that selection state actually changed — `is-selected` is
// a class the render loop could in principle paint for another reason.
const SELBAR = ".ib-selbar";

/**
 * Press and release on the centre of `locator` with NO pointer movement.
 *
 * `locator.click()` is not usable here: Playwright's click performs its own
 * small pointer motion, which is exactly the jitter that made the broken build
 * appear to work. The whole point of this driver is the absence of a
 * `pointermove` between down and up.
 */
async function tapWithoutMoving(page, locator) {
  const box = await locator.boundingBox();
  expect(box, "checkbox must be laid out and hit-testable").not.toBeNull();
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.up();
}

/** The first file card, and its checkbox. */
function firstCard(page) {
  const card = page.locator(FILE_CARD).first();
  return { card, check: card.locator(CHECK) };
}

/**
 * The rectangle a pointer can actually reach a card in: the SCROLLER's box, not
 * the viewport's.
 *
 * The two differ by the toolbar, which is sticky and paints over the grid. A
 * card can report a perfectly good `boundingBox()` and still be untappable
 * because the header is on top of it — `boundingBox()` knows nothing about
 * occlusion. Measured here rather than assumed: the toolbar is 3-5 rows
 * depending on pins, filter and tab, so its height is not a constant.
 */
async function reachableRect(page) {
  const r = await page.evaluate((sel) => {
    const b = document.querySelector(sel).getBoundingClientRect();
    return { top: b.top, bottom: b.bottom, left: b.left, right: b.right };
  }, SCROLLER);
  expect(r.bottom - r.top, "scroller has no usable height").toBeGreaterThan(100);
  return r;
}

/**
 * A card's box, asserted to be fully inside the reachable rect.
 *
 * This guard is not defensive padding — it caught two separate harness bugs.
 * (1) The toolbar occupies ~580px of the 844px viewport unscrolled, so
 * `FILE_CARD.nth(2)` lands at y≈902, below the fold; a drag toward it walks off
 * the viewport, where `elementFromPoint` answers null and the sweep stops at one
 * card — indistinguishable from the sweep being broken. (2) After scrolling, a
 * card can sit *under* the sticky toolbar and receive no pointer events at all,
 * while still reporting a plausible box. Both produced a green-looking harness
 * measuring nothing.
 */
async function visibleBox(page, locator, what, rect, needed) {
  const box = await locator.boundingBox();
  expect(box, `${what} must be laid out`).not.toBeNull();
  const reach = needed ?? box.height;
  expect(box.y, `${what} is under the sticky toolbar`).toBeGreaterThanOrEqual(rect.top);
  expect(box.y + reach, `${what} is below the fold`).toBeLessThanOrEqual(rect.bottom);
  expect(box.x + box.width, `${what} right edge is off-screen`).toBeLessThanOrEqual(rect.right);
  return box;
}

/** Height of the strip at a card's top that a drag needs to be able to reach. */
const CARD_BAND = 80;

/**
 * Scroll the grid, then return two file cards that share a row and both expose
 * a reachable band.
 *
 * NOT "fully inside the reachable rect" — at this viewport no card ever is. A
 * card is ~313px tall while the toolbar leaves the grid ~264px of height, so a
 * single card is TALLER than the whole visible grid band. (That is not a
 * harness quirk; it is the default-density mobile layout, and it is why the
 * first attempt at this helper matched nothing.) The band is what a pointer can
 * actually aim at.
 *
 * Neither half can be assumed. The root listing renders DIRECTORY cards before
 * file cards, so `FILE_CARD.nth(0)` and `.nth(1)` are not a row — at this
 * viewport nth(0) sits in the second column of one row and nth(1) in the first
 * column of the next. All of it is layout, so all of it is measured.
 */
async function inViewRowPair(page) {
  await page.evaluate((sel) => {
    document.querySelector(sel).scrollTop = 700;
  }, SCROLLER);
  const rect = await reachableRect(page);
  const pair = await page.evaluate(
    ({ cardSel, rect, band }) => {
      const cards = [...document.querySelectorAll(cardSel)];
      for (let i = 0; i + 1 < cards.length; i++) {
        const a = cards[i].getBoundingClientRect();
        const b = cards[i + 1].getBoundingClientRect();
        if (Math.abs(a.top - b.top) > 2) continue; // not the same row
        if (a.top < rect.top || b.top < rect.top) continue; // under the toolbar
        if (a.top + band > rect.bottom || b.top + band > rect.bottom) continue; // no band left
        return [i, i + 1];
      }
      return null;
    },
    { cardSel: FILE_CARD, rect, band: CARD_BAND },
  );
  expect(pair, "no two file cards share a fully-reachable row").not.toBeNull();
  return {
    rect,
    left: page.locator(FILE_CARD).nth(pair[0]),
    right: page.locator(FILE_CARD).nth(pair[1]),
  };
}

test.describe("REGRESSION — checkbox tap", () => {
  test("a tap with no pointer movement selects the card", async ({ page }) => {
    await openBrowser(page);
    await waitForFileCards(page, ROOT_FILES);
    const { card, check } = firstCard(page);

    // The checkbox is `display: flex` at a coarse pointer without entering
    // select mode first (@media (pointer: coarse)), which is the state a phone
    // is in. Assert that rather than assume it — if it were hidden, the tap
    // below would be measuring the wrong thing.
    await expect(check).toBeVisible();

    await tapWithoutMoving(page, check);

    await expect(card).toHaveClass(/is-selected/);
    await expect(page.locator(SELBAR)).toBeVisible();
  });

  test("a second tap on the same checkbox deselects", async ({ page }) => {
    await openBrowser(page);
    await waitForFileCards(page, ROOT_FILES);
    const { card, check } = firstCard(page);

    await tapWithoutMoving(page, check);
    await expect(card).toHaveClass(/is-selected/);

    await tapWithoutMoving(page, check);
    await expect(card).not.toHaveClass(/is-selected/);
  });

  test("a tap on the checkbox does NOT open the file", async ({ page, context }) => {
    await openBrowser(page);
    await waitForFileCards(page, ROOT_FILES);
    const { check } = firstCard(page);

    // `openFull` is the fall-through the broken build reached whenever a tap
    // missed the checkbox and landed on the card — and it is the reason a
    // near-miss on an undersized hit box is not inert. It is
    // `window.open(url, "_blank")`, so the witness is a new PAGE in this
    // context, not an in-dialog overlay.
    const before = context.pages().length;
    await tapWithoutMoving(page, check);
    await expect(page.locator(SELBAR)).toBeVisible();

    expect(context.pages().length).toBe(before);
    await expect(page.locator(DIALOG)).toBeVisible();
  });

  test("the checkbox meets the family's 44px touch floor in both axes", async ({ page }) => {
    await openBrowser(page);
    await waitForFileCards(page, ROOT_FILES);
    const { check } = firstCard(page);

    // RENDERED, not declared. The jsdom suite can assert the stylesheet says
    // 44px; only an engine can say the box is 44px after the card's flex
    // layout, `overflow: hidden` clip and the ::before dot have had their say.
    const box = await check.boundingBox();
    expect(box.width).toBeGreaterThanOrEqual(44);
    expect(box.height).toBeGreaterThanOrEqual(44);
  });

  test("a drag that ends outside the grid still releases capture", async ({ page }) => {
    await openBrowser(page);
    await waitForFileCards(page, ROOT_FILES);
    const { rect, left, right } = await inViewRowPair(page);
    const from = await visibleBox(page, left.locator(CHECK), "source checkbox", rect);

    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(from.x + from.width / 2, 2, { steps: 8 }); // up into the header
    await page.mouse.up();

    // If capture were still held by the checkbox, every later click would
    // retarget to it — the original bug relocated rather than fixed. A tap on a
    // DIFFERENT card's checkbox proves the pointer is free.
    //
    // This lives under REGRESSION, not LOCK, and the placement is measured: the
    // only way to observe a leaked capture is a subsequent TAP, which is the
    // very thing the pre-fix bundle cannot do. It therefore fails pre-fix for
    // two reasons at once. It is kept because the release path it covers is
    // new — capture is now taken on the checkbox, so it is the checkbox that
    // must give it back.
    await tapWithoutMoving(page, right.locator(CHECK));
    await expect(right).toHaveClass(/is-selected/);
  });
});

test.describe("LOCK — what the capture change must not break", () => {
  test("a drag across checkboxes still sweeps a range", async ({ page }) => {
    await openBrowser(page);
    await waitForFileCards(page, ROOT_FILES);

    // Capture moved from `gridEl` to the checkbox itself. Captured events still
    // BUBBLE to the grid, so the grid's `pointermove` listener — which is what
    // sweeps — must still see them. A drag that leaves the originating card is
    // the case that proves it: without bubbling the sweep would stop at one.
    //
    // The pair is the FIRST ROW (two columns at this viewport), not nth(0) and
    // nth(2): see visibleBox() — the second row is below the fold.
    const { rect, left, right } = await inViewRowPair(page);
    const from = await visibleBox(page, left.locator(CHECK), "source checkbox", rect);
    const to = await visibleBox(page, right, "target card", rect, CARD_BAND);

    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await page.mouse.down();
    // Several samples: the sweep covers the span between consecutive
    // pointermove events, so one giant jump would exercise a different branch
    // than a finger does.
    await page.mouse.move(to.x + to.width / 2, to.y + CARD_BAND / 2, { steps: 8 });
    await page.mouse.up();

    await expect(left).toHaveClass(/is-selected/);
    await expect(right).toHaveClass(/is-selected/);
  });

  test("a tap on the card body still opens the file", async ({ page }) => {
    await openBrowser(page);
    await waitForFileCards(page, ROOT_FILES);
    const card = page.locator(FILE_CARD).first();

    // Clear of the 44px hit box in the top-left corner, and clear of the action
    // row at the card's foot — the card is ~313px tall and only its top ~264px
    // are above the fold, so "bottom-right of the card" is off-screen. Tap the
    // thumbnail's right side instead. `openFull` is
    // `window.open(url, "_blank")`, so the file opening IS a new page here.
    const box = await card.boundingBox();
    const popup = page.waitForEvent("popup");
    await page.mouse.move(box.x + box.width - 16, box.y + 120);
    await page.mouse.down();
    await page.mouse.up();

    await popup;
    await expect(page.locator(SELECTED)).toHaveCount(0);
  });

  test("a synthetic click with no pointer sequence still selects", async ({ page }) => {
    await openBrowser(page);
    await waitForFileCards(page, ROOT_FILES);
    const { card, check } = firstCard(page);

    // THE CONTROL ARM. `HTMLElement.click()` dispatches a MouseEvent with no
    // pointerdown/pointerup, so it never touches the capture path — it passed
    // before the fix and passes after it. If this goes red alongside the
    // REGRESSION tests above, the harness is broken, not the code.
    //
    // This was originally written as a real keypress (focus + Enter), which is
    // the more faithful stand-in. It cannot be used here: under Chromium's
    // mobile emulation (`isMobile: true`), `keyboard.press("Enter")` delivers
    // NO keydown to the page at all — measured, with ArrowDown arriving
    // normally in the same run. A control arm that silently dispatches nothing
    // is worse than none, so the synthetic click is what stands here, and the
    // real keyboard path is left to a desktop-emulation suite that does not
    // exist yet.
    await check.evaluate((el) => el.click());

    await expect(card).toHaveClass(/is-selected/);
  });
});
