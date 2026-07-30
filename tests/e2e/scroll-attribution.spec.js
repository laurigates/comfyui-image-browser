// ATTRIBUTION — which of the candidate mechanisms actually moves the number.
//
// scroll-restore.spec.js is the pass/fail regression suite. This file keeps the
// per-mechanism measurements that decided WHICH mechanism to fix, as standing
// assertions — so a future change that quietly revives one of them (say, by
// dropping `aspect-ratio` off `.ib-thumb`, which is what keeps clamping and
// scroll anchoring inert) fails here with the number that explains why:
//
//   CLAMPING          — `scrollHeight`/`clientHeight` at the instant of the
//                       write, versus what was requested. `.ib-thumb` is
//                       `aspect-ratio: 1/1`, so the interesting question is
//                       whether the grid is already full height with ZERO
//                       images decoded.
//   SCROLL ANCHORING  — Chromium implements it and `overflow-anchor` is set
//                       nowhere in the pack or the kit, so the default `auto` is
//                       live. Measured by running the same navigation with
//                       `overflow-anchor: none` forced and diffing.
//   RESTORE ORDERING  — the restore must land BEFORE the lazy-thumb observer
//                       starts watching, so the observer's first pass is
//                       computed against the final viewport. Measured two ways:
//                       the registration order (a counter shared with the
//                       scrollTop-write log, since both happen inside one
//                       sub-millisecond task) and the card indices actually
//                       fetched.
//
// MOMENTUM is not represented here at all, deliberately. It is a WebKit
// behaviour (`-webkit-overflow-scrolling: touch` is inert outside WebKit) and
// only Chromium exists in this environment. A test that "covered" it would be
// covering nothing.

import { expect, test } from "@playwright/test";
import { DIR_CARD, openBrowser, waitForFileCards } from "./harness.js";
import { fetchedBand, installScrollProbe, trackThumbs, waitForThumbQuiet } from "./probe.js";
import { folderSpec } from "./server.mjs";

const ROOT_FILES = folderSpec("").fileCount;
const BULK = "bulk-400";
const BULK_FILES = folderSpec(BULK).fileCount;

function report(label, value) {
  process.stdout.write(`[attrib] ${label}: ${JSON.stringify(value)}\n`);
}

/** See the same helper in scroll-restore.spec.js — no scroll-into-view. */
async function tapWithoutScrolling(page, selector) {
  const hit = await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const host = document.querySelector(".cmp-body");
    const before = host.scrollTop;
    el.click();
    return { before, after: host.scrollTop };
  }, selector);
  expect(hit).not.toBeNull();
  expect(hit.after).toBe(hit.before);
  return hit;
}

/**
 * Descend into `bulk-400`, park at a deep offset, and come back out — leaving
 * `scrollMemory` holding that offset for the folder. Returns the remembered
 * value, which every test below then asks the code to reproduce.
 */
async function primeRememberedOffset(page, tracker, fraction = 0.5) {
  await waitForFileCards(page, ROOT_FILES);
  await tapWithoutScrolling(page, `${DIR_CARD}[data-name="${BULK}"]`);
  await waitForFileCards(page, BULK_FILES);
  await waitForThumbQuiet(page, tracker);
  const seeded = await page.evaluate((f) => {
    const el = document.querySelector(".cmp-body");
    return window.__IB_PROBE__.seed(Math.round((el.scrollHeight - el.clientHeight) * f));
  }, fraction);
  await waitForThumbQuiet(page, tracker);
  // Crumb, not the ".." card: the ".." card is off-screen at a deep offset and a
  // Playwright click would scroll to it first.
  await page.locator(".ib-crumb").first().click();
  await waitForFileCards(page, ROOT_FILES);
  await waitForThumbQuiet(page, tracker);
  return seeded.immediate;
}

test.beforeEach(async ({ page }) => {
  await installScrollProbe(page);
});

// ------------------------------------------------------- CLAMPING

