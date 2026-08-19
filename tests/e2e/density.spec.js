// The grid density scale, in real Chromium at a phone viewport.
//
// tests/js/density.test.js asserts what each step DECLARES — the track, which
// parts of a card are display:none, where a list-mode child is placed. It
// cannot assert any of the following, because jsdom performs no layout:
//
//   * that four columns actually appear at 390px. The arithmetic
//     (4x84 + 3x6 = 354 <= 382) is asserted there; whether the engine agrees
//     depends on the real content box, the scrollbar, and the dialog border.
//   * how many whole cards each step actually puts on screen. Every input to
//     that — the card box, the toolbar's wrapped height, the scroller's band —
//     is a rendered value.
//   * that j/k still step by a ROW once the column count changes. gridColumns()
//     derives it from offsetTop, which is 0 for every card in jsdom.
//
// This file is where those live. Grouping follows scroll-restore.spec.js:
//   REGRESSION — would fail against a build without the density work.
//   LOCK       — pins what the density work must not break.

import { expect, test } from "@playwright/test";
import { FILE_CARD, GRID, openBrowser, SCROLLER, waitForFileCards } from "./harness.js";
import { folderSpec } from "./server.mjs";

const ROOT_FILES = folderSpec("").fileCount;
const DENSITY = (d) => `.ib-density-seg[data-density="${d}"]`;

/** Switch density and wait for the grid to carry it. */
async function setDensity(page, d) {
  await page.locator(DENSITY(d)).click();
  await expect(page.locator(GRID)).toHaveAttribute("data-density", d);
}

/**
 * How many file cards share the WIDEST rendered row.
 *
 * Not the topmost row: DIRECTORY cards render before file cards, so the first
 * row of file cards is partial whenever the folder has subfolders. Measured in
 * this fixture, whose three directory cards leave exactly ONE file in the first
 * file row of a two-column grid — reading that row reports "1 column" for a
 * grid that plainly has two. (The same mistake is what made gridColumns()
 * return 1 in the shipped code; see the j/k test below.)
 *
 * Measured from `getBoundingClientRect().top` rather than derived from the
 * track, because `auto-fill` hands out whatever the real content box allows,
 * which is the thing under test.
 */
async function widestRowCount(page) {
  return page.evaluate((sel) => {
    const rows = new Map();
    for (const c of document.querySelectorAll(sel)) {
      const t = Math.round(c.getBoundingClientRect().top);
      rows.set(t, (rows.get(t) ?? 0) + 1);
    }
    return Math.max(0, ...rows.values());
  }, FILE_CARD);
}

/** File cards whose box is fully inside the visible grid band. */
async function fullyVisibleCards(page) {
  return page.evaluate(
    ({ sel, scrollSel }) => {
      const b = document.querySelector(scrollSel).getBoundingClientRect();
      return [...document.querySelectorAll(sel)].filter((c) => {
        const r = c.getBoundingClientRect();
        return r.top >= b.top && r.bottom <= b.bottom;
      }).length;
    },
    { sel: FILE_CARD, scrollSel: SCROLLER },
  );
}

/** The scroller's visible height — the band a card has to fit inside. */
async function gridBandHeight(page) {
  return page.evaluate((sel) => {
    const b = document.querySelector(sel).getBoundingClientRect();
    return b.bottom - b.top;
  }, SCROLLER);
}

async function firstCardHeight(page) {
  const box = await page.locator(FILE_CARD).first().boundingBox();
  return box.height;
}

