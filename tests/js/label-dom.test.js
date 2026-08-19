// @vitest-environment jsdom
//
// The DOM half of the card-label change. src/label.ts's pure helpers are
// asserted in tests/js/label.test.js (node env); this file asserts what the
// grid actually RENDERS from them, and the two interactions that a
// spans-instead-of-text change can silently break.
//
// WHAT THIS TIER CAN AND CANNOT ASSERT (see .claude/rules/modal-pack-test-tiers.md)
//
// jsdom resolves class rules from the injected stylesheet, so the DECLARATIONS
// below (`flex`, `text-overflow`, the spoiler's inherited `color`) are real
// assertions. jsdom has no layout engine, so it cannot say:
//   - where the ellipsis actually lands, or whether one appears at all;
//   - whether the tail's box stays inside the card rather than pushing the
//     head to zero width;
//   - how many characters fit at a 150px track.
// Those are browser-tier questions. They belong in the PR's live-smoke list.

import { notifySafeViewChange, SAFE_VIEW_SETTINGS } from "@laurigates/comfy-modal-kit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openShell } from "../../src/index.ts";

// A real name from the reference install, chosen because it is the shape the
// whole change is for: the first 19 characters are session-constant and the
// descriptor that identifies it sits at the end.
const LONG = "105129_euler_flux2sched_s633110127082924_klein-snofs-i2i-pid4k_00001_.png";
const SHORT = "b.mp4";

const FILES = [
  { name: LONG, ext: ".png", mtime: 2, size: 10, width: 8, height: 8, rating: 0 },
  { name: SHORT, ext: ".mp4", mtime: 1, size: 10, rating: 0 },
];

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

