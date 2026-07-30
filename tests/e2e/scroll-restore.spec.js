// REGRESSION — per-directory scroll restore, in real Chromium at a phone
// viewport.
//
// The jsdom test at tests/js/index.test.js passes and is vacuous for this bug:
// jsdom does no layout, so an empty scroller accepts `scrollTop = 500` and
// reads back 500 — and keeps reading it back after the node is detached. It
// proves the `scrollMemory` Map bookkeeping (which still matters, and still
// runs there) and cannot prove the engine ever accepted the offset. Everything
// in this file needs a real engine:
//
//   * a real engine CLAMPS `scrollTop = n` to `scrollHeight - clientHeight` at
//     the instant of assignment, silently;
//   * a real engine answers `scrollTop` with 0 once the element is out of the
//     document — which is the state the shell's teardown leaves the dialog in
//     BEFORE it calls `onClose`, and therefore before `rememberScroll()` runs.
//
// Tests are split into two groups, and the distinction is not cosmetic:
//
//   REGRESSION — fails against the pre-fix bundle. These are the defects.
//   LOCK       — passes before and after. These pin behaviour the fix must not
//                have broken (and, for the helper's own contract, behaviour
//                only the fix can break).
//
// Navigation here never uses Playwright's pointer on an off-screen card:
// Playwright scrolls a target into view before clicking, folder and ".." cards
// sit at the TOP of the grid, and at a deep offset that would move the scroller
// to ~0 before `rememberScroll()` ever ran — the harness would erase the number
// under test and then "discover" it was lost. `tapWithoutScrolling` and the
// always-visible toolbar crumb avoid it.

import { expect, test } from "@playwright/test";
import { DIR_CARD, FILE_CARD, openBrowser, waitForFileCards } from "./harness.js";
import { fetchedBand, installScrollProbe, trackThumbs, waitForThumbQuiet } from "./probe.js";
import { folderSpec } from "./server.mjs";

const ROOT_FILES = folderSpec("").fileCount;
const BULK = "bulk-400";
const BULK_FILES = folderSpec(BULK).fileCount;

// browser.ts's RESTORE_FRAMES — how many frames a restore re-asserts for. Kept
// here as the number a chain that runs to COMPLETION reaches, so "the restore
// let go early" is asserted against the real budget rather than against a
// hand-picked constant.
const RESTORE_FRAMES = 12;

// confirmInShell's OK button is `.cmp-ov-danger` when `danger: true` and
// `.cmp-ov-primary` otherwise — match either so the driver does not depend on
// which flavour a given call site chose.
const OV_CONFIRM = ".cmp-ov-backdrop .cmp-ov-danger, .cmp-ov-backdrop .cmp-ov-primary";

function report(label, value) {
  process.stdout.write(`[scroll] ${label}: ${JSON.stringify(value)}\n`);
}

/**
 * Tap a card by dispatching the click IN the page instead of through
 * Playwright's pointer.
 *
 * `el.click()` reaches the same delegated `gridEl` click handler with the same
 * event shape and moves nothing. The assertion below is a guard, not a
 * formality: if this ever starts moving the scroller every measurement
 * downstream becomes meaningless.
 */
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

/** Park the scroller at a fraction of its range through the NATIVE setter. */
async function seedOffset(page, fraction) {
  return page.evaluate((f) => {
    const el = document.querySelector(".cmp-body");
    const max = el.scrollHeight - el.clientHeight;
    return window.__IB_PROBE__.seed(Math.round(max * f));
  }, fraction);
}

/**
 * Drive to a deep, settled offset inside `bulk-400`: descend, let the first
 * thumb wave finish, seed the offset through the NATIVE setter (so the spy's
 * log contains only writes the BUNDLE made), then let the thumbs for that band
 * load and the layout stop moving.
 *
 * Seeding rather than flinging is deliberate and is a stated limitation: a
 * synthetic fling cannot reproduce iOS momentum in Chromium anyway, and a
 * programmatic offset makes the "requested" number exact.
 */
async function deepScrollInBulk(page, tracker, fraction = 0.5) {
  await waitForFileCards(page, ROOT_FILES);
  await tapWithoutScrolling(page, `${DIR_CARD}[data-name="${BULK}"]`);
  await waitForFileCards(page, BULK_FILES);
  await waitForThumbQuiet(page, tracker);

  const seeded = await seedOffset(page, fraction);
  await waitForThumbQuiet(page, tracker);
  await page.evaluate(() => window.__IB_PROBE__.frames(10));
  const settled = await page.evaluate(() => window.__IB_PROBE__.mark("deep-settled"));
  // The seeded offset must have survived on its own before any action: if it
  // did not, every later number would be about the seeding, not the restore.
  expect(settled.scrollTop).toBe(seeded.immediate);
  return { seeded, settled };
}

