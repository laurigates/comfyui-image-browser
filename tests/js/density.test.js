// @vitest-environment jsdom
//
// The grid density scale: dense / grid / list.
//
// WHAT THIS TIER CAN AND CANNOT ASSERT (see .claude/rules/modal-pack-test-tiers.md)
//
// jsdom resolves class and ATTRIBUTE rules from the injected stylesheet, so the
// declarations below are real assertions: which track a step declares, which
// parts of a card it hides, where a list-mode child is placed by grid-area.
// jsdom has NO layout engine, so it cannot say:
//   - that four columns actually appear at 390px (the arithmetic is asserted
//     here; the rendered result is not);
//   - that a finger starting on a checkbox still scrolls the grid;
//   - that three action buttons plus ⋯ fit beside a 64px thumb in list mode;
//   - anything about how the row reflows.
// Those are browser-tier questions and belong in the PR's live-smoke list.
//
// The DEFAULT step is asserted to leave the base .ib-grid rule untouched. That
// is not stylistic: card-actions.test.js reads that rule's
// grid-template-columns back verbatim and asserts the INLINE_ACTION_SLOTS
// arithmetic against a hardcoded 150px card. If "grid" stopped meaning the base
// rule, the width budget would be arithmetic about a layout that does not
// exist.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { INLINE_ACTION_SLOTS } from "../../src/browser.ts";
import { openShell } from "../../src/index.ts";

const PNG = { name: "a.png", ext: ".png", mtime: 2, size: 10, width: 8, height: 8, rating: 0 };
const MP4 = { name: "b.mp4", ext: ".mp4", mtime: 1, size: 10, rating: 0 };

function stubSettings() {
  globalThis.app = {
    extensionManager: { setting: { get: () => undefined, set: () => {} } },
  };
}

function stubFetch(files = [PNG, MP4], dirs = [{ name: "sub", mtime: 3 }]) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url, init) => {
      const s = String(url);
      if (init?.method === "POST")
        return { ok: true, status: 200, json: async () => ({ ok: true }) };
      if (s.includes("/image_browser/pins"))
        return { ok: true, status: 200, json: async () => ({ ok: true, max: 200, pins: [] }) };
      if (s.includes("/image_browser/base"))
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
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          type: "output",
          subfolder: "",
          path: "/out",
          dirs,
          files,
          exists: true,
          truncated: false,
        }),
      };
    }),
  );
}

async function open() {
  const modal = openShell();
  await vi.waitFor(() => {
    if (!modal.bodyEl.querySelector(".ib-card")) throw new Error("grid not rendered");
  });
  return modal;
}

const grid = (modal) => modal.bodyEl.querySelector(".ib-grid");
const seg = (modal, d) => modal.dialog.querySelector(`.ib-density-seg[data-density="${d}"]`);
const fileCard = (modal) => modal.bodyEl.querySelector(".ib-card.is-file");
const dirCard = (modal) => modal.bodyEl.querySelector(".ib-card.is-dir");

/** Raw text of the pack's injected stylesheet. */
function styleText() {
  return Array.from(document.querySelectorAll("style"))
    .map((s) => s.textContent || "")
    .join("\n");
}

