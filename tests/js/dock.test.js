// @vitest-environment jsdom
//
// Side-panel ("docked") mode, issue #112: the browser parks at the right edge
// so the canvas stays usable beside it.
//
// WHAT THIS TIER CAN AND CANNOT ASSERT
// jsdom has no layout, so nothing here says the dialog is actually 480px wide
// or that a click on the canvas reaches it — tests/e2e/dock.spec.js measures
// that. What IS asserted: the stored preference, the width clamp, and the one
// behavioural change that matters most: which keys the browser owns. Docked,
// the browser's capture-phase key handlers are on `document`, so without a
// gate an Esc pressed on the canvas would close the browser and `d d` would
// delete the focused card.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { app } from "/scripts/app.js";
import { clampDockWidth, DOCK_MIN_WIDTH, DOCK_STORAGE_KEY } from "../../src/dock.ts";
import { openShell } from "../../src/index.ts";

const FILES = [
  { name: "c.png", ext: ".png", mtime: 3, size: 10, width: 8, height: 8, rating: 0 },
  { name: "b.png", ext: ".png", mtime: 2, size: 10, width: 8, height: 8, rating: 0 },
];

let posts;

function stubFetch() {
  posts = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url, init) => {
      const s = String(url);
      if (init?.method === "POST") {
        posts.push(s);
        return { ok: true, status: 200, json: async () => ({ ok: true }) };
      }
      if (s.includes("/image_browser/metadata")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ok: true,
            format: "png",
            source: "comfyui",
            raw: { workflow: "{}x" },
          }),
        };
      }
      if (s.includes("/api/view")) {
        return {
          ok: true,
          status: 200,
          blob: async () => new Blob(["png"], { type: "image/png" }),
        };
      }
      if (s.includes("/image_browser/pins")) {
        return { ok: true, status: 200, json: async () => ({ ok: true, max: 200, pins: [] }) };
      }
      if (s.includes("/image_browser/base")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ok: true,
            base_path: "/",
            input_dir: "",
            output_dir: "",
            temp_dir: "",
          }),
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          type: "output",
          subfolder: "",
          path: "/out",
          dirs: [],
          files: FILES.map((f) => ({ ...f })),
          exists: true,
          truncated: false,
        }),
      };
    }),
  );
}

function stubWide(wide) {
  vi.stubGlobal(
    "matchMedia",
    vi.fn((q) => ({ matches: wide && q.includes("min-width"), media: q })),
  );
}

async function open() {
  const modal = openShell();
  await vi.waitFor(() => {
    if (modal.bodyEl.querySelectorAll(".ib-card.is-file").length !== FILES.length) {
      throw new Error("grid not rendered");
    }
  });
  return modal;
}

const toggle = (modal) => modal.headerEl.querySelector(".ib-dock-toggle");
const docked = (modal) => modal.dialog.classList.contains("is-docked");

function key(target, k) {
  target.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
}

/** A pointer landing somewhere — what decides whose keys come next. */
function press(target) {
  target.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
}

let canvas;

beforeEach(() => {
  localStorage.clear();
  Element.prototype.scrollIntoView = () => {};
  globalThis.app = { extensionManager: { setting: { get: () => undefined, set: () => {} } } };
  stubFetch();
  stubWide(true);
  canvas = document.createElement("canvas");
  document.body.appendChild(canvas);
});