/**
 * Run `action` while sampling `scrollTop` once per frame, and return the whole
 * timeline: what the bundle wrote (and what the engine kept), the scroll events
 * that followed, the per-frame trace, and the state once thumbnails go quiet.
 *
 * The sampler starts BEFORE the action and is awaited after — one started
 * afterwards would miss the frames in which a post-assignment mover acts.
 */
async function measureAction(page, tracker, action, { frames = 90 } = {}) {
  await page.evaluate(() => window.__IB_PROBE__.reset());
  const mark0 = tracker.cut();
  const bandBefore = await page.evaluate(() => window.__IB_PROBE__.band());
  const sampling = page.evaluate((n) => window.__IB_PROBE__.frames(n), frames);
  await action();
  const trace = await sampling;
  const afterFrames = await page.evaluate(() => window.__IB_PROBE__.mark("after-frames"));
  await waitForThumbQuiet(page, tracker);
  const afterThumbs = await page.evaluate(() => window.__IB_PROBE__.mark("after-thumbs"));
  const dump = await page.evaluate(() => window.__IB_PROBE__.dump());
  const bandAfter = await page.evaluate(() => window.__IB_PROBE__.band());
  return {
    bandBefore,
    bandAfter,
    writes: dump.sets,
    scrollEvents: dump.events,
    trace,
    firstFrame: trace[0],
    lastFrame: trace[trace.length - 1],
    afterFrames,
    afterThumbs,
    thumbs: fetchedBand(tracker.since(mark0)),
    thumbNames: tracker
      .since(mark0)
      .slice(0, 8)
      .map((r) => r.name),
  };
}

/** The classification the whole exercise exists to produce. */
function verdict(m, expected) {
  const restore = m.writes[m.writes.length - 1];
  return {
    expected,
    finalWrite: restore
      ? {
          requested: restore.requested,
          immediate: restore.immediate,
          clamped: restore.clamped,
          maxScrollTopAtWrite: restore.maxScrollTop,
          by: restore.by,
        }
      : null,
    writeCount: m.writes.length,
    afterFrames: m.afterFrames.scrollTop,
    afterThumbs: m.afterThumbs.scrollTop,
    lostAtAssignment: restore ? restore.immediate !== restore.requested : null,
    lostAfterAssignment: restore ? m.afterThumbs.scrollTop !== restore.immediate : null,
    driftAfterAssignment: restore ? m.afterThumbs.scrollTop - restore.immediate : null,
  };
}

test.beforeEach(async ({ page }) => {
  await installScrollProbe(page);
});

// ================================================================ REGRESSION

test("REGRESSION D — close the modal deep in a folder, reopen, return to it", async ({ page }) => {
  const thumbs = trackThumbs(page);
  await openBrowser(page);
  const { settled } = await deepScrollInBulk(page, thumbs);

  // Close with the header ✕ rather than Esc. The shell autofocuses its search
  // field, and browser.ts's Esc handler spends the first Escape blurring an
  // input before it will let the shell close — so a single synthetic Esc is not
  // a reliable close. The ✕ is in the dialog header (outside the scroller, so
  // clicking it moves nothing) and runs the same `onClose`.
  //
  // What matters here is what `rememberScroll()` READS, not what it writes. The
  // shell's teardown is `backdrop.remove(); dialog.remove(); onClose?.()` — so
  // a close-path read taken straight off `scrollHost` comes from an element
  // that is no longer in the document, and a real engine answers 0. The Map
  // then holds a 0 that no later restore can undo: the position is never
  // stored, not lost.
  await page.evaluate(() => window.__IB_PROBE__.reset());
  await page.locator(".ib-dialog .cmp-close").click();
  await expect(page.locator(".ib-dialog")).toHaveCount(0);
  const closeReads = await page.evaluate(() => window.__IB_PROBE__.getsBy("rememberScroll"));
  report("D reads during close (rememberScroll)", closeReads);

  await page.evaluate(() => window.__IB_E2E__.open());
  await waitForFileCards(page, ROOT_FILES);
  await waitForThumbQuiet(page, thumbs);

  const m = await measureAction(page, thumbs, async () => {
    await tapWithoutScrolling(page, `${DIR_CARD}[data-name="${BULK}"]`);
    await waitForFileCards(page, BULK_FILES);
  });

  report("D remembered at close", settled);
  report("D writes", m.writes);
  report("D verdict", verdict(m, `restored to ${settled.scrollTop} across a reopen`));

  // The close path must not read the offset off a detached scroller. Pre-fix
  // this logged exactly one read with {connected: false, value: 0}.
  expect(closeReads.filter((r) => !r.connected)).toHaveLength(0);
  // …and the offset the Map kept is the one the user left, so re-entering the
  // folder after a reopen lands there.
  expect(m.writes.at(-1).requested).toBe(settled.scrollTop);
  expect(m.writes.at(-1).clamped).toBe(false);
  expect(m.afterThumbs.scrollTop).toBe(settled.scrollTop);
});

