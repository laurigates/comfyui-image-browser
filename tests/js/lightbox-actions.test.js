// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  activeAddress,
  hasMultipleItems,
  installLightboxActions,
} from "../../src/lightbox-actions.ts";

// The injector coalesces mutation storms into one pass per idle gap; tests wait
// past that gap rather than reaching into the module's timer.
const SETTLE_MS = 80;
const settle = () => new Promise((r) => setTimeout(r, SETTLE_MS + 40));

const BAR = ".ibl-bar";
const STARS = ".ibl-stars";

/**
 * Build the stock MediaLightbox shape (verified identical in the shipped
 * 1.47.10 bundle and the 1.50.0 source): a Teleport-to-body dialog carrying
 * role/aria-modal/data-mask, with prev/next controls only when the list holds
 * more than one item.
 */
function openLightbox(src, { multiple = true } = {}) {
  const dialog = document.createElement("div");
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");
  dialog.setAttribute("data-mask", "");
  const content = document.createElement("div");
  const img = document.createElement("img");
  img.setAttribute("src", src);
  content.appendChild(img);
  dialog.appendChild(content);
  if (multiple) {
    for (const dir of ["left", "right"]) {
      const btn = document.createElement("button");
      const icon = document.createElement("i");
      icon.className = `icon-[lucide--chevron-${dir}] size-6`;
      btn.appendChild(icon);
      dialog.appendChild(btn);
    }
  }
  document.body.appendChild(dialog);
  return { dialog, img };
}

const OUT_A = "/api/view?filename=a.png&subfolder=2026-08&type=output";
const OUT_B = "/api/view?filename=b.png&subfolder=2026-08&type=output";

/**
 * A file nobody else in this file touches. The module's deleted-file set is
 * session-scoped by design (the sidebar cannot be told to drop the entry), so
 * two delete tests sharing a filename would see each other's state.
 */
let uniq = 0;
const freshOutput = () => `/api/view?filename=d${++uniq}.png&subfolder=2026-08&type=output`;

// Every describe here appends dialogs to the document. Only one lightbox is
// ever open in the real app, and the injector paints the first one it finds —
// so a leaked dialog from a previous test would be the one it paints.
afterEach(() => {
  document.body.innerHTML = "";
});

describe("activeAddress", () => {
  it("reads the address off whichever media element the lightbox rendered", () => {
    const { dialog } = openLightbox(OUT_A);
    expect(activeAddress(dialog)).toEqual({
      type: "output",
      subfolder: "2026-08",
      name: "a.png",
      absDir: "",
    });
  });

  it("finds a video source, not just an img (the lightbox renders four shapes)", () => {
    const { dialog } = openLightbox(OUT_A);
    dialog.querySelector("img").remove();
    const video = document.createElement("video");
    video.setAttribute("src", "/api/view?filename=clip.mp4&type=output");
    dialog.appendChild(video);
    expect(activeAddress(dialog)?.name).toBe("clip.mp4");
  });

  it("returns null for an item it cannot address rather than guessing", () => {
    const { dialog } = openLightbox("blob:http://localhost/abc");
    expect(activeAddress(dialog)).toBeNull();
  });
});

describe("hasMultipleItems", () => {
  it("is true only while the next control is rendered", () => {
    const { dialog } = openLightbox(OUT_A, { multiple: true });
    expect(hasMultipleItems(dialog)).toBe(true);
    const single = openLightbox(OUT_A, { multiple: false });
    expect(hasMultipleItems(single.dialog)).toBe(false);
  });
});