test("clamping — grid height at the instant of each restore write", async ({ page }) => {
  const thumbs = trackThumbs(page);
  await openBrowser(page);
  const remembered = await primeRememberedOffset(page, thumbs);

  await page.evaluate(() => window.__IB_PROBE__.reset());
  await tapWithoutScrolling(page, `${DIR_CARD}[data-name="${BULK}"]`);
  await waitForFileCards(page, BULK_FILES);
  const writes = (await page.evaluate(() => window.__IB_PROBE__.dump())).sets;

  const restore = writes[writes.length - 1];
  report("clamping — remembered", remembered);
  report("clamping — writes on descend", writes);

  // The decisive pair: the grid is already at its full height while NO image has
  // a src yet. `aspect-ratio: 1/1` gives every card its intrinsic height before
  // a single byte of image data arrives, so the restore target is inside the
  // scroll range from the very first frame.
  expect(restore.requested).toBe(remembered);
  expect(restore.imgsLoaded).toBe(0);
  expect(restore.maxScrollTop).toBeGreaterThan(restore.requested);
  expect(restore.clamped).toBe(false);
  report("clamping — restore write", {
    requested: restore.requested,
    immediate: restore.immediate,
    scrollHeight: restore.scrollHeight,
    clientHeight: restore.clientHeight,
    maxScrollTop: restore.maxScrollTop,
    imgs: restore.imgs,
    imgsLoaded: restore.imgsLoaded,
  });

  // And the height does not move afterwards either — so there is no later
  // moment at which the same offset would have become out of range.
  await waitForThumbQuiet(page, thumbs);
  const after = await page.evaluate(() => window.__IB_PROBE__.mark("after-thumbs"));
  report("clamping — height before/after thumbnails", {
    scrollHeightAtWrite: restore.scrollHeight,
    scrollHeightAfterThumbs: after.scrollHeight,
    delta: after.scrollHeight - restore.scrollHeight,
    scrollTop: after.scrollTop,
  });
  expect(after.scrollHeight).toBe(restore.scrollHeight);
});

test("clamping — is live in this harness, and no restore write hits it", async ({ page }) => {
  const thumbs = trackThumbs(page);
  await openBrowser(page);
  await waitForFileCards(page, ROOT_FILES);
  await tapWithoutScrolling(page, `${DIR_CARD}[data-name="${BULK}"]`);
  await waitForFileCards(page, BULK_FILES);
  await waitForThumbQuiet(page, thumbs);
  const deep = await page.evaluate(() => {
    const el = document.querySelector(".cmp-body");
    return window.__IB_PROBE__.seed(Math.round((el.scrollHeight - el.clientHeight) * 0.5));
  });

  await page.evaluate(() => window.__IB_PROBE__.reset());
  await page.locator(".ib-crumb").first().click();
  await waitForFileCards(page, ROOT_FILES);
  const writes = (await page.evaluate(() => window.__IB_PROBE__.dump())).sets;

  // First, the engine really does clamp — asked through the native setter so it
  // is not confused with anything the bundle did. Without this the assertion
  // below ("no write was clamped") could pass for the wrong reason, i.e. an
  // engine that never clamps at all. jsdom is exactly that engine.
  const overshoot = await page.evaluate(() => {
    const el = document.querySelector(".cmp-body");
    const max = el.scrollHeight - el.clientHeight;
    const r = window.__IB_PROBE__.seed(max + 100000);
    window.__IB_PROBE__.seed(r.maxScrollTop);
    return r;
  });
  report("clamping — native overshoot", overshoot);
  expect(overshoot.immediate).toBe(overshoot.maxScrollTop);
  expect(overshoot.immediate).toBeLessThan(overshoot.maxScrollTop + 100000);

  // And no write the bundle made on the way up was clamped. The write that used
  // to be — renderGrid re-applying the offset it captured before
  // `innerHTML = ""`, which on a navigation belongs to the folder just LEFT and
  // does not fit the shorter parent listing (measured 31185 → 1865) — is gone:
  // loadAndRender hands the destination's own offset into the render instead.
  report("clamping — deep child offset", deep);
  report("clamping — writes going up", writes);
  expect(writes.filter((w) => w.clamped)).toHaveLength(0);
  expect(writes.filter((w) => w.requested === deep.immediate)).toHaveLength(0);
});

// ------------------------------------------------ SCROLL ANCHORING

