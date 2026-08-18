// @vitest-environment jsdom
//
// The card action row's touch floor and width budget (#90).
//
// WHAT THIS TIER CAN AND CANNOT ASSERT (see .claude/rules/modal-pack-test-tiers.md)
//
// jsdom has NO layout engine, so nothing here measures a rendered button. A
// test claiming ".ib-act is 44px wide on a phone" would be measuring the
// harness. What jsdom does do is resolve CLASS rules from the injected
// stylesheet, and `.ib-act`'s min-width/min-height are plain px values with no
// min()/calc() — measured returning "44px" through getComputedStyle, and ""
// through el.style whether the code works or not. So the DECLARATION is a real
// assertion here; the rendered geometry is not.
//
// Anything whose value contains min()/calc() is asserted against the
// stylesheet SOURCE TEXT instead. Measured: `.ib-more-card`'s
// `width: min(420px, calc(100% - 24px))` computes to "auto" in jsdom — jsdom
// drops the declaration silently, so a computed-style assertion on it would
// report the parser rather than the code.
//
// NOT ASSERTED ANYWHERE, and deliberately not faked here:
//   - whether a 44px declaration actually yields a 44px box once flex, the
//     card's real width and the font's line box are resolved;
//   - whether three 44px targets plus their gaps fit a real 150px column
//     without the row wrapping or the card overflowing;
//   - whether the overflow sheet is thumb-reachable at a phone viewport.
// Those are browser-tier questions (comfyui-plugin:comfyui-pack-live-smoke) and
// belong in the PR's live-smoke list, not in a jsdom assertion.

import { notifySafeViewChange, SAFE_VIEW_SETTINGS } from "@laurigates/comfy-modal-kit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { INLINE_ACTION_SLOTS } from "../../src/browser.ts";
import { openShell } from "../../src/index.ts";

// --------------------------------------------------------------------------
// Harness
// --------------------------------------------------------------------------

function stubSettings(values = {}) {
  const store = new Map(Object.entries(values));
  globalThis.app = {
    extensionManager: {
      setting: {
        get: (id) => store.get(id),
        set: (id, v) => {
          store.set(id, v);
          notifySafeViewChange();
        },
      },
    },
  };
}

// A .png in a sandboxed root with a Safe View keyword configured is the
// MAXIMAL card: every one of the eight controls renders for it.
const PNG = { name: "a.png", ext: ".png", mtime: 2, size: 10, width: 8, height: 8, rating: 0 };
// A .avi has no metadata reader, so it gets neither ⓘ nor ⤓ — the narrower case.
const AVI = { name: "b.avi", ext: ".avi", mtime: 1, size: 10, rating: 0 };

function stubFetch(files) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url, init) => {
      const s = String(url);
      if (init?.method === "POST") {
        return { ok: true, status: 200, json: async () => ({ ok: true }) };
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
    if (!modal.bodyEl.querySelector(".ib-card.is-file")) throw new Error("grid not rendered");
  });
  return modal;
}

function card(modal, name) {
  for (const c of modal.bodyEl.querySelectorAll(".ib-card.is-file")) {
    if (c.dataset.name === name) return c;
  }
  return null;
}

/** Actions rendered INLINE — direct children of the row, never the stash. */
function inlineActions(cardEl) {
  return Array.from(cardEl.querySelectorAll(".ib-actions > [data-action]")).map(
    (b) => b.dataset.action,
  );
}

/** Actions the width budget pushed into the stash the sheet is built from. */
function stashedActions(cardEl) {
  return Array.from(cardEl.querySelectorAll(".ib-more-stash [data-action]")).map(
    (b) => b.dataset.action,
  );
}

/** The pack's injected stylesheet, as shipped text. */
function styleText() {
  const el = document.getElementById("ib-style");
  if (!el) throw new Error("#ib-style not injected");
  return el.textContent;
}

/** Read one declaration out of one rule in the stylesheet source. */
function cssDecl(selector, prop) {
  const rule = new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`);
  const m = rule.exec(styleText());
  if (!m) throw new Error(`no rule for ${selector} in the shipped stylesheet`);
  const d = new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`).exec(m[1]);
  return d ? d[1].trim() : null;
}

