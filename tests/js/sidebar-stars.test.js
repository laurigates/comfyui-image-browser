// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addressKey, installSidebarStars, parseAssetAddress } from "../../src/sidebar-stars.ts";

// The injector coalesces mutation storms into one pass per idle gap; tests wait
// past that gap rather than reaching into the module's timer.
const SETTLE_MS = 120;
const settle = () => new Promise((r) => setTimeout(r, SETTLE_MS + 40));

/** Build the stock card shape the injector anchors on (see MediaAssetCard.vue). */
function makeCard(src) {
  const wrap = document.createElement("div");
  wrap.setAttribute("data-virtual-grid-item", "");
  const card = document.createElement("div");
  card.setAttribute("data-selected", "false");
  card.setAttribute("draggable", "true");
  const thumb = document.createElement("div");
  const img = document.createElement("img");
  img.setAttribute("src", src);
  thumb.appendChild(img);
  card.appendChild(thumb);
  wrap.appendChild(card);
  document.body.appendChild(wrap);
  return { card, img };
}

describe("parseAssetAddress", () => {
  it("reads filename / subfolder / type out of a view URL", () => {
    expect(parseAssetAddress("/api/view?filename=a.png&subfolder=2026-07&type=output")).toEqual({
      type: "output",
      subfolder: "2026-07",
      name: "a.png",
      absDir: "",
    });
  });

  it("defaults type to input and subfolder to empty, matching /api/view itself", () => {
    // This is the exact shape the live 1.47.10 sidebar emits for Imported files.
    expect(parseAssetAddress("/api/view?filename=mage_ref.png&type=input")).toEqual({
      type: "input",
      subfolder: "",
      name: "mage_ref.png",
      absDir: "",
    });
    expect(parseAssetAddress("/api/view?filename=a.png")?.type).toBe("input");
  });

  it("accepts an absolute URL (the live sidebar emits both forms)", () => {
    expect(parseAssetAddress("http://popos:8188/api/view?filename=a.png&type=output")?.name).toBe(
      "a.png",
    );
  });

  it("returns null rather than guessing for anything it cannot address", () => {
    // A guess here would post a rating write against the wrong file.
    expect(parseAssetAddress("")).toBeNull();
    expect(parseAssetAddress(null)).toBeNull();
    expect(parseAssetAddress(undefined)).toBeNull();
    expect(parseAssetAddress("blob:http://localhost/abc")).toBeNull();
    expect(parseAssetAddress("data:image/png;base64,iVBOR")).toBeNull();
    expect(parseAssetAddress("/api/view?type=output")).toBeNull(); // no filename
    // type=path is browse-only; ratings are a sandboxed-roots concept.
    expect(parseAssetAddress("/api/view?filename=a.png&type=path")).toBeNull();
    expect(parseAssetAddress("/api/other?filename=a.png&type=input")).toBeNull();
  });
});