test("REGRESSION D2 — close at a deep offset in a ROOT, reopen straight into it", async ({
  page,
}) => {
  // The same defect without any navigation: reopening the browser is documented
  // to resume in place (scrollMemory is module level precisely so it can), and
  // the root's own offset goes through the identical close-path read.
  const thumbs = trackThumbs(page);
  await openBrowser(page);
  await waitForFileCards(page, ROOT_FILES);
  await waitForThumbQuiet(page, thumbs);

  const seeded = await seedOffset(page, 0.8);
  expect(seeded.immediate).toBeGreaterThan(0);
  await page.evaluate(() => window.__IB_PROBE__.frames(5));

  await page.locator(".ib-dialog .cmp-close").click();
  await expect(page.locator(".ib-dialog")).toHaveCount(0);

  await page.evaluate(() => window.__IB_PROBE__.reset());
  await page.evaluate(() => window.__IB_E2E__.open());
  await waitForFileCards(page, ROOT_FILES);
  await page.evaluate(() => window.__IB_PROBE__.frames(20));
  const after = await page.evaluate(() => window.__IB_PROBE__.mark("reopened"));
  const writes = (await page.evaluate(() => window.__IB_PROBE__.dump())).sets;

  report("D2 seeded in root", seeded);
  report("D2 writes on reopen", writes);
  report("D2 after reopen", after);

  expect(writes.at(-1).requested).toBe(seeded.immediate);
  expect(after.scrollTop).toBe(seeded.immediate);
});

test("REGRESSION E — a late mover inside the restore window is corrected", async ({ page }) => {
  // The stickiness requirement, isolated. A single synchronous assignment has
  // no answer to anything that moves the scroller after it — a late clamp, an
  // engine-side adjustment, a fling still settling. `armKnock` shoves the
  // scroller to 0 two frames AFTER the restore write, programmatically (so it
  // does not look like a user gesture, which a restore is supposed to yield
  // to). The restore has to win.
  const thumbs = trackThumbs(page);
  await openBrowser(page);
  const { settled } = await deepScrollInBulk(page, thumbs);

  // Leave the folder so its offset is remembered, then come back with the
  // knock armed.
  await page.locator(".ib-crumb").first().click();
  await waitForFileCards(page, ROOT_FILES);
  await waitForThumbQuiet(page, thumbs);

  await page.evaluate(() => window.__IB_PROBE__.reset());
  await page.evaluate(() => window.__IB_PROBE__.armKnock(0, 2));
  await tapWithoutScrolling(page, `${DIR_CARD}[data-name="${BULK}"]`);
  await waitForFileCards(page, BULK_FILES);
  const trace = await page.evaluate(() => window.__IB_PROBE__.frames(30));
  const knock = await page.evaluate(() => window.__IB_PROBE__.knockRecord());
  const after = await page.evaluate(() => window.__IB_PROBE__.mark("after-knock"));

  report("E remembered", settled.scrollTop);
  report("E knock", knock);
  report(
    "E trace (every 5th frame)",
    trace.filter((_, i) => i % 5 === 0),
  );
  report("E after", after);

  // The knock must actually have moved the scroller — otherwise this test
  // proves nothing. `readBack` is taken in the same task as the shove; the
  // per-frame trace deliberately is NOT asserted on, because a correction that
  // runs in a later rAF callback of the SAME frame never reaches a sampler.
  expect(knock).not.toBeNull();
  expect(knock.fired).toBe(true);
  expect(knock.at).not.toBeNull();
  expect(knock.readBack).toBe(0);
  // …and the remembered offset must be back, and stay back.
  expect(after.scrollTop).toBe(settled.scrollTop);
  await page.evaluate(() => window.__IB_PROBE__.frames(20));
  const settledAgain = await page.evaluate(() => window.__IB_PROBE__.mark("after-knock-settled"));
  expect(settledAgain.scrollTop).toBe(settled.scrollTop);
});