/** px value of a computed property, or NaN. */
function computedPx(el, prop) {
  return Number.parseFloat(getComputedStyle(el)[prop]);
}

/**
 * Switch to the browse…/path tab and wait for the grid to be REBUILT.
 *
 * Waiting for `.ib-card[data-name="a.png"]` to exist would return instantly —
 * the previous tab's card of that name is still mounted — and every assertion
 * after it would run against the OUTPUT tab. So this waits on node identity
 * (renderGrid replaces the elements) and on the tab's own active state, neither
 * of which is what the tests then assert about.
 */
async function switchToPathTab(modal) {
  const before = card(modal, "a.png");
  modal.dialog.querySelector('.ib-tab[data-type="path"]').click();
  await vi.waitFor(() => {
    const tab = modal.dialog.querySelector('.ib-tab[data-type="path"]');
    if (!tab.classList.contains("is-active")) throw new Error("tab not active yet");
    const now = card(modal, "a.png");
    if (!now || now === before) throw new Error("grid not rebuilt yet");
  });
}

beforeEach(() => {
  localStorage.clear();
  document.body.innerHTML = "";
  Element.prototype.scrollIntoView = () => {};
  stubSettings({ [SAFE_VIEW_SETTINGS.keywords]: "nsfw" });
  // Two shapes in one listing: the .png is the MAXIMAL card (all eight
  // controls); the .avi has no metadata reader, so it drops ⓘ and ⤓ and
  // overflows by a different amount.
  stubFetch([PNG, AVI]);
});

afterEach(() => {
  vi.unstubAllGlobals();
  globalThis.app = undefined;
  for (const d of document.querySelectorAll(".cmp-backdrop, .cmp-dialog, .cmp-ov-backdrop")) {
    d.remove();
  }
  document.body.innerHTML = "";
});

// --------------------------------------------------------------------------

describe("harness self-check", () => {
  it("jsdom resolves min-width from an injected CLASS rule, and drops min()", async () => {
    // Both halves matter. The first says a computed-style assertion on .ib-act
    // is real; the second says one on .ib-more-card's width would not be, which
    // is why that one is a source scan below.
    const modal = await open();
    const probe = document.createElement("button");
    probe.className = "ib-act";
    modal.bodyEl.appendChild(probe);
    expect(getComputedStyle(probe).minWidth).toBe("44px");
    expect(probe.style.minWidth).toBe("");

    const dropped = document.createElement("div");
    dropped.className = "ib-more-card";
    modal.bodyEl.appendChild(dropped);
    expect(cssDecl(".ib-more-card", "width")).toContain("min(");
    expect(getComputedStyle(dropped).width).toBe("auto");
    modal.close();
  });
});

describe("the touch floor is declared, not hoped for", () => {
  it("declares min-width AND min-height >= 44px on .ib-act", async () => {
    // The bug was min-height: 34px and NO min-width at all, so `flex: 1`
    // shrank the button without limit. Both halves are asserted.
    const modal = await open();
    const btn = card(modal, "a.png").querySelector(".ib-act");
    expect(computedPx(btn, "minWidth")).toBeGreaterThanOrEqual(44);
    expect(computedPx(btn, "minHeight")).toBeGreaterThanOrEqual(44);
    modal.close();
  });

  it("declares min-width AND min-height >= 44px on the overflow sheet's rows", async () => {
    const modal = await open();
    card(modal, "a.png").querySelector('[data-action="more"]').click();
    const row = document.querySelector(".ib-more-row");
    expect(row).not.toBeNull();
    expect(computedPx(row, "minWidth")).toBeGreaterThanOrEqual(44);
    expect(computedPx(row, "minHeight")).toBeGreaterThanOrEqual(44);
    modal.close();
  });

  it("declares min-width AND min-height >= 44px on the selection checkbox", async () => {
    // The checkbox shipped at 34x34 — ten pixels under the floor its sibling
    // .ib-act is held to, on the control that gates multi-select on a phone. A
    // miss is not inert: it falls through to the card, which opens the file.
    //
    // The 44px box carries a 34px VISIBLE dot drawn by ::before, so this
    // assertion is about the hit target and says nothing about how big the dot
    // looks. Whether the declared 44 survives the card's flex layout and
    // `overflow: hidden` is a rendered question, and only
    // tests/e2e/selection.spec.js can answer it.
    const modal = await open();
    const check = card(modal, "a.png").querySelector(".ib-check");
    expect(check).not.toBeNull();
    expect(computedPx(check, "minWidth")).toBeGreaterThanOrEqual(44);
    expect(computedPx(check, "minHeight")).toBeGreaterThanOrEqual(44);
    modal.close();
  });

  it("keeps flex:1 so a wide card still spreads the buttons", async () => {
    // The floor must not be bought by pinning the width — on a tablet column
    // these should still grow to fill the row.
    const modal = await open();
    const btn = card(modal, "a.png").querySelector(".ib-act");
    expect(getComputedStyle(btn).flexGrow).toBe("1");
    modal.close();
  });
});