describe("sidebar star injection", () => {
  let uninstall = null;
  let posted = [];

  beforeEach(() => {
    document.body.innerHTML = "";
    posted = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url, init) => {
        const body = init?.body ? JSON.parse(init.body) : null;
        if (String(url).includes("/image_browser/ratings")) {
          // Deterministic stand-in for on-disk XMP: rating is derived from the
          // filename so a test can assert which FILE a row is showing.
          return {
            ok: true,
            status: 200,
            json: async () => ({
              ok: true,
              ratings: body.items.map((i) => (i.name === "a.png" ? 5 : 1)),
            }),
          };
        }
        posted.push({ url: String(url), body });
        return { ok: true, status: 200, json: async () => ({ ok: true, rating: body.rating }) };
      }),
    );
  });

  afterEach(() => {
    uninstall?.();
    uninstall = null;
    vi.unstubAllGlobals();
  });

  it("adds one star row per addressable card and paints the fetched rating", async () => {
    makeCard("/api/view?filename=a.png&type=output");
    uninstall = installSidebarStars();
    await settle();
    await settle(); // second pass paints once the batch read resolves

    const rows = document.querySelectorAll(".ibs-stars");
    expect(rows.length).toBe(1);
    expect(rows[0].dataset.rating).toBe("5");
    expect(rows[0].querySelectorAll("[data-val]").length).toBe(5);
  });

  it("renders nothing on a card whose image it cannot address", async () => {
    makeCard("blob:http://localhost/pending");
    uninstall = installSidebarStars();
    await settle();
    expect(document.querySelectorAll(".ibs-stars").length).toBe(0);
  });

  it("ignores /api/view images that are not media-asset cards", async () => {
    // /api/view is ALSO how a PreviewImage node renders its output on the
    // canvas and how the lightbox shows a full-size image — neither should get
    // stars. The guard that holds this is the cardRootOf() ancestor check, not
    // the scoped selector: measured, this test still passes with the query
    // widened back to `querySelectorAll("img")`, so it locks the BEHAVIOUR and
    // does not discriminate the selector. Kept as a behavioural lock, and
    // labelled honestly so nobody reads it as protecting the scoping.
    const loose = document.createElement("img");
    loose.setAttribute("src", "/api/view?filename=a.png&type=temp");
    document.body.appendChild(loose);

    uninstall = installSidebarStars();
    await settle();
    await settle();

    expect(document.querySelectorAll(".ibs-stars").length).toBe(0);
  });

  it("REGRESSION: a recycled card never shows the previous file's rating, even in-flight", async () => {
    // The grid is virtualized: the SAME card element is reused for a different
    // file as you scroll.
    //
    // The steady state self-corrects (applyStars repaints once the read lands),
    // so asserting only the settled value proves NOTHING — measured: that
    // version of this test passed with the teardown guard disabled. The real
    // defect is the TRANSIENT window between the src swap and the response,
    // where a kept row paints file A's stars over file B. So this test holds
    // the batch read open and inspects the row inside that window.
    let releaseRead;
    const gate = new Promise((r) => {
      releaseRead = r;
    });
    let gated = false;

    const { card, img } = makeCard("/api/view?filename=a.png&type=output");
    uninstall = installSidebarStars();
    await settle();
    await settle();
    expect(card.querySelector(".ibs-stars").dataset.rating).toBe("5");

    // From here on, stall the ratings read so the in-flight window is observable.
    const realFetch = globalThis.fetch;
    vi.stubGlobal("fetch", async (url, init) => {
      if (String(url).includes("/image_browser/ratings") && !gated) {
        gated = true;
        await gate;
      }
      return realFetch(url, init);
    });

    // Virtualizer hands this element a different file.
    img.setAttribute("src", "/api/view?filename=b.png&type=output");
    await settle();

    // THE ASSERTION THAT HAS TEETH: mid-flight, the row must not still be
    // claiming a.png's 5 stars. A neutral 0 is the correct placeholder.
    expect(card.querySelector(".ibs-stars").dataset.rating).not.toBe("5");

    releaseRead();
    await settle();
    await settle();

    expect(card.querySelectorAll(".ibs-stars").length).toBe(1);
    expect(card.querySelector(".ibs-stars").dataset.rating).toBe("1");
  });

  it("clicking a star writes that card's own address and repaints", async () => {
    makeCard("/api/view?filename=b.png&subfolder=2026-07&type=output");
    uninstall = installSidebarStars();
    await settle();
    await settle();

    const row = document.querySelector(".ibs-stars");
    row.querySelectorAll("[data-val]")[2].click(); // third star → 3
    await settle();

    expect(posted.length).toBe(1);
    expect(posted[0].url).toContain("/image_browser/rating");
    expect(posted[0].body).toMatchObject({
      type: "output",
      subfolder: "2026-07",
      name: "b.png",
      rating: 3,
    });
    expect(row.dataset.rating).toBe("3");
  });

  it("uninstall removes every injected row and leaves the stock card intact", async () => {
    const { card } = makeCard("/api/view?filename=a.png&type=output");
    uninstall = installSidebarStars();
    await settle();
    expect(document.querySelectorAll(".ibs-stars").length).toBe(1);

    uninstall();
    uninstall = null;
    expect(document.querySelectorAll(".ibs-stars").length).toBe(0);
    expect(card.hasAttribute("data-ibs")).toBe(false);
    expect(card.querySelector("img")).not.toBeNull();
  });

  it("addressKey separates same-named files in different roots and subfolders", () => {
    const a = { type: "output", subfolder: "", name: "x.png", absDir: "" };
    const b = { type: "input", subfolder: "", name: "x.png", absDir: "" };
    const c = { type: "output", subfolder: "sub", name: "x.png", absDir: "" };
    expect(new Set([addressKey(a), addressKey(b), addressKey(c)]).size).toBe(3);
  });
});