afterEach(() => {
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

describe("clampDockWidth", () => {
  it("keeps the panel usable and leaves the canvas some room", () => {
    expect(clampDockWidth(100, 1600)).toBe(DOCK_MIN_WIDTH);
    expect(clampDockWidth(600, 1600)).toBe(600);
    // Never wider than the viewport minus a strip of canvas.
    expect(clampDockWidth(5000, 1600)).toBeLessThan(1600);
    expect(clampDockWidth(5000, 1600)).toBeGreaterThan(600);
    // A viewport too small for both still yields the minimum, not a negative.
    expect(clampDockWidth(5000, 400)).toBe(DOCK_MIN_WIDTH);
    expect(clampDockWidth(Number.NaN, 1600)).toBe(DOCK_MIN_WIDTH);
  });
});

describe("the dock toggle", () => {
  it("docks, remembers it, and undocks", async () => {
    const modal = await open();
    expect(docked(modal)).toBe(false);
    toggle(modal).click();
    expect(docked(modal)).toBe(true);
    expect(modal.backdrop.classList.contains("ib-dock-backdrop")).toBe(true);
    expect(toggle(modal).getAttribute("aria-pressed")).toBe("true");
    expect(JSON.parse(localStorage.getItem(DOCK_STORAGE_KEY)).docked).toBe(true);
    modal.close();

    const again = await open();
    expect(docked(again)).toBe(true);
    toggle(again).click();
    expect(docked(again)).toBe(false);
    expect(again.backdrop.classList.contains("ib-dock-backdrop")).toBe(false);
    again.close();
  });

  it("does not close the browser when clicked", async () => {
    const modal = await open();
    toggle(modal).click();
    toggle(modal).click();
    expect(modal.dialog.isConnected).toBe(true);
    modal.close();
  });
});

describe("clicking the canvas", () => {
  // The kit's pointer guard dismisses the active modal on any pointerdown
  // outside it — right for a modal, fatal for a panel beside a live canvas.
  it("does not close the docked browser", async () => {
    const modal = await open();
    toggle(modal).click();
    press(canvas);
    expect(modal.dialog.isConnected).toBe(true);
    modal.close();
  });

  it("still closes the full-screen browser (the guard is untouched undocked)", async () => {
    const modal = await open();
    press(canvas);
    expect(modal.dialog.isConnected).toBe(false);
  });

  it("closes a docked browser once the viewport is too narrow to dock", async () => {
    const modal = await open();
    toggle(modal).click();
    stubWide(false);
    press(canvas);
    expect(modal.dialog.isConnected).toBe(false);
  });
});

describe("key ownership while docked", () => {
  it("keys after a canvas click belong to the canvas, not the browser", async () => {
    const modal = await open();
    toggle(modal).click();
    document.activeElement?.blur();
    press(canvas);
    key(canvas, "Escape");
    expect(modal.dialog.isConnected).toBe(true);
    // `j` moves the focused card, and `d d` acts on the focused card.
    const focused = () => modal.bodyEl.querySelector(".ib-card.is-focused")?.dataset.name;
    const before = focused();
    key(canvas, "j");
    key(canvas, "j");
    expect(focused()).toBe(before);
    // Two-sided: back inside the browser, the same keys are its own again.
    press(modal.bodyEl);
    key(modal.bodyEl, "j");
    key(modal.bodyEl, "j");
    expect(focused()).not.toBe(before);
    key(modal.bodyEl, "Escape");
    expect(modal.dialog.isConnected).toBe(false);
  });

  it("`d d` on the canvas deletes nothing", async () => {
    const modal = await open();
    toggle(modal).click();
    document.activeElement?.blur();
    press(modal.bodyEl);
    key(modal.bodyEl, "j"); // the grid now has a focused card to act on
    press(canvas);
    key(canvas, "d");
    key(canvas, "d");
    await Promise.resolve();
    expect(modal.dialog.querySelectorAll(".cmp-ov-card")).toHaveLength(0);
    expect(posts.filter((u) => u.includes("/delete"))).toHaveLength(0);
    // Two-sided: the same keys inside the browser do ask.
    press(modal.bodyEl);
    key(modal.bodyEl, "d");
    key(modal.bodyEl, "d");
    await vi.waitFor(() => {
      if (!modal.dialog.querySelector(".cmp-ov-card")) throw new Error("no confirm");
    });
    modal.close();
  });

  it("the gate survives an in-dialog overlay handing the shell's Esc back", async () => {
    const modal = await open();
    toggle(modal).click();
    document.activeElement?.blur();
    press(modal.bodyEl);
    key(modal.bodyEl, "?");
    const ov = modal.dialog.querySelector(".cmp-ov-card");
    expect(ov).not.toBeNull();
    key(ov, "Escape");
    expect(modal.dialog.querySelector(".cmp-ov-card")).toBeNull();
    press(canvas);
    key(canvas, "Escape");
    expect(modal.dialog.isConnected).toBe(true);
    modal.close();
  });

  it("is inert undocked: a full-screen browser owns every key", async () => {
    const modal = await open();
    document.activeElement?.blur();
    press(canvas);
    key(canvas, "Escape");
    expect(modal.dialog.isConnected).toBe(false);
  });

  it("is inert on a narrow viewport, where docked renders full-screen", async () => {
    localStorage.setItem(DOCK_STORAGE_KEY, JSON.stringify({ docked: true, width: 480 }));
    stubWide(false);
    const modal = await open();
    document.activeElement?.blur();
    press(canvas);
    key(canvas, "Escape");
    expect(modal.dialog.isConnected).toBe(false);
  });

  it("leaves no keydown listener behind after close", async () => {
    const add = vi.spyOn(document, "addEventListener");
    const remove = vi.spyOn(document, "removeEventListener");
    const modal = await open();
    toggle(modal).click();
    modal.close();
    const keydown = (spy) => spy.mock.calls.filter(([t]) => t === "keydown").map(([, fn]) => fn);
    const added = keydown(add);
    const removed = new Set(keydown(remove));
    expect(added.filter((fn) => !removed.has(fn))).toEqual([]);
  });
});

describe("load workflow while docked", () => {
  it("keeps the docked browser open — the canvas is already visible beside it", async () => {
    app.handleFileCalls.length = 0;
    const modal = await open();
    toggle(modal).click();
    modal.bodyEl.querySelector('[data-action="workflow"]').click();
    await vi.waitFor(() => {
      if (app.handleFileCalls.length === 0) throw new Error("handleFile not called");
    });
    expect(modal.dialog.isConnected).toBe(true);
    modal.close();
  });

  it("still closes the full-screen browser", async () => {
    app.handleFileCalls.length = 0;
    const modal = await open();
    modal.bodyEl.querySelector('[data-action="workflow"]').click();
    await vi.waitFor(() => {
      if (app.handleFileCalls.length === 0) throw new Error("handleFile not called");
    });
    expect(modal.dialog.isConnected).toBe(false);
  });
});
