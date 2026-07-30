// Harness self-check.
//
// Nothing here asserts anything interesting about the scroll bug — that is the
// next step's job. These are the trivially-true facts that must hold before any
// measurement taken through this harness can be believed:
//
//   1. the page is running the SERVED bundle (web/dist/index.js at its real
//      ComfyUI URL), not the TypeScript source;
//   2. the stubbed endpoints are actually being consumed (card counts follow the
//      fixture tree, thumbnails decode as images);
//   3. `.cmp-body` — not `.ib-grid` — is the element that scrolls;
//   4. a real layout engine is present, i.e. `scrollTop` CLAMPS. This is the one
//      property that makes the browser suite worth having: the jsdom suite
//      accepts `scrollTop = 500` on a zero-height scroller and reads back 500.
//
// If any of these fail, the browser suite is measuring the harness.

import { expect, test } from "@playwright/test";
import {
  DIALOG,
  DIR_CARD,
  enterFolder,
  FILE_CARD,
  GRID,
  openBrowser,
  SCROLLER,
  scrollMetrics,
  scrollToAndReadBack,
  UP_CARD,
  waitForFileCards,
} from "./harness.js";
import { folderSpec } from "./server.mjs";

const ROOT_FILES = folderSpec("").fileCount;
const ROOT_DIRS = folderSpec("").dirs.length;
const BULK = "bulk-400";
const BULK_FILES = folderSpec(BULK).fileCount;

// Reported through stdout rather than swallowed by a passing assertion: the
// point of this file is the NUMBERS, and a green check with no numbers is how a
// vacuous test looks from the outside.
function report(label, value) {
  process.stdout.write(`[harness] ${label}: ${JSON.stringify(value)}\n`);
}

test("the fixture serves the built bundle at its real ComfyUI URL", async ({ page }) => {
  const seen = [];
  page.on("response", (r) => {
    const u = new URL(r.url());
    if (u.pathname.startsWith("/extensions/") || u.pathname === "/scripts/app.js") {
      seen.push({ path: u.pathname, status: r.status() });
    }
  });

  await openBrowser(page);

  expect(seen).toEqual(
    expect.arrayContaining([
      { path: "/extensions/comfyui-image-browser/index.js", status: 200 },
      { path: "/scripts/app.js", status: 200 },
    ]),
  );
  report("bundle + app-stub responses", seen);
});

test("the modal renders the stubbed listing at a phone viewport", async ({ page }) => {
  await openBrowser(page);
  await waitForFileCards(page, ROOT_FILES);

  // Full-bleed dialog: the browser stands in for the canvas while open. The box
  // measures 2px WIDER than the 390px viewport, and that is correct — `.ib-dialog`
  // is sized `100vw/100vh` while the shell's `.cmp-dialog` adds a 1px border
  // outside that box. Pinned to the top-left (the pack overrides the shell's
  // 50%/-50% centering), so "covers the viewport" is x<=0 && y<=0 && >= viewport.
  const box = await page.locator(DIALOG).boundingBox();
  const view = page.viewportSize();
  expect(box.x).toBeLessThanOrEqual(0);
  expect(box.y).toBeLessThanOrEqual(0);
  expect(box.width).toBeGreaterThanOrEqual(view.width);
  expect(box.height).toBeGreaterThanOrEqual(view.height);

  await expect(page.locator(DIR_CARD)).toHaveCount(ROOT_DIRS);
  // At a root there is nowhere to ascend to, so no ".." card.
  await expect(page.locator(UP_CARD)).toHaveCount(0);

  // Thumbnails are real decoded PNGs, not broken images: a broken <img> lays out
  // differently, which would silently change every later scroll measurement.
  const firstThumb = page.locator(`${FILE_CARD} .ib-thumb img`).first();
  await expect(firstThumb).toHaveJSProperty("naturalWidth", 64);

  report("dialog box vs viewport", { box, viewport: view });
  report("root cards", { files: ROOT_FILES, dirs: ROOT_DIRS });
});