test("REGRESSION F — navigating up makes one write, and it is not clamped", async ({ page }) => {
  // Clamping is real in this harness and was being hit — by dead work.
  // renderGrid restores the offset it captured before `innerHTML = ""`, but on
  // a navigation that offset belongs to the folder just LEFT, and the parent's
  // listing is far shorter, so the engine clamps it (measured 31185 → 1865).
  // It survived only because loadAndRender's correct write followed 0.2 ms
  // later in the same synchronous task. The destination's offset now goes INTO
  // renderGrid, so there is one write and nothing to clamp.
  const thumbs = trackThumbs(page);
  await openBrowser(page);
  await waitForFileCards(page, ROOT_FILES);
  const rootSeed = await seedOffset(page, 0.6);
  await tapWithoutScrolling(page, `${DIR_CARD}[data-name="${BULK}"]`);
  await waitForFileCards(page, BULK_FILES);
  await waitForThumbQuiet(page, thumbs);
  const deep = await seedOffset(page, 0.5);

  await page.evaluate(() => window.__IB_PROBE__.reset());
  await page.locator(".ib-crumb").first().click();
  await waitForFileCards(page, ROOT_FILES);
  const writes = (await page.evaluate(() => window.__IB_PROBE__.dump())).sets;

  report("F root seed", rootSeed);
  report("F deep child offset", deep);
  report("F writes going up", writes);

  expect(writes.filter((w) => w.clamped)).toHaveLength(0);
  // Nothing writes the folder-we-left's offset into the folder-we-arrived-at.
  expect(writes.filter((w) => w.requested === deep.immediate)).toHaveLength(0);
  expect(writes).toHaveLength(1);
  expect(writes[0].requested).toBe(rootSeed.immediate);
});

// ---------------------------------------- the restore yields to the user

/**
 * Descend into `bulk-400` with a REAL pointer click and return the moment its
 * grid has painted — i.e. with the restore armed and its ~200 ms re-assert
 * window running.
 *
 * Two things this does that the rest of the file deliberately does not:
 *
 *  - The click is Playwright's, not `el.click()`. A synthetic click does not
 *    update Chromium's hit-tested scroll target, and keyboard scrolling
 *    follows that target: measured, `End` after an in-page click moved nothing
 *    at all, while after a real click on the same card it took the scroller to
 *    the bottom. The gesture tests below have to arrive as real input or they
 *    are testing the harness. It is safe HERE (and only here) because the
 *    caller leaves the root at the top, so the folder card is already on
 *    screen and Playwright's scroll-into-view is a no-op.
 *  - The wait for the paint runs IN the page. `toHaveCount` polling would
 *    spend most of the 200 ms window on round-trips, and a gesture that
 *    arrives after the window closed does not fail the test — it silently
 *    stops testing anything. `paintMs` is reported so that stays visible.
 */
async function descendIntoBulkFast(page) {
  await page.locator(`${DIR_CARD}[data-name="${BULK}"]`).click();
  return page.evaluate(async (n) => {
    const t0 = performance.now();
    while (document.querySelectorAll(".ib-card.is-file").length < n) {
      if (performance.now() - t0 > 20_000) throw new Error("listing never painted");
      await new Promise((r) => setTimeout(r, 4));
    }
    // The shell autofocuses its search field on open; keys typed there move the
    // caret, and the browser's own key handler ignores them. A real click on a
    // card does not move focus off an input by itself.
    document.activeElement?.blur?.();
    return { paintMs: performance.now() - t0 };
  }, BULK_FILES);
}

/** The restore chain's frame callbacks: `restoreScroll` arms it, `step` continues it. */
async function restoreFrames(page) {
  return page.evaluate(() => [
    ...window.__IB_PROBE__.rafsBy("restoreScroll"),
    ...window.__IB_PROBE__.rafsBy("step"),
  ]);
}

/** Sample until the offset stops changing, then report it with its clamp bound. */
async function settleOffset(page, frames = 40) {
  await page.evaluate((n) => window.__IB_PROBE__.frames(n), frames);
  return page.evaluate(() => window.__IB_PROBE__.mark("settled"));
}

/**
 * Leave `bulk-400` with a deep offset remembered, back at the root, ready to
 * descend again.
 */
async function primeBulkOffset(page, thumbs) {
  const { settled } = await deepScrollInBulk(page, thumbs);
  await page.locator(".ib-crumb").first().click();
  await waitForFileCards(page, ROOT_FILES);
  await waitForThumbQuiet(page, thumbs);
  return settled.scrollTop;
}