describe("the inline count is derived from the CSS, not picked", () => {
  it("computes INLINE_ACTION_SLOTS from constants that match the shipped stylesheet", () => {
    // The budget is arithmetic over CSS constants, so it is only meaningful
    // while those constants ARE the CSS. Read them back out of the sheet the
    // pack injects — a TS literal that has drifted from the rule describes a
    // layout that does not exist.
    openShell().close();
    expect(cssDecl(".ib-grid", "grid-template-columns")).toBe(
      "repeat(auto-fill, minmax(150px, 1fr))",
    );
    expect(cssDecl(".ib-actions", "gap")).toBe("2px");
    expect(cssDecl(".ib-actions", "padding")).toBe("0 6px 6px");
    expect(cssDecl(".ib-act", "min-width")).toBe("44px");
  });

  it("fits its own slots inside the narrowest card", () => {
    // floor((150 - 12 + 2) / (44 + 2)) = 3. Assert the arithmetic closes rather
    // than the number, so changing a CSS constant moves the count instead of
    // quietly breaking the promise.
    const cardWidth = 150;
    const paddingX = 12;
    const gap = 2;
    const floor = 44;
    const n = INLINE_ACTION_SLOTS;
    expect(n).toBeGreaterThanOrEqual(2); // 1 action + the ⋯ is the minimum useful row
    expect(n * floor + (n - 1) * gap + paddingX).toBeLessThanOrEqual(cardWidth);
    // And one more would NOT fit — otherwise the budget is leaving room unused.
    expect((n + 1) * floor + n * gap + paddingX).toBeGreaterThan(cardWidth);
  });
});

describe("a maximal card overflows instead of shrinking", () => {
  const ALL_EIGHT = [
    "pin",
    "marksensitive",
    "open",
    "meta",
    "workflow",
    "rename",
    "move",
    "delete",
  ];

  it("renders exactly the budget inline, and every remaining control stays reachable", async () => {
    // TWO-SIDED. The count alone passes against a version that simply DROPS the
    // controls that do not fit — which is the obvious wrong fix and looks
    // identical from the visible row. So the same test asserts the union.
    const modal = await open();
    const c = card(modal, "a.png");
    const inline = inlineActions(c);

    expect(inline).toHaveLength(INLINE_ACTION_SLOTS);
    expect(inline).toContain("more");

    const reachable = [...inline.filter((a) => a !== "more"), ...stashedActions(c)];
    expect(reachable.sort()).toEqual([...ALL_EIGHT].sort());
    modal.close();
  });

  it("keeps the two STATEFUL controls inline, where their state is legible", async () => {
    // 📌 renders filled while pinned and 🙈 pressed while marked. A control
    // whose state you can only see by opening a sheet has stopped being an
    // indicator, so their inline position is a requirement and not an accident
    // of ordering.
    const modal = await open();
    const inline = inlineActions(card(modal, "a.png"));
    expect(inline).toContain("pin");
    expect(inline).toContain("marksensitive");
    modal.close();
  });

  it("puts 🗑 delete behind the sheet, not next to ✎ rename", async () => {
    // The safety property #90 is actually about: delete was 15px from rename
    // and from move. It is now a deliberate second tap.
    const modal = await open();
    const c = card(modal, "a.png");
    expect(inlineActions(c)).not.toContain("delete");
    expect(stashedActions(c)).toContain("delete");
    modal.close();
  });

  it("renders no ⋯ when everything fits, right up to the budget", async () => {
    // The paired negative for the overflow tests: a row that ALWAYS shows ⋯
    // would satisfy every assertion above. The browse…/path tab is the
    // under-budget case — no writes, so no 📌/🙈/✎/⇄/🗑 — and it happens to
    // land EXACTLY on the budget: ↗ plus ⓘ and ⤓, which ride META_EXTS rather
    // than the canWrite mirror and so do appear there. Three controls, three
    // slots, no ⋯ — the boundary where one more would have spilled.
    const modal = await open();
    await switchToPathTab(modal);
    const c = card(modal, "a.png");
    expect(inlineActions(c)).toEqual(["open", "meta", "workflow"]);
    expect(inlineActions(c)).toHaveLength(INLINE_ACTION_SLOTS);
    expect(inlineActions(c)).not.toContain("more");
    expect(c.querySelector(".ib-more-stash")).toBeNull();

    // …and the .avi beside it, under the budget rather than on it.
    const avi = card(modal, "b.avi");
    expect(inlineActions(avi)).toEqual(["open"]);
    expect(avi.querySelector(".ib-more-stash")).toBeNull();
    modal.close();
  });
});

