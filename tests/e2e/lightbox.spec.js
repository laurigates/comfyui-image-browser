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