test("scroll anchoring — default is live, and turning it off changes nothing", async ({ page }) => {
  const thumbs = trackThumbs(page);
  await openBrowser(page);

  // The precondition first: nothing in the pack or the kit sets
  // `overflow-anchor`, so Chromium's default `auto` is in force on the scroller
  // and on the grid.
  const anchorDefaults = await page.evaluate(() => {
    const s = document.querySelector(".cmp-body");
    const g = document.querySelector(".ib-grid");
    return {
      scroller: getComputedStyle(s).overflowAnchor,
      grid: getComputedStyle(g).overflowAnchor,
    };
  });
  report("anchoring — computed overflow-anchor (untouched)", anchorDefaults);
  expect(anchorDefaults.scroller).toBe("auto");

  const remembered = await primeRememberedOffset(page, thumbs);

  // Baseline: anchoring ON (the shipped state).
  await page.evaluate(() => window.__IB_PROBE__.reset());
  const cut0 = thumbs.cut();
  await tapWithoutScrolling(page, `${DIR_CARD}[data-name="${BULK}"]`);
  await waitForFileCards(page, BULK_FILES);
  const onWrite = (await page.evaluate(() => window.__IB_PROBE__.dump())).sets.at(-1);
  await waitForThumbQuiet(page, thumbs);
  await page.evaluate(() => window.__IB_PROBE__.frames(30));
  const onAfter = await page.evaluate(() => window.__IB_PROBE__.mark("anchoring-on"));
  const onFetched = fetchedBand(thumbs.since(cut0));

  // Back out, force anchoring OFF everywhere, and repeat the identical
  // navigation. If anchoring were adjusting the offset, these two runs would
  // disagree.
  await page.locator(".ib-crumb").first().click();
  await waitForFileCards(page, ROOT_FILES);
  await waitForThumbQuiet(page, thumbs);
  await page.addStyleTag({
    content: ".cmp-body, .ib-grid, .ib-card, .ib-thumb { overflow-anchor: none !important; }",
  });
  const anchorForced = await page.evaluate(
    () => getComputedStyle(document.querySelector(".cmp-body")).overflowAnchor,
  );
  expect(anchorForced).toBe("none");

  await page.evaluate(() => window.__IB_PROBE__.reset());
  const cut1 = thumbs.cut();
  await tapWithoutScrolling(page, `${DIR_CARD}[data-name="${BULK}"]`);
  await waitForFileCards(page, BULK_FILES);
  const offWrite = (await page.evaluate(() => window.__IB_PROBE__.dump())).sets.at(-1);
  await waitForThumbQuiet(page, thumbs);
  await page.evaluate(() => window.__IB_PROBE__.frames(30));
  const offAfter = await page.evaluate(() => window.__IB_PROBE__.mark("anchoring-off"));
  const offFetched = fetchedBand(thumbs.since(cut1));

  report("anchoring — remembered", remembered);
  report("anchoring — ON", {
    requested: onWrite.requested,
    immediate: onWrite.immediate,
    afterThumbs: onAfter.scrollTop,
    scrollHeight: onAfter.scrollHeight,
    fetched: onFetched,
  });
  report("anchoring — OFF (overflow-anchor: none)", {
    requested: offWrite.requested,
    immediate: offWrite.immediate,
    afterThumbs: offAfter.scrollTop,
    scrollHeight: offAfter.scrollHeight,
    fetched: offFetched,
  });
  report("anchoring — difference", {
    scrollTop: offAfter.scrollTop - onAfter.scrollTop,
    scrollHeight: offAfter.scrollHeight - onAfter.scrollHeight,
  });

  // Anchoring only ever fires when content above the viewport changes size.
  // Fixed-aspect-ratio thumbs mean it never does — so the two runs land on the
  // same pixel and anchoring is ruled out as a cause here.
  expect(onAfter.scrollTop).toBe(remembered);
  expect(offAfter.scrollTop).toBe(onAfter.scrollTop);
});

// ------------------------------------------------- RESTORE ORDERING