test("REGRESSION G — a wheel gesture inside the restore window wins", async ({ page }) => {
  // The half of the fix aimed at the reported mobile symptom: the re-assert
  // loop must let go the instant the user takes the scroller. Without the
  // gesture guard the loop keeps writing the remembered offset for ~200 ms and
  // the view yanks itself back out from under the gesture.
  //
  // REGRESSION E's knock is deliberately PROGRAMMATIC (it must not look like a
  // gesture, because that is the case the restore is supposed to win), so it
  // exercises the opposite branch and cannot stand in for this.
  const thumbs = trackThumbs(page);
  await openBrowser(page);
  const remembered = await primeBulkOffset(page, thumbs);
  expect(remembered).toBeGreaterThan(0);

  await page.evaluate(() => window.__IB_PROBE__.reset());
  // The descend's real click leaves the pointer over the grid, which is where
  // `mouse.wheel` dispatches — no extra round-trip inside the window to move it.
  const paint = await descendIntoBulkFast(page);
  await page.mouse.wheel(0, -1500);

  const after = await settleOffset(page);
  const stable = await settleOffset(page);
  // Read the ledger AFTER settling: read immediately, it would only show the
  // frames that had run so far and "the chain stopped early" would be
  // indistinguishable from "we looked early".
  const rafs = await restoreFrames(page);

  report("G remembered", remembered);
  report("G paint→gesture", paint);
  report("G restore frame callbacks", {
    scheduled: rafs.length,
    ran: rafs.filter((r) => r.ranAt !== null).length,
    cancelled: rafs.filter((r) => r.cancelledAt !== null).length,
  });
  report("G after wheel", after);

  // The wheel landed while the chain was live — the cancel it provoked is in
  // the ledger. Without this the test could pass by arriving after the window
  // closed, with nothing to fight and nothing proven.
  expect(rafs.filter((r) => r.cancelledAt !== null)).toHaveLength(1);
  // …and the chain let go instead of running its full 12 frames.
  expect(rafs.filter((r) => r.ranAt !== null).length).toBeLessThan(RESTORE_FRAMES);
  // The gesture, not the remembered offset, decides where the view sits.
  expect(after.scrollTop).toBeLessThan(remembered - 200);
  expect(stable.scrollTop).toBe(after.scrollTop);
});

test("REGRESSION H — a keyboard scroll inside the restore window is not swallowed", async ({
  page,
}) => {
  // Keyboard scrolling produces NO pointerdown/wheel/touchstart, so a guard
  // that only watches those lets the loop fight it — and the loop wins
  // outright: measured, `End` pressed inside the window left the offset pinned
  // at the remembered value across 8 samples spanning ~360 ms, while the same
  // key after the window expired reached the bottom. That is worse than a lost
  // restore: it is input the user gave being discarded.
  const thumbs = trackThumbs(page);
  await openBrowser(page);
  const remembered = await primeBulkOffset(page, thumbs);

  await page.evaluate(() => window.__IB_PROBE__.reset());
  const paint = await descendIntoBulkFast(page);
  await page.keyboard.press("End");

  const after = await settleOffset(page);
  const stable = await settleOffset(page);
  const rafs = await restoreFrames(page);

  report("H remembered", remembered);
  report("H paint→keypress", paint);
  report("H restore frame callbacks", {
    scheduled: rafs.length,
    ran: rafs.filter((r) => r.ranAt !== null).length,
    cancelled: rafs.filter((r) => r.cancelledAt !== null).length,
  });
  report("H after End", after);

  expect(rafs.filter((r) => r.cancelledAt !== null)).toHaveLength(1);
  expect(rafs.filter((r) => r.ranAt !== null).length).toBeLessThan(RESTORE_FRAMES);
  // End means the bottom, and the bottom is where it stays.
  expect(after.scrollTop).toBe(after.maxScrollTop);
  expect(after.scrollTop).toBeGreaterThan(remembered);
  expect(stable.scrollTop).toBe(after.scrollTop);
});

test("REGRESSION I — a keyboard-nav scroll and the close in the same frame", async ({ page }) => {
  // The mirror has to be fresh, not merely fresher. It is written by the
  // `scroll` listener and by setScrollTop — and `scroll` is dispatched at the
  // frame's rendering step, AFTER that frame's input events. applyFocus's
  // `scrollIntoView` is the one in-pack scroll mutator that goes through
  // neither, so a close in the same frame as a keyboard-nav scroll stored a
  // mirror that predated it (measured: 12279 on screen, 0 in the Map) — the
  // same "the position was never saved" failure as the detached read, through a
  // different door. Reachable in the product on key autorepeat plus a tap on
  // the header ✕, or any long frame while thumbnails decode.
  const thumbs = trackThumbs(page);
  await openBrowser(page);
  await waitForFileCards(page, ROOT_FILES);
  await tapWithoutScrolling(page, `${DIR_CARD}[data-name="${BULK}"]`);
  await waitForFileCards(page, BULK_FILES);
  await waitForThumbQuiet(page, thumbs);

  // Navigate by keyboard and close in ONE task — no frame in between, so the
  // `scroll` event that would paper over a stale mirror has not fired yet.
  const moved = await page.evaluate((presses) => {
    // The shell autofocuses its search field; the browser's key handler ignores
    // everything typed there.
    document.activeElement?.blur?.();
    for (let i = 0; i < presses; i++) {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "j", bubbles: true }));
    }
    const onScreen = document.querySelector(".cmp-body").scrollTop;
    document.querySelector(".ib-dialog .cmp-close").click();
    return onScreen;
  }, 80);
  await expect(page.locator(".ib-dialog")).toHaveCount(0);

  report("I offset at close (keyboard-nav, same task)", moved);
  // Non-vacuity: the keyboard navigation really did move the scroller.
  expect(moved).toBeGreaterThan(0);

  await page.evaluate(() => window.__IB_PROBE__.reset());
  await page.evaluate(() => window.__IB_E2E__.open());
  await waitForFileCards(page, ROOT_FILES);
  await tapWithoutScrolling(page, `${DIR_CARD}[data-name="${BULK}"]`);
  await waitForFileCards(page, BULK_FILES);
  const writes = (await page.evaluate(() => window.__IB_PROBE__.dump())).sets;
  const after = await settleOffset(page);

  report("I writes on return", writes);
  report("I after return", after);

  expect(writes.at(-1).requested).toBe(moved);
  expect(writes.at(-1).clamped).toBe(false);
  expect(after.scrollTop).toBe(moved);
});