describe("the overflow sheet", () => {
  it("offers one row per stashed control, and nothing else", async () => {
    const modal = await open();
    const c = card(modal, "a.png");
    const stashed = stashedActions(c);
    c.querySelector('[data-action="more"]').click();
    const rows = Array.from(document.querySelectorAll(".ib-more-row")).map((r) => r.dataset.action);
    expect(rows).toEqual(stashed);
    expect(rows.length).toBeGreaterThan(0);
    modal.close();
  });

  it("labels each row instead of showing a bare glyph", async () => {
    // A 44px row of nothing but ⤓ is not the point of the sheet.
    const modal = await open();
    card(modal, "a.png").querySelector('[data-action="more"]').click();
    const del = document.querySelector('.ib-more-row[data-action="delete"]');
    expect(del.textContent).toContain("🗑");
    expect(del.textContent).toContain("Delete");
    modal.close();
  });

  it("runs the real action, and closes first so the result is visible", async () => {
    // Dispatching through the SAME runCardAction as the inline row is the whole
    // reason the sheet is built from the card's stash. Asserting the markup
    // alone would pass against a sheet whose rows do nothing.
    const modal = await open();
    card(modal, "a.png").querySelector('[data-action="more"]').click();
    document.querySelector('.ib-more-row[data-action="delete"]').click();
    // The sheet is gone and the delete confirm is up in its place.
    expect(document.querySelector(".ib-more-row")).toBeNull();
    await vi.waitFor(() => {
      if (!document.querySelector(".cmp-ov-card")) throw new Error("confirm not shown");
    });
    expect(document.body.textContent).toContain("a.png");
    modal.close();
  });

  it("never has to carry state, because no stateful control reaches it", async () => {
    // The invariant that lets openMoreSheet render a plain row: 📌 and 🙈 lead
    // the priority order, so neither can be stashed. Asserted across every card
    // shape the pack renders rather than on one card — a single-shape check
    // would pass while some other listing quietly buried one of them.
    //
    // If this ever goes red, the sheet needs to read and paint the state again
    // (aria-pressed for 🙈, .is-pinned for 📌); do not just reorder past it.
    const modal = await open();
    const shapes = [];
    for (const c of modal.bodyEl.querySelectorAll(".ib-card.is-file")) {
      shapes.push([c.dataset.name, stashedActions(c)]);
    }
    await switchToPathTab(modal);
    for (const c of modal.bodyEl.querySelectorAll(".ib-card.is-file")) {
      shapes.push([`path/${c.dataset.name}`, stashedActions(c)]);
    }
    // The paired positive: an empty shape list, or a set of shapes that all
    // happen to stash nothing, would make the loop below vacuous.
    expect(shapes.length).toBeGreaterThanOrEqual(4);
    expect(shapes.some(([, stashed]) => stashed.length > 0)).toBe(true);
    for (const [name, stashed] of shapes) {
      expect({ name, stashed }).toEqual({
        name,
        stashed: stashed.filter((a) => a !== "pin" && a !== "marksensitive"),
      });
    }
    modal.close();
  });
});