describe("lightbox actions", () => {
  let uninstall = null;
  let posted = [];
  let deletes = [];
  let ratings = new Map();

  beforeEach(() => {
    posted = [];
    deletes = [];
    ratings = new Map();
    vi.stubGlobal("fetch", (url, opts) => {
      const body = JSON.parse(opts.body);
      if (url === "/image_browser/ratings") {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              ok: true,
              ratings: body.items.map((i) => ratings.get(i.name) ?? 0),
            }),
        });
      }
      if (url === "/image_browser/rating") {
        posted.push(body);
        ratings.set(body.name, body.rating);
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ ok: true, rating: body.rating }),
        });
      }
      if (url === "/image_browser/delete") {
        deletes.push(body);
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true }) });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
  });

  afterEach(() => {
    uninstall?.();
    uninstall = null;
    vi.unstubAllGlobals();
  });

  it("adds a bar with stars and a delete button once a lightbox opens", async () => {
    uninstall = installLightboxActions();
    const { dialog } = openLightbox(OUT_A);
    await settle();
    const bar = dialog.querySelector(BAR);
    expect(bar).not.toBeNull();
    expect(bar.querySelectorAll(`${STARS} [data-val]`).length).toBe(5);
    expect(bar.querySelector(".ibl-del")).not.toBeNull();
  });

  it("paints the rating the server reports for the open item", async () => {
    ratings.set("a.png", 3);
    uninstall = installLightboxActions();
    const { dialog } = openLightbox(OUT_A);
    await settle();
    await vi.waitFor(() => {
      if (dialog.querySelector(STARS).dataset.rating !== "3") throw new Error("not painted");
    });
    expect(dialog.querySelectorAll(`${STARS} .is-on`).length).toBe(3);
  });

  it("writes a rating for the item on screen and lights the stars", async () => {
    uninstall = installLightboxActions();
    const { dialog } = openLightbox(OUT_A);
    await settle();
    dialog.querySelector(`${STARS} [data-val="4"]`).click();
    await vi.waitFor(() => {
      if (!posted.length) throw new Error("no write");
    });
    expect(posted[0]).toMatchObject({ type: "output", subfolder: "2026-08", name: "a.png" });
    expect(posted[0].rating).toBe(4);
    expect(dialog.querySelector(STARS).dataset.rating).toBe("4");
  });

  it("clicking the active top star clears the rating", async () => {
    ratings.set("a.png", 2);
    uninstall = installLightboxActions();
    const { dialog } = openLightbox(OUT_A);
    await settle();
    await vi.waitFor(() => {
      if (dialog.querySelector(STARS).dataset.rating !== "2") throw new Error("not painted");
    });
    dialog.querySelector(`${STARS} [data-val="2"]`).click();
    await vi.waitFor(() => {
      if (!posted.length) throw new Error("no write");
    });
    expect(posted[0].rating).toBe(0);
  });

  it("rebuilds for the next item instead of leaving the previous rating on it", async () => {
    // The regression this guards: the dialog element PERSISTS across
    // navigation, so a bar kept from the previous item paints file A's stars
    // over file B until the read lands — a confident, clickable, wrong rating.
    //
    // The window is TRANSIENT, so this asserts MID-FLIGHT: b.png's read is
    // stalled below, because a settled-state assertion passes with the
    // teardown disabled (the read repaints the row either way). Same lesson as
    // the sidebar injector's equivalent test.
    ratings.set("a.png", 5);
    let releaseB = null;
    const realFetch = globalThis.fetch;
    vi.stubGlobal("fetch", (url, opts) => {
      const body = JSON.parse(opts.body);
      if (url === "/image_browser/ratings" && body.items[0]?.name === "b.png") {
        return new Promise((resolve) => {
          releaseB = () =>
            resolve({ ok: true, json: () => Promise.resolve({ ok: true, ratings: [0] }) });
        });
      }
      return realFetch(url, opts);
    });

    uninstall = installLightboxActions();
    const { dialog, img } = openLightbox(OUT_A);
    await settle();
    await vi.waitFor(() => {
      if (dialog.querySelector(STARS).dataset.rating !== "5") throw new Error("not painted");
    });

    img.setAttribute("src", OUT_B); // what navigating does
    await settle();
    await vi.waitFor(() => {
      if (!releaseB) throw new Error("b.png read not started");
    });

    // b.png's rating is still unknown here. The stars must read 0, not a.png's 5.
    expect(dialog.querySelector(BAR).getAttribute("data-ibl")).toBe("output 2026-08 b.png");
    expect(dialog.querySelector(STARS).dataset.rating).toBe("0");
    releaseB();
  });

  it("renders no bar for an item it cannot address", async () => {
    uninstall = installLightboxActions();
    const { dialog } = openLightbox("blob:http://localhost/abc");
    await settle();
    expect(dialog.querySelector(BAR)).toBeNull();
  });

  it("stays out of the sidebar grid and the canvas — it only paints the lightbox", async () => {
    uninstall = installLightboxActions();
    const card = document.createElement("div");
    card.setAttribute("data-selected", "false");
    const cardImg = document.createElement("img");
    cardImg.setAttribute("src", OUT_A);
    card.appendChild(cardImg);
    document.body.appendChild(card);
    await settle();
    expect(document.querySelectorAll(BAR).length).toBe(0);
  });

  describe("delete", () => {
    async function clickDelete(dialog) {
      dialog.querySelector(".ibl-del").click();
      await vi.waitFor(() => {
        if (!dialog.querySelector(".ibl-ov")) throw new Error("no confirm");
      });
    }

    it("asks before deleting and does nothing on cancel", async () => {
      uninstall = installLightboxActions();
      const { dialog } = openLightbox(freshOutput());
      await settle();
      await clickDelete(dialog);
      dialog.querySelector('[data-act="cancel"]').click();
      await settle();
      expect(deletes).toEqual([]);
      expect(dialog.querySelector(".ibl-ov")).toBeNull();
    });

    it("deletes the item on screen and advances to the next", async () => {
      uninstall = installLightboxActions();
      const src = freshOutput();
      const { dialog } = openLightbox(src, { multiple: true });
      const keys = [];
      dialog.addEventListener("keydown", (e) => keys.push(e.key));
      await settle();
      await clickDelete(dialog);
      dialog.querySelector('[data-act="ok"]').click();
      await vi.waitFor(() => {
        if (!keys.length) throw new Error("did not navigate");
      });
      expect(deletes[0]).toEqual({
        type: "output",
        subfolder: "2026-08",
        name: new URL(src, "http://x").searchParams.get("filename"),
      });
      expect(keys).toEqual(["ArrowRight"]);
    });

    it("closes instead of advancing when it is the only item", async () => {
      // Advancing a one-item list wraps back onto the file just deleted. This
      // is also the fail-soft direction if the next-control selector ever rots:
      // "single" is the safe read.
      uninstall = installLightboxActions();
      const { dialog } = openLightbox(freshOutput(), { multiple: false });
      const keys = [];
      dialog.addEventListener("keydown", (e) => keys.push(e.key));
      await settle();
      await clickDelete(dialog);
      dialog.querySelector('[data-act="ok"]').click();
      await vi.waitFor(() => {
        if (!keys.length) throw new Error("did not close");
      });
      expect(keys).toEqual(["Escape"]);
    });

    it("suppresses the lightbox's own keys while the confirm is up", async () => {
      // Otherwise ESC closes the whole lightbox behind the question, and an
      // arrow key navigates to a DIFFERENT file between asking and answering —
      // which would then be the one deleted.
      uninstall = installLightboxActions();
      const { dialog } = openLightbox(freshOutput());
      const seen = [];
      dialog.addEventListener("keydown", (e) => seen.push(e.key));
      await settle();
      await clickDelete(dialog);
      // Dispatch on the dialog, which is where a real keypress lands (it holds
      // focus via tabindex=-1) and where its own handler is bound. Dispatching
      // on `document` instead would prove nothing: the dialog's listener is not
      // on the propagation path of an event targeted at document, so the
      // assertion below would hold with the suppression removed. (Measured.)
      dialog.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }),
      );
      expect(seen).toEqual([]);

      dialog.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
      );
      await settle();
      expect(dialog.querySelector(".ibl-ov")).toBeNull();
      expect(deletes).toEqual([]);
      expect(seen).toEqual([]);
    });

    it("marks a deleted file as such instead of offering stars on it again", async () => {
      // The sidebar owns the item list and we cannot refresh it, so a deleted
      // file stays navigable. It must not look rateable.
      uninstall = installLightboxActions();
      const src = freshOutput();
      const { dialog, img } = openLightbox(src);
      await settle();
      await clickDelete(dialog);
      dialog.querySelector('[data-act="ok"]').click();
      await vi.waitFor(() => {
        if (!deletes.length) throw new Error("no delete");
      });

      img.setAttribute("src", OUT_B);
      await settle();
      img.setAttribute("src", src); // arrow back onto the deleted one
      await settle();
      expect(dialog.querySelector(STARS)).toBeNull();
      expect(dialog.querySelector(".ibl-note")?.textContent).toContain("Deleted");
    });

    it("surfaces a failed delete and leaves the item alone", async () => {
      vi.stubGlobal("fetch", (url) =>
        url === "/image_browser/delete"
          ? Promise.resolve({
              ok: false,
              status: 403,
              json: () => Promise.resolve({ ok: false, error: "outside sandbox" }),
            })
          : Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true, ratings: [0] }) }),
      );
      uninstall = installLightboxActions();
      const { dialog } = openLightbox(freshOutput());
      const keys = [];
      dialog.addEventListener("keydown", (e) => keys.push(e.key));
      await settle();
      await clickDelete(dialog);
      dialog.querySelector('[data-act="ok"]').click();
      await settle();
      // No navigation, no "Deleted" state — the file is still there.
      expect(keys).toEqual([]);
      expect(dialog.querySelector(STARS)).not.toBeNull();
    });
  });

  it("removes every trace of itself when switched off", async () => {
    uninstall = installLightboxActions();
    const { dialog } = openLightbox(OUT_A);
    await settle();
    expect(dialog.querySelector(BAR)).not.toBeNull();
    uninstall();
    uninstall = null;
    expect(document.querySelectorAll(BAR).length).toBe(0);
    // And a later mutation must not revive it.
    dialog.querySelector("img").setAttribute("src", OUT_B);
    await settle();
    expect(document.querySelectorAll(BAR).length).toBe(0);
  });
});
