// Playwright driver for the README screenshot.
//
// This pack is a STANDALONE, full-viewport browser launched from the app
// chrome (an action-bar button + a command), not a per-node widget. So the
// driver opens it by invoking the pack's real public surface directly — the
// `function` on the registered extension's command (the same handler the
// toolbar button's onClick calls) — rather than clicking a Vue-rendered
// button at computed coordinates (fragile across frontend layout / scale /
// devicePixelRatio). Direct invocation exercises the exact code path a real
// click would, and is robust to whether this frontend build renders the
// action-bar button at all.
//
// The grid renders REAL files; the Docker build seeds input/output/temp with
// sample images (see seed_images.py) so the grid isn't blank.

import { chromium } from "playwright";

const OUT_DIR = process.env.OUT_DIR || "/out";
const BASE_URL = process.env.COMFYUI_URL || "http://127.0.0.1:8188/";
// Optional: type a filter into the search to show the fuzzy-match state.
// Empty (default) leaves the full mtime-sorted grid visible.
const BROWSER_QUERY = process.env.BROWSER_QUERY || "";

// Wait until at least one <img> inside `selector` has actually decoded
// (naturalWidth > 0), so the screenshot doesn't capture empty thumbs.
async function waitForThumbs(page, selector, timeout = 20_000) {
  await page.waitForFunction(
    (sel) => {
      const imgs = document.querySelectorAll(`${sel} img`);
      for (const im of imgs) {
        if (im.naturalWidth > 0) return true;
      }
      return false;
    },
    selector,
    { timeout },
  );
}

async function dismissStartupDialog(page) {
  // A fresh ComfyUI profile opens the "Workflow Templates / Getting Started"
  // browser — a PrimeVue dialog (.p-dialog-mask) over the canvas. Escape
  // triggers PrimeVue's closeOnEscape; removing the mask is the deterministic
  // belt-and-braces so it can't occlude the shot.
  await page.keyboard.press("Escape");
  await page.waitForTimeout(150);
  await page.evaluate(() => {
    for (const el of document.querySelectorAll(".p-dialog-mask")) el.remove();
  });
}

async function openBrowserModal(page) {
  console.log("Opening the Image Browser via the registered extension command…");
  await page.evaluate(() => {
    const app = window.app;
    const ext = app?.extensions?.find?.((e) => e && e.name === "comfy.image-browser");
    // Preferred: the command's function (identical handler to the toolbar
    // button's onClick). Fall back to the action-bar button's onClick, then to
    // the frontend command store if neither retained on the extension object.
    const cmdFn = ext?.commands?.find?.((c) => c.id === "image-browser.open")?.function;
    if (typeof cmdFn === "function") return cmdFn();
    const btnClick = ext?.actionBarButtons?.[0]?.onClick;
    if (typeof btnClick === "function") return btnClick();
    const exec = app?.extensionManager?.command?.execute;
    if (typeof exec === "function") return exec("image-browser.open");
    throw new Error("could not locate the Image Browser launcher");
  });
  const dialog = page.locator(".cmp-dialog");
  await dialog.waitFor({ state: "visible", timeout: 8_000 });
  return dialog;
}

async function main() {
  const browser = await chromium.launch({ args: ["--font-render-hinting=none"] });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 2,
  });
  const page = await context.newPage();

  page.on("console", (msg) => {
    const t = msg.type();
    if (t === "error" || t === "warning") console.log(`[page:${t}] ${msg.text()}`);
  });

  console.log(`Navigating to ${BASE_URL}…`);
  await page.goto(BASE_URL, { waitUntil: "networkidle" });
  await page.waitForFunction(
    () => window.app && window.app.graph && Array.isArray(window.app.graph._nodes),
    null,
    { timeout: 30_000 },
  );

  await dismissStartupDialog(page);

  const dialog = await openBrowserModal(page);

  // Wait for the grid to load at least one file card (default tab: output).
  await page.waitForFunction(
    () => document.querySelector(".cmp-dialog .ib-grid .ib-card.is-file"),
    null,
    { timeout: 10_000 },
  );

  if (BROWSER_QUERY) {
    const search = dialog.locator(".cmp-search");
    await search.waitFor({ state: "visible", timeout: 5_000 });
    await search.fill(BROWSER_QUERY);
    await page.waitForFunction(
      () => document.querySelectorAll(".cmp-dialog .ib-grid .ib-card.is-file").length > 0,
      null,
      { timeout: 5_000 },
    );
  }

  await waitForThumbs(page, ".cmp-dialog .ib-thumb");
  await page.waitForTimeout(500);

  console.log(`Capturing ${OUT_DIR}/browser.png…`);
  // The dialog is 100vw × 100vh (full-canvas), so shooting it yields the whole
  // browser view without the surrounding browser chrome.
  await dialog.screenshot({ path: `${OUT_DIR}/browser.png` });

  await page.keyboard.press("Escape");
  await browser.close();
}

main().catch((err) => {
  console.error("capture failed:", err);
  process.exit(1);
});