// ===================================================================== LOCKS

test("LOCK A — an in-place re-render (delete a visible card) keeps the offset", async ({
  page,
}) => {
  const thumbs = trackThumbs(page);
  await openBrowser(page);
  const { settled } = await deepScrollInBulk(page, thumbs);

  // Pick a card comfortably inside the viewport so the click cannot scroll.
  const idx = await page.evaluate(() => window.__IB_PROBE__.cardInView());
  expect(idx).not.toBeNull();

  const m = await measureAction(page, thumbs, async () => {
    await page.locator(`${FILE_CARD}[data-idx="${idx}"] [data-action="delete"]`).click();
    // confirmInShell → in-dialog overlay (single-modal discipline), not a
    // second modal shell.
    await page.locator(OV_CONFIRM).click();
    await expect(page.locator(FILE_CARD)).toHaveCount(BULK_FILES - 1);
  });

  report("A verdict", verdict(m, "renderGrid save/restore around innerHTML=''"));
  report("A bands", { before: m.bandBefore, after: m.bandAfter, fetched: m.thumbs });

  expect(m.writes.some((w) => w.by.includes("renderGrid"))).toBe(true);
  expect(m.writes.at(-1).clamped).toBe(false);
  expect(m.afterFrames.scrollTop).toBe(settled.scrollTop);
  expect(m.afterThumbs.scrollTop).toBe(settled.scrollTop);
});

test("LOCK A2 — the other in-place re-render: rename a visible card", async ({ page }) => {
  const thumbs = trackThumbs(page);
  await openBrowser(page);
  const { settled } = await deepScrollInBulk(page, thumbs);

  const idx = await page.evaluate(() => window.__IB_PROBE__.cardInView());
  expect(idx).not.toBeNull();

  const m = await measureAction(page, thumbs, async () => {
    await page.locator(`${FILE_CARD}[data-idx="${idx}"] [data-action="rename"]`).click();
    const input = page.locator(".cmp-ov-backdrop .cmp-ov-input");
    await input.fill("renamed-probe.png");
    await page.locator(OV_CONFIRM).click();
    await expect(page.locator(`${FILE_CARD}[data-name="renamed-probe.png"]`)).toHaveCount(1);
  });

  report("A2 verdict", verdict(m, "renderGrid save/restore after an in-place rename"));

  expect(m.writes.some((w) => w.by.includes("renderGrid"))).toBe(true);
  expect(m.afterThumbs.scrollTop).toBe(settled.scrollTop);
});

test("LOCK B — the parent is restored to where it was left", async ({ page }) => {
  const thumbs = trackThumbs(page);
  await openBrowser(page);

  // Give the ROOT a non-zero remembered offset first, so "restored" is
  // distinguishable from "happened to be at the top". Then descend.
  await waitForFileCards(page, ROOT_FILES);
  const rootSeed = await seedOffset(page, 0.6);
  await deepScrollInBulk(page, thumbs);

  const m = await measureAction(page, thumbs, async () => {
    await page.locator(".ib-crumb").first().click();
    await waitForFileCards(page, ROOT_FILES);
  });

  report("B root seed", rootSeed);
  report("B verdict", verdict(m, `parent restored to ${rootSeed.immediate}`));

  expect(m.afterThumbs.scrollTop).toBe(rootSeed.immediate);
});