beforeEach(() => {
  localStorage.clear();
  stubSettings();
  stubFetch();
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("the default step is the untouched base rule", () => {
  it("opens at grid density with no stored preference", async () => {
    const modal = await open();
    expect(grid(modal).dataset.density).toBe("grid");
    modal.close();
  });

  it("leaves .ib-grid's own grid-template-columns byte-identical", async () => {
    // The literal card-actions.test.js reads back. Asserted here too so a
    // density change that edited the base rule fails in the file that made the
    // change, not only in the neighbouring suite.
    openShell().close();
    expect(styleText()).toContain("repeat(auto-fill, minmax(150px, 1fr))");
  });

  it("keeps INLINE_ACTION_SLOTS a constant at 3", () => {
    // It is only allowed to stay a constant because the one step that narrows
    // the track renders no action row — see the dense assertions below.
    expect(INLINE_ACTION_SLOTS).toBe(3);
  });
});

describe("the dense step", () => {
  it("declares an 84px track at a 6px gap", async () => {
    const modal = await open();
    seg(modal, "dense").click();
    await vi.waitFor(() => {
      if (grid(modal).dataset.density !== "dense") throw new Error("not dense yet");
    });
    const g = getComputedStyle(grid(modal));
    expect(g.gridTemplateColumns).toBe("repeat(auto-fill, minmax(84px, 1fr))");
    expect(g.gap).toBe("6px");
    modal.close();
  });

  it("fits four columns in the grid width a 390px phone leaves", () => {
    // 4x84 + 3x6 = 354, inside 382px of content. Arithmetic only — that four
    // columns actually appear is a browser-tier question.
    const COLS = 4;
    const TRACK = 84;
    const GAP = 6;
    // 390 viewport - 4px grid padding either side - 2px dialog border.
    const CONTENT = 382;
    expect(COLS * TRACK + (COLS - 1) * GAP).toBeLessThanOrEqual(CONTENT);
    // ...and five would not fit, so the step is actually four-wide rather than
    // "at least four". Two-sided: a track that silently allowed five columns
    // would put ~68px cards on screen.
    expect((COLS + 1) * TRACK + COLS * GAP).toBeGreaterThan(CONTENT);
  });

  it("lets a card take its natural height instead of stretching to its row", async () => {
    // A file card sharing a row with a (two-column, still-named) folder card
    // would otherwise stretch to the folder's height — measured at 209px
    // against the 87px the thumb needs, so the first row rendered as mostly
    // empty boxes. Only the DECLARATION is assertable here; the rendered
    // heights are in tests/e2e/density.spec.js.
    const modal = await open();
    seg(modal, "dense").click();
    await vi.waitFor(() => {
      if (grid(modal).dataset.density !== "dense") throw new Error("not dense yet");
    });
    expect(getComputedStyle(grid(modal)).alignItems).toBe("start");
    modal.close();
  });

  it("HIDES the action row, which is what keeps the slot budget a constant", async () => {
    // floor((84 - 12 + 2) / (44 + 2)) = 1 — a card whose only control would be
    // the ⋯ that costs a slot itself. If a future edit un-hides this at 84px,
    // the row ships sub-44px destructive buttons again (#90). This assertion is
    // the guard, and tests/mutations-density.json mutates it.
    const modal = await open();
    seg(modal, "dense").click();
    await vi.waitFor(() => {
      if (grid(modal).dataset.density !== "dense") throw new Error("not dense yet");
    });
    const card = fileCard(modal);
    for (const sel of [".ib-actions", ".ib-stars", ".ib-meta", ".ib-name"]) {
      const el = card.querySelector(sel);
      if (!el) continue;
      expect(getComputedStyle(el).display, `${sel} must be hidden at dense`).toBe("none");
    }
    modal.close();
  });

  it("KEEPS a folder card's name, and spans it two columns", async () => {
    // Two-sided against the file card above: an implementation that hid every
    // .ib-name would pass that assertion and fail this one. A nameless folder
    // is not a smaller folder card, it is an unusable one — and directories are
    // half the truncation complaint this scale sits next to.
    const modal = await open();
    seg(modal, "dense").click();
    await vi.waitFor(() => {
      if (grid(modal).dataset.density !== "dense") throw new Error("not dense yet");
    });
    const dir = dirCard(modal);
    expect(getComputedStyle(dir.querySelector(".ib-name")).display).not.toBe("none");
    expect(getComputedStyle(dir).gridColumn).toBe("span 2");
    modal.close();
  });

  it("gives the checkbox back the vertical axis so the grid still scrolls", async () => {
    // .ib-check is touch-action:none by default so a drag from it sweeps a
    // range. At 44px on an ~84px tile that is half the card width, which at
    // this step would make a large fraction of the grid unscrollable. Scoped to
    // dense, so the default is untouched — asserted two-sided below.
    const modal = await open();
    seg(modal, "dense").click();
    await vi.waitFor(() => {
      if (grid(modal).dataset.density !== "dense") throw new Error("not dense yet");
    });
    expect(getComputedStyle(fileCard(modal).querySelector(".ib-check")).touchAction).toBe("pan-y");
    modal.close();
  });

  it("leaves the checkbox's touch-action alone at the default step", async () => {
    const modal = await open();
    expect(getComputedStyle(fileCard(modal).querySelector(".ib-check")).touchAction).toBe("none");
    modal.close();
  });
});

describe("the list step", () => {
  it("is one ITEM per row, not one image per row", async () => {
    const modal = await open();
    seg(modal, "list").click();
    await vi.waitFor(() => {
      if (grid(modal).dataset.density !== "list") throw new Error("not list yet");
    });
    expect(getComputedStyle(grid(modal)).gridTemplateColumns).toBe("1fr");
    // The card itself becomes a grid — thumb on the left, details beside it.
    // A single-column grid of the DEFAULT card would be a ~390px-tall square,
    // which openFull already does better.
    const card = fileCard(modal);
    expect(getComputedStyle(card).display).toBe("grid");
    expect(getComputedStyle(card).gridTemplateColumns).toBe("64px minmax(0, 1fr)");
    modal.close();
  });

  it("places the two post-render children over the thumb rather than in a new row", async () => {
    // .ib-check and the reveal button applySafeView appends are absolutely
    // positioned, but without an explicit grid-area the grid still reserves an
    // implicit row for each. Asserted through the stylesheet because jsdom does
    // not resolve grid-area shorthand to a computed value.
    expect(styleText()).toContain(".cmk-sv-reveal,");
    const m = /\.ib-grid\[data-density="list"\][^{]*\.ib-check \{([^}]*)\}/.exec(styleText());
    expect(m, "list mode must place .ib-check explicitly").not.toBeNull();
    expect(m[1]).toContain("grid-area: thumb");
  });

  it("lets the name wrap instead of eliding, since the row is wide", async () => {
    const modal = await open();
    seg(modal, "list").click();
    await vi.waitFor(() => {
      if (grid(modal).dataset.density !== "list") throw new Error("not list yet");
    });
    const name = fileCard(modal).querySelector(".ib-name");
    expect(getComputedStyle(name).display).toBe("block");
    expect(getComputedStyle(name).whiteSpace).toBe("normal");
    modal.close();
  });
});

describe("the preference", () => {
  it("round-trips through localStorage under this pack's own key", async () => {
    const modal = await open();
    seg(modal, "dense").click();
    expect(localStorage.getItem("comfyui-image-browser:density")).toBe("dense");
    modal.close();

    const again = await open();
    expect(grid(again).dataset.density).toBe("dense");
    again.close();
  });

  it("never writes a sibling pack's key", async () => {
    const modal = await open();
    seg(modal, "list").click();
    expect(localStorage.getItem("comfyui-gallery-loader:density")).toBeNull();
    modal.close();
  });

  it("falls back to the default on a stale or hand-edited value", async () => {
    // Whitelist on read, like loadSavedFilter. Two-sided against the round-trip
    // above: an implementation with no whitelist passes that and fails this.
    localStorage.setItem("comfyui-image-browser:density", "enormous");
    const modal = await open();
    expect(grid(modal).dataset.density).toBe("grid");
    modal.close();
  });

  it("marks the active segment for both CSS and assistive readers", async () => {
    const modal = await open();
    seg(modal, "dense").click();
    await vi.waitFor(() => {
      if (grid(modal).dataset.density !== "dense") throw new Error("not dense yet");
    });
    expect(seg(modal, "dense").classList.contains("is-active")).toBe(true);
    expect(seg(modal, "dense").getAttribute("aria-pressed")).toBe("true");
    expect(seg(modal, "grid").getAttribute("aria-pressed")).toBe("false");
    modal.close();
  });

  it("does not refetch the listing — density is a re-layout, not a new query", async () => {
    // The type filter narrows server-side and must refetch. Density does not:
    // the listing is unchanged, and a refetch would cost a round trip and lose
    // the scroll position for nothing.
    const modal = await open();
    const before = globalThis.fetch.mock.calls.length;
    seg(modal, "dense").click();
    await vi.waitFor(() => {
      if (grid(modal).dataset.density !== "dense") throw new Error("not dense yet");
    });
    expect(globalThis.fetch.mock.calls.length).toBe(before);
    modal.close();
  });
});

describe("the toolbar control", () => {
  it("declares 44px in both axes, like every other tap target", async () => {
    const modal = await open();
    const b = seg(modal, "grid");
    expect(Number.parseFloat(getComputedStyle(b).minWidth)).toBeGreaterThanOrEqual(44);
    expect(Number.parseFloat(getComputedStyle(b).minHeight)).toBeGreaterThanOrEqual(44);
    modal.close();
  });

  it("shares the filter's row rather than adding a fourth toolbar row", async () => {
    // At a phone width the toolbar already wraps to three rows and leaves the
    // grid less than one card's height. A fourth row would spend exactly what
    // this control exists to give back.
    const modal = await open();
    const row = modal.dialog.querySelector(".ib-filter");
    expect(row.querySelector(".ib-density-group")).not.toBeNull();
    expect(row.querySelector(".ib-filter-group")).not.toBeNull();
    modal.close();
  });

  it("does not disturb the type filter sharing its row", async () => {
    const modal = await open();
    seg(modal, "dense").click();
    const active = modal.dialog.querySelector(".ib-filter-seg.is-active");
    expect(active.dataset.filter).toBe("all");
    modal.close();
  });
});
