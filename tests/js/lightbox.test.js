// @vitest-environment jsdom
//
// The in-browser lightbox (src/lightbox.ts): a card tap opens the file
// full-size inside the Image Browser instead of in a new tab.
//
// WHAT THIS TIER CAN AND CANNOT ASSERT (see .claude/rules/modal-pack-test-tiers.md)
// jsdom has no layout and no media decoding, so nothing here says the image is
// actually visible, sized to the viewport, or that a swipe gesture registers on
// a phone. Those are live-smoke questions. What IS asserted: which file the
// viewer addresses, how it steps through the grid, which keys it owns, and the
// shell's ESC handler being handed back correctly around the delete question.
//
// Keys are dispatched on the element a real keypress would land on (the
// focused confirm button, or the viewer itself), never on `document` from
// above — see the "dispatch the event where a real one would land" trap.

import { notifySafeViewChange, SAFE_VIEW_SETTINGS } from "@laurigates/comfy-modal-kit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openShell } from "../../src/index.ts";

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

const FILES = [
  { name: "c.png", ext: ".png", mtime: 3, size: 10, width: 8, height: 8, rating: 0 },
  { name: "b-nsfw.png", ext: ".png", mtime: 2, size: 10, width: 8, height: 8, rating: 0 },
  { name: "a.mp4", ext: ".mp4", mtime: 1, size: 10, rating: 0 },
];

/** Every POST, in order, as `{ url, body }`. */
let posts;

