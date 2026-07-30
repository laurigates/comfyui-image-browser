// Shared drivers for the Playwright (browser) suite.
//
// Everything here is about ONE thing the jsdom suite structurally cannot do:
// jsdom performs no layout, so `scrollTop = N` is stored verbatim and read back
// verbatim. A real engine CLAMPS the assignment to `scrollHeight - clientHeight`
// at the instant of assignment. Helpers therefore never report a scroll offset
// on its own — they report it next to the clamp bound that produced it, because
// "the offset is 0" and "the offset was clamped to 0" are different bugs.

import { expect } from "@playwright/test";

// The scrolling ancestor is the modal shell's body, NOT `.ib-grid` (which has
// no overflow clip). This is the same invariant the lazy-thumb observer root
// depends on — see the hard rule in CLAUDE.md.
export const SCROLLER = ".cmp-body";
export const GRID = ".ib-grid";
export const DIALOG = ".ib-dialog";
export const FILE_CARD = ".ib-card.is-file";
export const DIR_CARD = ".ib-card.is-dir";
export const UP_CARD = ".ib-card.is-up";

/**
 * Load the fixture and open the browser modal via the bundle's exported
 * `openShell()`.
 *
 * `storage` is applied BEFORE the modal mounts: saved view mode, sort and pins
 * are all read at open time, so seeding them afterwards would have no effect on
 * the render under test.
 */
export async function openBrowser(page, { storage } = {}) {
  await page.goto("/");
  await page.waitForFunction(() => window.__IB_E2E_READY__ === true);
  if (storage) {
    await page.evaluate((entries) => {
      for (const [k, v] of Object.entries(entries)) localStorage.setItem(k, v);
    }, storage);
  }
  await page.evaluate(() => window.__IB_E2E__.open());
  await expect(page.locator(DIALOG)).toBeVisible();
  await page.locator(GRID).waitFor();
}

/** Wait until the grid has settled on `count` file cards. */
export async function waitForFileCards(page, count) {
  await expect(page.locator(FILE_CARD)).toHaveCount(count, { timeout: 20_000 });
}

/** Tap a folder card and wait for the new listing to paint. */
export async function enterFolder(page, name, expectedFileCount) {
  await page.locator(`${DIR_CARD}[data-name="${name}"]`).click();
  await waitForFileCards(page, expectedFileCount);
}

/**
 * One snapshot of the scroller's geometry.
 *
 * `maxScrollTop` is the clamp bound: any assignment above it silently becomes
 * it. Reporting the pair is the whole point — a restore that "failed" because
 * the content had not grown tall enough yet is a different defect from a
 * restore that was overwritten after the fact.
 */
export async function scrollMetrics(page) {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    return {
      scrollTop: el.scrollTop,
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
      maxScrollTop: Math.max(0, el.scrollHeight - el.clientHeight),
      overflowY: getComputedStyle(el).overflowY,
    };
  }, SCROLLER);
}

/**
 * Assign `scrollTop` and report what the engine actually kept, in the SAME task
 * as the assignment — so the number is the clamp result, uncontaminated by any
 * later scroll-anchoring adjustment or thumbnail-driven reflow.
 */
export async function scrollToAndReadBack(page, target) {
  return page.evaluate(
    ({ sel, target }) => {
      const el = document.querySelector(sel);
      el.scrollTop = target;
      return {
        requested: target,
        immediate: el.scrollTop,
        maxScrollTop: Math.max(0, el.scrollHeight - el.clientHeight),
      };
    },
    { sel: SCROLLER, target },
  );
}
