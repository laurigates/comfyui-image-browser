// Side-panel ("docked") mode, issue #112 — the half jsdom cannot see.
//
// tests/js/dock.test.js asserts key ownership and the kit pointer guard by
// dispatching events. What only a layout engine can answer: the panel is
// actually parked at the right edge at the stored width, the canvas beside it
// is hit-testable (no invisible backdrop swallowing clicks), the edge handle
// resizes it, and on a phone the toggle does not exist.
import { expect, test } from "@playwright/test";
import { DIALOG, FILE_CARD, openBrowser, waitForFileCards } from "./harness.js";
import { folderSpec } from "./server.mjs";

const ROOT_FILES = folderSpec("").fileCount;
const TOGGLE = ".ib-dock-toggle";

test.describe("desktop", () => {
  test.use({ viewport: { width: 1280, height: 800 }, isMobile: false, hasTouch: false });

  test("docks to the right edge and leaves the canvas clickable", async ({ page }) => {
    await openBrowser(page);
    await waitForFileCards(page, ROOT_FILES);
    await page.locator(TOGGLE).click();
    const box = await page.locator(DIALOG).boundingBox();
    expect(Math.round(box.width)).toBe(480);
    expect(Math.round(box.x + box.width)).toBe(1280);
    // What the canvas would receive: the stand-in, not a backdrop.
    const hit = await page.evaluate(() => document.elementFromPoint(200, 400)?.id);
    expect(hit).toBe("canvas-stand-in");
    await page.mouse.click(200, 400);
    await expect(page.locator(DIALOG)).toBeVisible();
    // Esc on the canvas is the canvas's.
    await page.keyboard.press("Escape");
    await expect(page.locator(DIALOG)).toBeVisible();
    // Undocked again, the browser covers the canvas once more.
    await page.locator(TOGGLE).click();
    const full = await page.locator(DIALOG).boundingBox();
    expect(full.width).toBeGreaterThanOrEqual(1280);
  });

  test("the left edge resizes the panel, and the width survives reopening", async ({ page }) => {
    await openBrowser(page);
    await waitForFileCards(page, ROOT_FILES);
    await page.locator(TOGGLE).click();
    const handle = await page.locator(".ib-dock-handle").boundingBox();
    const y = handle.y + handle.height / 2;
    await page.mouse.move(handle.x + 2, y);
    await page.mouse.down();
    await page.mouse.move(handle.x - 118, y, { steps: 6 });
    await page.mouse.up();
    const box = await page.locator(DIALOG).boundingBox();
    expect(Math.round(box.width)).toBe(600);
    await page.locator(".cmp-close").click();
    await expect(page.locator(DIALOG)).toHaveCount(0);
    await page.evaluate(() => window.__IB_E2E__.open());
    await expect(page.locator(DIALOG)).toBeVisible();
    const again = await page.locator(DIALOG).boundingBox();
    expect(Math.round(again.width)).toBe(600);
  });

  test("the lightbox inside the panel lays its metadata out as a sheet", async ({ page }) => {
    await openBrowser(page);
    await waitForFileCards(page, ROOT_FILES);
    await page.locator(TOGGLE).click();
    await page.locator(`${FILE_CARD} .ib-thumb`).first().click();
    const panel = page.locator(".ib-lb-info");
    // The viewer is 480px wide, so the panel starts closed despite the
    // 1280px viewport — and opens below the image, not as a 360px column.
    await expect(panel).toBeHidden();
    await page.locator('[data-lb="info"]').click();
    await expect(panel.locator(".ib-meta-row").first()).toBeVisible();
    const p = await panel.boundingBox();
    const viewer = await page.locator(".ib-lb").boundingBox();
    expect(Math.round(p.width)).toBe(Math.round(viewer.width));
    expect(viewer.width).toBeLessThan(500);
  });
});

test("on a phone there is no dock toggle", async ({ page }) => {
  await openBrowser(page);
  await waitForFileCards(page, ROOT_FILES);
  await expect(page.locator(TOGGLE)).toBeHidden();
});