function stubFetch(files, dirs = []) {
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

function cardFor(modal, name) {
  for (const c of modal.bodyEl.querySelectorAll(".ib-card")) {
    if (c.dataset.name === name) return c;
  }
  return null;
}

beforeEach(() => {
  localStorage.clear();
  stubSettings();
  stubFetch(FILES);
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("the label renders as head + tail spans", () => {
  it("splits a long name so the identifying tail is its own span", async () => {
    const modal = await open();
    const el = cardFor(modal, LONG).querySelector(".ib-name");
    const head = el.querySelector(".ib-name-head");
    const tail = el.querySelector(".ib-name-tail");
    expect(head).not.toBeNull();
    expect(tail).not.toBeNull();
    // The descriptor and the container are what must survive; the counter is
    // what must not.
    expect(tail.textContent).toBe("-i2i-pid4k.png");
    expect(el.textContent).not.toContain("00001");
    // The head opens with the time, so a name-sorted grid stays readable once
    // the head is ellipsized down to a few characters.
    expect(head.textContent.startsWith("105129")).toBe(true);
    modal.close();
  });

  it("renders a short name as a single tail span, with no head to elide", async () => {
    const modal = await open();
    const el = cardFor(modal, SHORT).querySelector(".ib-name");
    expect(el.querySelector(".ib-name-head")).toBeNull();
    expect(el.querySelector(".ib-name-tail").textContent).toBe(SHORT);
    modal.close();
  });

  it("leaves the title attribute carrying the FULL name", async () => {
    // The title is the only place the untouched name survives on a fine
    // pointer, and the metadata overlay is the only place it survives on a
    // coarse one. Shaping the visible label must not touch either.
    const modal = await open();
    const el = cardFor(modal, LONG).querySelector(".ib-name");
    expect(el.getAttribute("title")).toContain(LONG);
    modal.close();
  });

  it("keeps the checkbox's accessible name on the full filename", async () => {
    // The third escape channel, and the one CSS cannot reach. A change that
    // shaped this too would make the card unidentifiable to a screen reader.
    const modal = await open();
    const check = cardFor(modal, LONG).querySelector(".ib-check");
    expect(check.getAttribute("aria-label")).toBe(`Select ${LONG}`);
    modal.close();
  });

  it("declares the flex pair that makes the head elide and the tail not", async () => {
    const modal = await open();
    const el = cardFor(modal, LONG).querySelector(".ib-name");
    const head = el.querySelector(".ib-name-head");
    const tail = el.querySelector(".ib-name-tail");
    expect(getComputedStyle(el).display).toBe("flex");
    expect(getComputedStyle(head).textOverflow).toBe("ellipsis");
    expect(getComputedStyle(head).overflow).toBe("hidden");
    // `flex: 0 0 auto` — the tail must never be the thing that shrinks.
    expect(getComputedStyle(tail).flexShrink).toBe("0");
    expect(getComputedStyle(head).flexShrink).toBe("1");
    modal.close();
  });
});

describe("the full name stays reachable", () => {
  it("the overflow sheet's title carries the untouched name and can wrap", async () => {
    // The card's `title` attribute needs a hover, so on a phone the ⋯ sheet and
    // the metadata overlay are the only places the whole name appears. The
    // kit's .cmp-ov-title sets no wrapping of its own, and a ComfyUI output
    // name is one unbroken token apart from its hyphens.
    const modal = await open();
    const more = cardFor(modal, LONG).querySelector('[data-action="more"]');
    expect(more, "the maximal card must overflow into a sheet").not.toBeNull();
    more.click();
    const title = document.querySelector(".ib-more-card .cmp-ov-title");
    expect(title.textContent).toBe(LONG);
    expect(getComputedStyle(title).overflowWrap).toBe("anywhere");
    modal.close();
  });
});

describe("a directory name is shaped the same way", () => {
  it("splits a long folder name into spans", async () => {
    stubFetch([], [{ name: "2026-08-18-a-very-long-folder-name", mtime: 3 }]);
    const modal = await open();
    const el = cardFor(modal, "2026-08-18-a-very-long-folder-name").querySelector(".ib-name");
    expect(el.querySelector(".ib-name-tail")).not.toBeNull();
    expect(el.textContent).toBe("2026-08-18-a-very-long-folder-name");
    modal.close();
  });
});

describe("a fuzzy query renders the name verbatim", () => {
  it("collapses to one un-shaped span while searching", async () => {
    const modal = await open();
    modal.searchEl.value = "00001";
    modal.searchEl.dispatchEvent(new Event("input", { bubbles: true }));
    await vi.waitFor(() => {
      const el = modal.bodyEl.querySelector(".ib-card.is-file .ib-name");
      if (!el || el.textContent.includes("00001") === false) throw new Error("not searched yet");
    });
    const el = modal.bodyEl.querySelector(".ib-card.is-file .ib-name");
    // The characters the user matched on must be visible, or the hit reads as
    // a false positive. Two-sided against the default case above, which
    // asserts 00001 is absent.
    expect(el.textContent).toBe(LONG);
    expect(el.querySelector(".ib-name-head")).toBeNull();
    modal.close();
  });
});

describe("Safe View still hides a shaped name", () => {
  it("spoilers both spans, not just the container", async () => {
    // The spoiler sets `color: transparent` on `.ib-name`. The spans INHERIT
    // it — unless someone later gives them a colour of their own, which is why
    // the stylesheet carries an explicit rule and why this asserts the
    // computed value on the spans rather than on the container.
    stubSettings({
      [SAFE_VIEW_SETTINGS.enabled]: true,
      [SAFE_VIEW_SETTINGS.keywords]: "klein",
      [SAFE_VIEW_SETTINGS.blurNames]: true,
    });
    const modal = await open();
    const el = cardFor(modal, LONG).querySelector(".ib-name");
    expect(el.classList.contains("cmk-sv-spoiler")).toBe(true);
    // jsdom serialises `transparent` as `rgba(0, 0, 0, 0)`; accept either
    // spelling of the same value rather than the literal keyword.
    const TRANSPARENT = ["transparent", "rgba(0, 0, 0, 0)"];
    const spans = el.querySelectorAll(".ib-name-head, .ib-name-tail");
    // Guard against the vacuous case: an empty NodeList would pass the loop.
    expect(spans.length).toBeGreaterThan(0);
    for (const span of spans) {
      expect(TRANSPARENT).toContain(getComputedStyle(span).color);
    }
    // And the title must be parked, not merely painted over.
    expect(el.getAttribute("title")).toBeNull();
    modal.close();
  });
});