test("LOCK C — descending again restores the child's own offset", async ({ page }) => {
  const thumbs = trackThumbs(page);
  await openBrowser(page);
  const { settled } = await deepScrollInBulk(page, thumbs);

  // Up via the crumb — this is the `rememberScroll()` that stores bulk-400's
  // deep offset.
  await page.locator(".ib-crumb").first().click();
  await waitForFileCards(page, ROOT_FILES);
  await waitForThumbQuiet(page, thumbs);

  const m = await measureAction(page, thumbs, async () => {
    await tapWithoutScrolling(page, `${DIR_CARD}[data-name="${BULK}"]`);
    await waitForFileCards(page, BULK_FILES);
  });

  report("C verdict", verdict(m, `child restored to ${settled.scrollTop}`));
  report("C bands", { after: m.bandAfter, fetched: m.thumbs, firstNames: m.thumbNames });

  expect(m.writes.at(-1).requested).toBe(settled.scrollTop);
  expect(m.writes.at(-1).clamped).toBe(false);
  expect(m.afterThumbs.scrollTop).toBe(settled.scrollTop);
});

test("LOCK — a first visit to a folder starts at the top", async ({ page }) => {
  await openBrowser(page);
  await waitForFileCards(page, ROOT_FILES);
  await seedOffset(page, 0.9);
  await page.evaluate(() => window.__IB_PROBE__.reset());
  await tapWithoutScrolling(page, `${DIR_CARD}[data-name="${BULK}"]`);
  await waitForFileCards(page, BULK_FILES);
  await page.evaluate(() => window.__IB_PROBE__.frames(20));
  const after = await page.evaluate(() => window.__IB_PROBE__.mark("first-visit"));
  report("first visit", after);
  expect(after.scrollTop).toBe(0);
});

test("LOCK — a new search or sort starts at the top and stays there", async ({ page }) => {
  // The restore now defends its target for a bounded number of frames, so
  // "render, then assign 0 afterwards" would be a race the restore could win.
  // Search and sort therefore hand 0 in. This test is what catches that
  // regression: it checks the offset several frames later, not immediately.
  const thumbs = trackThumbs(page);
  await openBrowser(page);
  const { settled } = await deepScrollInBulk(page, thumbs);
  expect(settled.scrollTop).toBeGreaterThan(0);

  await page.locator(".cmp-search").fill("img-01");
  await page.evaluate(() => window.__IB_PROBE__.frames(20));
  const afterSearch = await page.evaluate(() => window.__IB_PROBE__.mark("after-search"));
  report("after search", afterSearch);
  expect(afterSearch.scrollTop).toBe(0);

  // Clear the filter, park deep again, and change the sort.
  await page.locator(".cmp-search").fill("");
  await waitForFileCards(page, BULK_FILES);
  const reseeded = await seedOffset(page, 0.5);
  expect(reseeded.immediate).toBeGreaterThan(0);
  await page.locator("select.ib-control").selectOption("name:asc");
  await page.evaluate(() => window.__IB_PROBE__.frames(20));
  const afterSort = await page.evaluate(() => window.__IB_PROBE__.mark("after-sort"));
  report("after sort", afterSort);
  expect(afterSort.scrollTop).toBe(0);
});

test("LOCK — an unreachable offset settles at the bottom instead of fighting", async ({ page }) => {
  // The honest-failure half of the restore contract. Park at the very bottom,
  // batch-delete enough cards to lose rows, and the remembered offset is now
  // past the end of the listing: it must land exactly on the new clamp bound
  // and hold there — not oscillate, not creep, not retry past the budget.
  const thumbs = trackThumbs(page);
  await openBrowser(page);
  await waitForFileCards(page, ROOT_FILES);
  await tapWithoutScrolling(page, `${DIR_CARD}[data-name="${BULK}"]`);
  await waitForFileCards(page, BULK_FILES);
  await waitForThumbQuiet(page, thumbs);
  const bottom = await seedOffset(page, 1);
  expect(bottom.immediate).toBe(bottom.maxScrollTop);

  // Select the last 8 cards through the delegated grid handler (an in-page
  // click, so nothing scrolls into view) and batch-delete them.
  for (let i = BULK_FILES - 8; i < BULK_FILES; i++) {
    await tapWithoutScrolling(page, `${FILE_CARD}[data-idx="${i}"] [data-check]`);
  }
  await expect(page.locator(".ib-selbar-count")).toHaveText("8 selected");
  await page.evaluate(() => window.__IB_PROBE__.reset());
  await page.locator('.ib-selbar-btn[data-selbar="delete"]').click();
  await page.locator(OV_CONFIRM).click();
  await waitForFileCards(page, BULK_FILES - 8);

  const trace = await page.evaluate(() => window.__IB_PROBE__.frames(30));
  const after = await page.evaluate(() => window.__IB_PROBE__.mark("after-shrink"));
  const writes = (await page.evaluate(() => window.__IB_PROBE__.dump())).sets;

  report("shrink — parked at", bottom);
  report("shrink — writes", writes);
  report("shrink — after", after);

  // The listing really did get shorter than the offset we were holding.
  expect(after.maxScrollTop).toBeLessThan(bottom.immediate);
  // Settled at the bottom, exactly, and stable across every sampled frame.
  expect(after.scrollTop).toBe(after.maxScrollTop);
  const distinct = [...new Set(trace.slice(5).map((f) => f.scrollTop))];
  report("shrink — distinct offsets over the last 25 frames", distinct);
  expect(distinct).toEqual([after.maxScrollTop]);
});