test("restore ordering — the restore lands before the observer starts watching", async ({
  page,
}) => {
  const thumbs = trackThumbs(page);
  await openBrowser(page);
  const remembered = await primeRememberedOffset(page, thumbs);

  const cut = thumbs.cut();
  await page.evaluate(() => window.__IB_PROBE__.reset());
  await tapWithoutScrolling(page, `${DIR_CARD}[data-name="${BULK}"]`);
  await waitForFileCards(page, BULK_FILES);

  // The band the observer WOULD have used had it evaluated before the restore:
  // scrollTop 0, i.e. the top of the list.
  const preRestoreBand = await page.evaluate(() => {
    const el = document.querySelector(".cmp-body");
    const keep = el.scrollTop;
    // Read the band at 0 without disturbing anything: band() is pure except for
    // the offset it reads, so borrow the offset and put it straight back.
    window.__IB_PROBE__.seed(0);
    const b = window.__IB_PROBE__.band();
    window.__IB_PROBE__.seed(keep);
    return b;
  });
  const postRestoreBand = await page.evaluate(() => window.__IB_PROBE__.band());
  const dump = await page.evaluate(() => window.__IB_PROBE__.dump());
  await waitForThumbQuiet(page, thumbs);
  const fetched = fetchedBand(thumbs.since(cut));
  const names = thumbs.since(cut).map((r) => r.name);

  report("ordering — remembered", remembered);
  report("ordering — pre-restore band (scrollTop 0)", preRestoreBand);
  report("ordering — post-restore band", postRestoreBand);
  report("ordering — thumbs actually fetched", { ...fetched, names: names.slice(0, 10) });
  report("ordering — first observe vs last restore write", {
    syncWrite: dump.sets[0] && { seq: dump.sets[0].seq, t: dump.sets[0].t, by: dump.sets[0].by },
    writeCount: dump.sets.length,
    firstObserve: dump.observes[0],
    observeCount: dump.observes.length,
  });

  // The ordering assertion, on a counter shared by both logs — wall-clock
  // timestamps cannot order two things inside one sub-millisecond task.
  //
  // `installLazyThumbs(gridEl)` used to run BEFORE the restore write. That was
  // latent rather than broken, because IntersectionObserver delivers its
  // callbacks asynchronously, after the task holding the write. It stops being
  // latent the moment the restore is allowed to act across later frames — which
  // it now is — so the order is made explicit instead of relied upon.
  expect(dump.observes.length).toBeGreaterThan(0);
  expect(dump.sets.length).toBeGreaterThan(0);
  expect(dump.observes[0].seq).toBeGreaterThan(dump.sets[0].seq);

  expect(fetched.first).toBeGreaterThan(preRestoreBand.last);
  expect(fetched.first).toBeGreaterThanOrEqual(postRestoreBand.first - 2);
  expect(fetched.last).toBeLessThanOrEqual(postRestoreBand.last + 2);
});

// ------------------------------------------- DYNAMIC VIEWPORT (dvh)

test("dynamic viewport — a URL-bar-sized height change at a deep offset", async ({ page }) => {
  const thumbs = trackThumbs(page);
  await openBrowser(page);
  await waitForFileCards(page, ROOT_FILES);
  await tapWithoutScrolling(page, `${DIR_CARD}[data-name="${BULK}"]`);
  await waitForFileCards(page, BULK_FILES);
  await waitForThumbQuiet(page, thumbs);

  const deep = await page.evaluate(() => {
    const el = document.querySelector(".cmp-body");
    return window.__IB_PROBE__.seed(Math.round((el.scrollHeight - el.clientHeight) * 0.5));
  });
  const before = await page.evaluate(() => window.__IB_PROBE__.mark("dvh-before"));
  // Reset AFTER parking, so the write log below contains only what the resize
  // itself provoked — the navigation's own restore writes would otherwise be
  // counted and the "no bundle code runs on resize" claim would be unreadable.
  await page.evaluate(() => window.__IB_PROBE__.reset());

  // Mobile URL bar appearing: ~100px of viewport height taken away. The dialog
  // is sized in viewport units, so the scroller's clientHeight follows.
  await page.setViewportSize({ width: 390, height: 744 });
  await page.evaluate(() => window.__IB_PROBE__.frames(20));
  const shrunk = await page.evaluate(() => window.__IB_PROBE__.mark("dvh-shrunk"));

  // …and going away again.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => window.__IB_PROBE__.frames(20));
  const restored = await page.evaluate(() => window.__IB_PROBE__.mark("dvh-restored"));

  const writes = (await page.evaluate(() => window.__IB_PROBE__.dump())).sets;

  report("dvh — seeded", deep);
  report("dvh — before", before);
  report("dvh — after shrink (844→744)", shrunk);
  report("dvh — after regrow (744→844)", restored);
  report("dvh — drift", {
    onShrink: shrunk.scrollTop - before.scrollTop,
    netAfterRegrow: restored.scrollTop - before.scrollTop,
    clientHeights: [before.clientHeight, shrunk.clientHeight, restored.clientHeight],
  });
  // No bundle code runs on resize — any movement here would be the engine's own.
  report("dvh — bundle writes during resize", writes.length);
  expect(writes.length).toBe(0);
  expect(shrunk.clientHeight).toBeLessThan(before.clientHeight);
  // The dynamic-viewport path is NOT a contributor: the scroller keeps its
  // offset across both directions of a URL-bar-sized height change.
  expect(shrunk.scrollTop).toBe(before.scrollTop);
  expect(restored.scrollTop).toBe(before.scrollTop);
});