test(".cmp-body is the scroller and .ib-grid has no overflow clip", async ({ page }) => {
  await openBrowser(page);
  await waitForFileCards(page, ROOT_FILES);

  const metrics = await scrollMetrics(page);
  const gridOverflow = await page.locator(GRID).evaluate((el) => getComputedStyle(el).overflowY);

  // The invariant the lazy-thumb IntersectionObserver root depends on: the grid
  // is unclipped, so it can never be the scrolling ancestor.
  expect(gridOverflow).toBe("visible");
  expect(["auto", "scroll"]).toContain(metrics.overflowY);
  expect(metrics.scrollHeight).toBeGreaterThan(metrics.clientHeight);
  expect(metrics.maxScrollTop).toBeGreaterThan(0);

  // Sanity: the grid is taller than the scroller's viewport, i.e. the cards —
  // not some stray sibling — are what makes the page scroll.
  const gridHeight = await page.locator(GRID).evaluate((el) => el.getBoundingClientRect().height);
  expect(gridHeight).toBeGreaterThan(metrics.clientHeight);

  report("root scroller", { ...metrics, gridOverflow, gridHeight });
});

test("a bulk folder scrolls deeply and scrollTop clamps like a real engine", async ({ page }) => {
  await openBrowser(page);
  await waitForFileCards(page, ROOT_FILES);

  await enterFolder(page, BULK, BULK_FILES);
  await expect(page.locator(UP_CARD)).toHaveCount(1);

  const before = await scrollMetrics(page);
  expect(before.scrollTop).toBe(0);
  // "Hundreds of files" has to mean a scroller many viewports tall, or a scroll
  // test cannot tell a restored offset from the top of the list.
  expect(before.maxScrollTop).toBeGreaterThan(before.clientHeight * 10);

  // In range: kept verbatim.
  const inRange = await scrollToAndReadBack(page, 4000);
  expect(inRange.immediate).toBe(4000);

  // Out of range: silently clamped. THIS is what jsdom cannot reproduce — the
  // jsdom suite reads back whatever it was handed, which is why its
  // scroll-restore test proves the Map bookkeeping and nothing about the engine.
  const clamped = await scrollToAndReadBack(page, before.maxScrollTop + 100_000);
  expect(clamped.immediate).toBe(clamped.maxScrollTop);
  expect(clamped.immediate).toBeLessThan(clamped.requested);

  report("bulk folder", { folder: BULK, files: BULK_FILES, ...before });
  report("scrollTop in range", inRange);
  report("scrollTop clamped", clamped);
});

test("subfolders are navigable for a per-directory scroll test", async ({ page }) => {
  await openBrowser(page);
  await waitForFileCards(page, ROOT_FILES);

  // nested → deep → bulk-120: three levels, each with its own listing, which is
  // what a per-directory scroll-memory test needs to traverse.
  await enterFolder(page, "nested", folderSpec("nested").fileCount);
  await enterFolder(page, "deep", folderSpec("nested/deep").fileCount);
  await enterFolder(page, "bulk-120", folderSpec("nested/deep/bulk-120").fileCount);

  const crumbs = await page.locator(".ib-crumb").allTextContents();
  report("breadcrumbs at nested/deep/bulk-120", crumbs);
  expect(crumbs.join("/")).toContain("nested");

  // Back up two levels via the ".." card — the path the scroll-restore behaviour
  // actually runs on (rememberScroll → navigateUp → loadAndRender).
  await page.locator(UP_CARD).click();
  await waitForFileCards(page, folderSpec("nested/deep").fileCount);
  await page.locator(UP_CARD).click();
  await waitForFileCards(page, folderSpec("nested").fileCount);

  const metrics = await scrollMetrics(page);
  expect(await page.locator(SCROLLER).count()).toBe(1);
  report("after two ascents", metrics);
});
