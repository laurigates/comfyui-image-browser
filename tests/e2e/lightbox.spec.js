// The lightbox's swipe gesture (src/lightbox.ts), in a real engine.
//
// jsdom cannot drive this: it has no pointer-event sequence from a real input
// device, and the half that matters — the `click` Chromium derives from a
// pointerdown/pointerup pair landing on the stage, which would close the viewer
// right after a swipe — only exists here.
import { expect, test } from "@playwright/test";
import { FILE_CARD, openBrowser, waitForFileCards } from "./harness.js";
import { folderSpec } from "./server.mjs";

const ROOT_FILES = folderSpec("").fileCount;
const LB = ".ib-lb";
const NAME = ".ib-lb-name";

async function openFirst(page) {
  await openBrowser(page);
  await waitForFileCards(page, ROOT_FILES);
  const names = await page.locator(FILE_CARD).evaluateAll((cs) => cs.map((c) => c.dataset.name));
  await page.locator(`${FILE_CARD} .ib-thumb`).first().click();
  await expect(page.locator(LB)).toBeVisible();
  await expect(page.locator(NAME)).toHaveText(names[0]);
  return names;
}

async function drag(page, dx) {
  const box = await page.locator(".ib-lb-stage").boundingBox();
  // Along the stage's top edge, in the letterbox beside the image: that is
  // where the derived click lands on the stage itself and would close the
  // viewer. A drag across the image produces a click on the <img>, which never
  // closes, so it cannot tell whether the suppression works.
  const x = box.x + box.width / 2;
  const y = box.y + 6;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx, y, { steps: 5 });
  await page.mouse.up();
}

test("a left swipe steps to the next file and does NOT close the viewer", async ({ page }) => {
  const names = await openFirst(page);
  await drag(page, -150);
  await expect(page.locator(LB)).toBeVisible();
  await expect(page.locator(NAME)).toHaveText(names[1]);
  await drag(page, 150);
  await expect(page.locator(NAME)).toHaveText(names[0]);
});

test("a plain tap beside the image still closes the viewer", async ({ page }) => {
  // The other arm: the swipe's click suppression must not swallow a real tap.
  await openFirst(page);
  const box = await page.locator(".ib-lb-stage").boundingBox();
  await page.mouse.click(box.x + 4, box.y + 4);
  await expect(page.locator(LB)).toHaveCount(0);
});

// The info panel (issue #112). Which file it reads and when is the jsdom
// suite's business; what only a layout engine can say is that on a desktop
// viewport the panel sits BESIDE the media rather than over it, and that on a
// phone it is out of the way until asked for.
test.describe("info panel", () => {
  test("on a desktop viewport it opens beside the image without covering it", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await openFirst(page);
    const panel = page.locator(".ib-lb-info");
    await expect(panel).toBeVisible();
    await expect(panel.locator(".ib-meta-row").first()).toBeVisible();
    const p = await panel.boundingBox();
    // The STAGE, not the <img>: the fixture image is small and centred, so its
    // own box clears the panel even when the stage runs underneath it.
    const stage = await page.locator(".ib-lb-stage").boundingBox();
    const next = await page.locator(".ib-lb-next").boundingBox();
    expect(stage.x + stage.width).toBeLessThanOrEqual(p.x + 0.5);
    // The › control moved off the panel rather than sitting on top of it.
    expect(next.x + next.width).toBeLessThanOrEqual(p.x + 0.5);
    // Two-sided: toggled off, the image is free to use the panel's width.
    await page.keyboard.press("i");
    await expect(panel).toBeHidden();
    const wide = await page.locator(".ib-lb-stage").boundingBox();
    expect(wide.x + wide.width).toBeGreaterThan(p.x + 1);
  });

  test("on a phone it starts closed, and opens as a sheet below the image", async ({ page }) => {
    await openFirst(page);
    const panel = page.locator(".ib-lb-info");
    await expect(panel).toBeHidden();
    await page.locator('[data-lb="info"]').click();
    await expect(panel.locator(".ib-meta-row").first()).toBeVisible();
    const p = await panel.boundingBox();
    const vw = page.viewportSize().width;
    expect(Math.round(p.width)).toBe(vw);
    const bar = await page.locator(".ib-lb-bar").boundingBox();
    expect(p.y + p.height).toBeLessThanOrEqual(bar.y + 0.5);
  });
});