function stubFetch() {
  posts = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url, init) => {
      const s = String(url);
      if (init?.method === "POST") {
        const body = JSON.parse(init.body);
        posts.push({ url: s, body });
        const json = s.includes("/rating") ? { ok: true, rating: body.rating } : { ok: true };
        return { ok: true, status: 200, json: async () => json };
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

async function open() {
  const modal = openShell();
  await vi.waitFor(() => {
    if (modal.bodyEl.querySelectorAll(".ib-card.is-file").length !== FILES.length) {
      throw new Error("grid not rendered");
    }
  });
  return modal;
}

/** Grid order as rendered — the sort is the grid's business, not this suite's. */
function gridNames(modal) {
  return Array.from(modal.bodyEl.querySelectorAll(".ib-card.is-file"), (c) => c.dataset.name);
}

function card(modal, name) {
  return Array.from(modal.bodyEl.querySelectorAll(".ib-card.is-file")).find(
    (c) => c.dataset.name === name,
  );
}

/** Tap the card's thumbnail — the grid handler's fall-through, not an action button. */
function tap(modal, name) {
  card(modal, name).querySelector(".ib-thumb").click();
}

const lb = (modal) => modal.dialog.querySelector(".ib-lb");
const media = (modal) => lb(modal)?.querySelector(".ib-lb-media");
const shownName = (modal) => lb(modal)?.querySelector(".ib-lb-name")?.textContent;

function key(target, k) {
  target.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
}

beforeEach(() => {
  localStorage.clear();
  // jsdom has no layout, so no scrollIntoView; closing the viewer focuses the
  // last-viewed card through applyFocus, which calls it.
  Element.prototype.scrollIntoView = () => {};
  stubSettings();
  stubFetch();
});

afterEach(() => {
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

describe("a card tap", () => {
  it("opens the tapped file in the lightbox, not in a new tab", async () => {
    const opener = vi.fn();
    vi.stubGlobal("open", opener);
    const modal = await open();
    tap(modal, "c.png");
    expect(lb(modal)).not.toBeNull();
    expect(media(modal).tagName).toBe("IMG");
    expect(media(modal).getAttribute("src")).toBe(
      "/api/view?filename=c.png&type=output&subfolder=",
    );
    expect(opener).not.toHaveBeenCalled();
    modal.close();
  });

  it("leaves ↗ opening a new tab", async () => {
    const opener = vi.fn();
    vi.stubGlobal("open", opener);
    const modal = await open();
    card(modal, "c.png").querySelector('[data-action="open"]').click();
    expect(opener).toHaveBeenCalledTimes(1);
    expect(lb(modal)).toBeNull();
    modal.close();
  });

  it("plays a video as a <video>", async () => {
    const modal = await open();
    tap(modal, "a.mp4");
    expect(media(modal).tagName).toBe("VIDEO");
    expect(media(modal).getAttribute("src")).toContain("filename=a.mp4");
    modal.close();
  });
});

describe("navigation", () => {
  it("steps through the grid in display order and stops at the ends", async () => {
    const modal = await open();
    const order = gridNames(modal);
    tap(modal, order[0]);
    const root = lb(modal);
    expect(root.querySelector(".ib-lb-prev").hidden).toBe(true);
    expect(root.querySelector(".ib-lb-pos").textContent).toBe(`1/${order.length}`);

    key(root, "ArrowRight");
    expect(shownName(modal)).toBe(order[1]);
    key(root, "ArrowRight");
    expect(shownName(modal)).toBe(order[2]);
    expect(root.querySelector(".ib-lb-next").hidden).toBe(true);
    key(root, "ArrowRight"); // at the end: stays put
    expect(shownName(modal)).toBe(order[2]);
    key(root, "ArrowLeft");
    expect(shownName(modal)).toBe(order[1]);
    modal.close();
  });

  it("Esc closes the viewer only; the browser stays open and focuses the last file", async () => {
    const modal = await open();
    const order = gridNames(modal);
    tap(modal, order[0]);
    key(lb(modal), "ArrowRight");
    key(lb(modal), "Escape");
    expect(lb(modal)).toBeNull();
    expect(modal.dialog.isConnected).toBe(true);
    expect(card(modal, order[1]).classList.contains("is-focused")).toBe(true);
    // And the shell's own ESC is back: the next one closes the browser. (Blur
    // first — the grid's handler spends an Esc on leaving the search field.)
    document.activeElement?.blur();
    key(modal.dialog, "Escape");
    expect(modal.dialog.isConnected).toBe(false);
  });

  it("grid shortcuts do not fire behind the viewer", async () => {
    const modal = await open();
    // `d d` deletes the FOCUSED card, so give the grid one first — with no
    // focus it has nothing to act on and this test could not fail.
    document.activeElement?.blur();
    key(modal.dialog, "j");
    expect(modal.bodyEl.querySelector(".ib-card.is-focused")).not.toBeNull();
    tap(modal, gridNames(modal)[0]);
    // With the viewer up the grid's `d d` must reach nothing — no confirm
    // overlay, no /delete.
    key(lb(modal), "d");
    key(lb(modal), "d");
    await Promise.resolve();
    expect(modal.dialog.querySelectorAll(".cmp-ov-card")).toHaveLength(0);
    expect(posts.filter((p) => p.url.includes("/delete"))).toHaveLength(0);
    modal.close();
  });
});

describe("rating", () => {
  it("posts the viewed file's address and shows on the card after close", async () => {
    const modal = await open();
    tap(modal, "c.png");
    lb(modal).querySelector('.ib-lb-bar .ib-star[data-val="4"]').click();
    await vi.waitFor(() => {
      if (!posts.some((p) => p.url.includes("/rating"))) throw new Error("no rating yet");
    });
    const post = posts.find((p) => p.url.includes("/rating"));
    expect(post.body).toMatchObject({ type: "output", subfolder: "", name: "c.png", rating: 4 });
    await Promise.resolve();
    key(lb(modal), "Escape");
    expect(card(modal, "c.png").querySelector(".ib-stars").dataset.rating).toBe("4");
    // Two-sided: an untouched card did not pick the rating up.
    expect(card(modal, "a.mp4").querySelector(".ib-stars").dataset.rating).toBe("0");
    modal.close();
  });
});

describe("delete from the viewer", () => {
  it("owns every key while the question is up, then advances and keeps Esc scoped", async () => {
    const modal = await open();
    const order = gridNames(modal);
    tap(modal, order[0]);
    lb(modal).querySelector('[data-lb="delete"]').click();
    const confirmCard = await vi.waitFor(() => {
      const c = modal.dialog.querySelector(".cmp-ov-card");
      if (!c) throw new Error("no confirm yet");
      return c;
    });
    const btn = confirmCard.querySelector("button");
    // Arrow keys landing on the question must not move the viewer behind it —
    // otherwise the answer deletes a different file from the one it named.
    key(btn, "ArrowRight");
    expect(shownName(modal)).toBe(order[0]);

    confirmCard.querySelector(".cmp-ov-danger").click();
    await vi.waitFor(() => {
      if (shownName(modal) !== order[1]) throw new Error("not advanced yet");
    });
    const del = posts.find((p) => p.url.includes("/delete"));
    expect(del.body).toMatchObject({ type: "output", subfolder: "", name: order[0] });
    expect(lb(modal)).not.toBeNull();

    // confirmInShell re-adds the shell's ESC on close. If the viewer did not
    // take it back, this Esc would close the whole browser too.
    key(lb(modal), "Escape");
    expect(lb(modal)).toBeNull();
    expect(modal.dialog.isConnected).toBe(true);
    modal.close();
  });

  it("Esc on the question cancels it and leaves the viewer open", async () => {
    const modal = await open();
    tap(modal, "c.png");
    lb(modal).querySelector('[data-lb="delete"]').click();
    const btn = await vi.waitFor(() => {
      const b = modal.dialog.querySelector(".cmp-ov-card button");
      if (!b) throw new Error("no confirm yet");
      return b;
    });
    key(btn, "Escape");
    await vi.waitFor(() => {
      if (modal.dialog.querySelector(".cmp-ov-card")) throw new Error("confirm still up");
    });
    expect(lb(modal)).not.toBeNull();
    expect(shownName(modal)).toBe("c.png");
    expect(posts.filter((p) => p.url.includes("/delete"))).toHaveLength(0);
    modal.close();
  });
});

describe("Safe View", () => {
  const blurred = (modal) => media(modal).classList.contains("cmk-sv-blur");

  it("reveals the file you tapped but blurs a match you arrow onto", async () => {
    stubSettings({ [SAFE_VIEW_SETTINGS.keywords]: "nsfw" });
    const modal = await open();
    const order = gridNames(modal);
    const i = order.indexOf("b-nsfw.png");
    expect(i).toBeGreaterThan(0);

    // Arrived at by stepping: blurred, with a reveal control.
    tap(modal, order[i - 1]);
    expect(blurred(modal)).toBe(false);
    key(lb(modal), "ArrowRight");
    expect(shownName(modal)).toBe("b-nsfw.png");
    expect(blurred(modal)).toBe(true);
    lb(modal).querySelector(".ib-lb-reveal").click();
    expect(blurred(modal)).toBe(false);
    key(lb(modal), "Escape");
    modal.close();

    // Tapped directly: the tap is the decision to look, so not blurred.
    document.body.innerHTML = "";
    const again = await open();
    tap(again, "b-nsfw.png");
    expect(shownName(again)).toBe("b-nsfw.png");
    expect(blurred(again)).toBe(false);
    again.close();
  });
});