test.describe("REGRESSION — the density steps at a phone viewport", () => {
  test("dense actually renders four columns at 390px", async ({ page }) => {
    await openBrowser(page);
    await waitForFileCards(page, ROOT_FILES);
    await setDensity(page, "dense");
    // The claim the 84px/6px pair was computed for. Asserted as an equality,
    // not ">= 3": a track that silently allowed five would put ~68px cards on
    // screen, which is the failure in the other direction.
    expect(await widestRowCount(page)).toBe(4);
  });

  test("the default step renders two columns, unchanged", async ({ page }) => {
    await openBrowser(page);
    await waitForFileCards(page, ROOT_FILES);
    expect(await page.locator(GRID).getAttribute("data-density")).toBe("grid");
    expect(await widestRowCount(page)).toBe(2);
  });

  test("dense puts several times more whole cards on screen", async ({ page }) => {
    // THE MEASUREMENT THE SLICE EXISTS FOR, and it is NOT the one this test
    // originally asserted. An earlier reading claimed a card (~313px) was
    // taller than the visible grid band, so no card was ever fully on screen.
    // That was wrong: the band is ~411px and a default card DOES fit. The 264px
    // figure came from subtracting the first FILE card's y — which sits below a
    // full row of directory cards — from the viewport height, rather than
    // measuring the scroller. The real gain is horizontal and vertical at once:
    // 2 columns of 313px cards versus 4 columns of ~87px ones.
    await openBrowser(page);
    await waitForFileCards(page, ROOT_FILES);

    const band = await gridBandHeight(page);
    const defaultCard = await firstCardHeight(page);
    const defaultVisible = await fullyVisibleCards(page);
    expect(defaultCard).toBeLessThan(band); // a default card does fit — barely

    await setDensity(page, "dense");
    const denseCard = await firstCardHeight(page);
    expect(denseCard).toBeLessThan(defaultCard / 2);
    // Asserted as a ratio rather than an absolute count, so a future toolbar
    // row shifts both sides and the test keeps meaning "dense shows far more".
    expect(await fullyVisibleCards(page)).toBeGreaterThanOrEqual(defaultVisible * 3);
  });

  test("list renders one item per row with the thumb beside the details", async ({ page }) => {
    await openBrowser(page);
    await waitForFileCards(page, ROOT_FILES);
    await setDensity(page, "list");
    expect(await widestRowCount(page)).toBe(1);

    // One ITEM, not one image: the row must be far wider than it is tall, and
    // the thumb must be a 64px column rather than the full width. A card that
    // merely went single-column would be a ~390px square and pass a naive
    // "one per row" check.
    const card = await page.locator(FILE_CARD).first().boundingBox();
    expect(card.width).toBeGreaterThan(card.height);
    const thumb = await page.locator(`${FILE_CARD} .ib-thumb`).first().boundingBox();
    expect(thumb.width).toBeLessThanOrEqual(72);
  });

  test("the preference survives a reopen", async ({ page }) => {
    await openBrowser(page);
    await waitForFileCards(page, ROOT_FILES);
    await setDensity(page, "dense");
    await page.keyboard.press("Escape");
    await expect(page.locator(GRID)).toHaveCount(0);
    await page.evaluate(() => window.__IB_E2E__.open());
    await expect(page.locator(GRID)).toHaveAttribute("data-density", "dense");
  });
});

test.describe("LOCK — what the density scale must not break", () => {
  test("a vertical swipe starting ON a dense checkbox still scrolls the grid", async ({ page }) => {
    // .ib-check is touch-action:none so a drag from it sweeps a range. At 44px
    // on an ~84px tile that is half the card width, so without the pan-y
    // override a large fraction of the dense grid would be unscrollable. No
    // other tier can see this: jsdom has no scrolling and no touch-action.
    await openBrowser(page);
    await waitForFileCards(page, ROOT_FILES);
    await setDensity(page, "dense");

    const before = await page.evaluate((s) => document.querySelector(s).scrollTop, SCROLLER);
    const check = await page.locator(`${FILE_CARD} .ib-check`).first().boundingBox();
    const x = check.x + check.width / 2;
    const y = check.y + check.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.wheel(0, 400);
    await expect
      .poll(() => page.evaluate((s) => document.querySelector(s).scrollTop, SCROLLER))
      .toBeGreaterThan(before);
  });

  test("a drag across dense checkboxes still sweeps a range", async ({ page }) => {
    // The other half of the pan-y change: giving the browser the vertical axis
    // must not cost the horizontal sweep, which is the natural direction across
    // a grid row.
    await openBrowser(page);
    await waitForFileCards(page, ROOT_FILES);
    await setDensity(page, "dense");

    const cards = page.locator(FILE_CARD);
    const from = await cards.nth(0).locator(".ib-check").boundingBox();
    const to = await cards.nth(1).boundingBox();
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(to.x + to.width / 2, from.y + from.height / 2, { steps: 8 });
    await page.mouse.up();

    expect(await page.locator(".ib-card.is-selected").count()).toBeGreaterThanOrEqual(2);
  });

  test("j/k still step by a ROW after the column count changes", async ({ page }) => {
    // gridColumns() derives the count from offsetTop, so it adapts for free —
    // but "for free" is a claim about a real layout, and jsdom reports 0 for
    // every offsetTop. At dense a `j` must move four cards along, not two.
    await openBrowser(page);
    await waitForFileCards(page, ROOT_FILES);
    await setDensity(page, "dense");

    const indexOfFocused = () =>
      page.evaluate(() => {
        const cards = [...document.querySelectorAll(".ib-card.is-file")];
        return cards.findIndex((c) => c.classList.contains("is-focused"));
      });

    await page.locator(GRID).click({ position: { x: 5, y: 5 } });
    const start = await indexOfFocused();
    await page.keyboard.press("j");
    const after = await indexOfFocused();
    expect(after - start).toBe(4);
  });

  test("the type filter still works while a density is set", async ({ page }) => {
    // The two pills share one toolbar row; adding the second must not have
    // captured the first's clicks.
    await openBrowser(page);
    await waitForFileCards(page, ROOT_FILES);
    await setDensity(page, "dense");
    await page.locator('.ib-filter-seg[data-filter="images"]').click();
    await expect(page.locator('.ib-filter-seg[data-filter="images"]')).toHaveClass(/is-active/);
    await expect(page.locator(GRID)).toHaveAttribute("data-density", "dense");
  });
});