test("LOCK — closing during an active restore leaves nothing scheduled", async ({ page }) => {
  // The leak guard. The restore re-asserts frame by frame; the shell detaches
  // the dialog under it. onClose has to cancel it, or a scheduled callback
  // outlives the modal — the way a leaked IntersectionObserver used to.
  //
  // Counting scrollTop WRITES after the close cannot show that: `step`
  // early-returns on `!scrollHost.isConnected` before it would write, so a
  // leaked chain performs zero writes and a write-count assertion is green
  // either way (verified by mutation — deleting the `cancelScrollRestore()`
  // from onClose left the whole suite passing). The schedule itself is what has
  // to be observed, so probe.js keeps a requestAnimationFrame ledger and every
  // record carries whether the dialog was still in the document when the
  // callback ran / was cancelled. Both halves are asserted:
  //   * nothing scheduled by the restore chain RUNS after the dialog is gone
  //     (the leak), and
  //   * the chain really was live at close — the cancel that killed it is in
  //     the ledger — so a run where the restore had already finished cannot
  //     pass this test by having nothing to leak.
  //
  // That second half is why this LOCK, alone among them, does not pass against
  // the PRE-fix bundle: there is no chain there to cancel. It is the header's
  // "behaviour only the fix can break" case — it guards a mechanism the fix
  // introduces, not behaviour that predates it.
  const thumbs = trackThumbs(page);
  await openBrowser(page);
  const { settled } = await deepScrollInBulk(page, thumbs);
  await page.locator(".ib-crumb").first().click();
  await waitForFileCards(page, ROOT_FILES);
  await waitForThumbQuiet(page, thumbs);

  await page.evaluate(() => window.__IB_PROBE__.reset());
  // Descend and close INSIDE the restore window (~200 ms). Driven from one
  // in-page task: a Playwright click, a `toHaveCount` poll and a second click
  // are three round-trips, which is most of the window spent on the harness —
  // the close has to land while frames are still being re-asserted, and no
  // sleep can make that more certain than doing it in the page.
  const closed = await page.evaluate(
    async ({ dirSel, n }) => {
      document.querySelector(dirSel).click();
      const t0 = performance.now();
      // Poll rather than await a listing promise: the bundle exposes none, and
      // the condition under test is that the GRID has painted (which is what
      // schedules the restore).
      while (document.querySelectorAll(".ib-card.is-file").length < n) {
        if (performance.now() - t0 > 20_000) throw new Error("listing never painted");
        await new Promise((r) => setTimeout(r, 4));
      }
      const paintMs = performance.now() - t0;
      document.querySelector(".ib-dialog .cmp-close").click();
      // The gap between the grid painting (restore armed) and the close is the
      // number that decides whether this test is exercising anything.
      return { paintMs, gapToCloseMs: performance.now() - t0 - paintMs };
    },
    { dirSel: `${DIR_CARD}[data-name="${BULK}"]`, n: BULK_FILES },
  );
  await expect(page.locator(".ib-dialog")).toHaveCount(0);
  const atClose = await page.evaluate(() => window.__IB_PROBE__.dump());
  const writesAtClose = atClose.sets.length;

  // Give any survivor 30 frames to announce itself.
  await page.evaluate(() => window.__IB_PROBE__.frames(30));
  const after = await page.evaluate(() => window.__IB_PROBE__.dump());
  const restoreRafs = await page.evaluate(() => [
    ...window.__IB_PROBE__.rafsBy("restoreScroll"),
    ...window.__IB_PROBE__.rafsBy("step"),
  ]);
  report("leak — remembered", settled.scrollTop);
  report("leak — close timing (ms)", closed);
  report("leak — writes at close vs after 30 frames", {
    atClose: writesAtClose,
    after: after.sets.length,
  });
  report("leak — restore frame callbacks", restoreRafs);

  // The chain was live when the modal closed: exactly the outstanding frame
  // callback was cancelled, and it was cancelled with the dialog already out of
  // the document — which is where the shell's teardown calls onClose.
  const cancelledAfterDetach = restoreRafs.filter((r) => r.cancelledWithDialog === false);
  expect(cancelledAfterDetach).toHaveLength(1);
  // …and nothing the restore scheduled ever ran against the detached modal.
  expect(restoreRafs.filter((r) => r.ranWithDialog === false)).toHaveLength(0);
  // The `isConnected` guard inside `step` is the second line of defence and is
  // pinned separately: no write lands after the close either.
  expect(after.sets).toHaveLength(writesAtClose);
});
