// @vitest-environment jsdom
//
// Chunked grid construction: the first screenful synchronously, the rest a
// chunk per animation frame.
//
// WHAT THIS TIER CAN AND CANNOT ASSERT (see .claude/rules/modal-pack-test-tiers.md)
//
// jsdom has no layout and no renderer, so the frame loop here is a STUB: rAF is
// replaced with a queue this file steps by hand. That makes the chunk
// boundaries deterministic, which is what these tests are about — which cards
// exist at which point, which observer watches them, and what a re-render does
// to a tail that is still in flight. It is emphatically NOT a timing test.
//
// Only the browser tier can say:
//   - that the deferred build actually shortens time-to-painted-grid, or by how
//     much (the issue's 1.5 s / 89,856-node measurement is a real-install
//     figure and no jsdom assertion reproduces it);
//   - that 240 cards overfill the first screen at any density — jsdom reports
//     every offsetTop as 0, so "the first screenful" is unmeasurable here;
//   - that a chunk landing mid-scroll does not visibly jump the viewport
//     (scrollTop is inert in jsdom: it reads 0 however it is assigned, which is
//     also why reassertChunkScroll has no test in this file);
//   - that the per-chunk observer's rootMargin promotes the right thumbnails
//     against a real viewport.
// Those belong in the PR's live-smoke list.
//
// The IntersectionObserver here is a stub too — jsdom ships none, so WITHOUT
// one `installLazyMedia` returns its no-op and the observer assertions below
// would be vacuously green. The stub is the instrument, not decoration.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CHUNK_CARDS, SYNC_CARD_BUDGET } from "../../src/browser.ts";
import { openShell } from "../../src/index.ts";

/** A listing of `n` PNGs, newest first — every card gets an `img[data-src]`. */
function pngs(n, prefix = "f") {
  return Array.from({ length: n }, (_, i) => ({
    name: `${prefix}${String(i).padStart(4, "0")}.png`,
    ext: ".png",
    mtime: n - i,
    size: 10,
    width: 8,
    height: 8,
    rating: 0,
  }));
}

// ---- the frame loop, stubbed -------------------------------------------

/** Callbacks queued by the code under test, in order. */
let frameQueue;
/** Every id passed to cancelAnimationFrame, in order. */
let cancelled;
let nextFrameId;

function installFrameStub() {
  frameQueue = [];
  cancelled = [];
  nextFrameId = 1;
  vi.stubGlobal("requestAnimationFrame", (cb) => {
    const id = nextFrameId++;
    frameQueue.push({ id, cb });
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", (id) => {
    cancelled.push(id);
    const at = frameQueue.findIndex((f) => f.id === id);
    if (at !== -1) frameQueue.splice(at, 1);
  });
}

/** Run exactly the callbacks queued right now — one frame's batch. */
function flushFrame() {
  const batch = frameQueue;
  frameQueue = [];
  for (const f of batch) f.cb();
}

/** Run frames until nothing schedules another (bounded, so a bug cannot hang). */
function flushAllFrames(limit = 200) {
  let n = 0;
  while (frameQueue.length && n++ < limit) flushFrame();
  if (frameQueue.length) throw new Error(`frame queue never drained (${limit} frames)`);
  return n;
}

// ---- the lazy-thumb observer, stubbed ----------------------------------

/** Every IntersectionObserver the pack constructed, in order. */
let observers;

function installObserverStub() {
  observers = [];
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor(cb, opts) {
        this.cb = cb;
        this.opts = opts;
        this.observed = [];
        this.disconnected = false;
        observers.push(this);
      }
      observe(el) {
        this.observed.push(el);
      }
      unobserve() {}
      disconnect() {
        this.disconnected = true;
      }
    },
  );
}

// ---- the pack ----------------------------------------------------------

function stubSettings() {
  globalThis.app = {
    extensionManager: { setting: { get: () => undefined, set: () => {} } },
  };
}

function stubFetch(files) {
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
  // The modal shell queues an opening frame of ITS own (comfy-modal-kit's
  // openModalShell). Run it here, before the listing has landed, so that every
  // frame pending afterwards belongs to the pack's chunk job — the tests below
  // assert on queue contents, and a foreign frame in there would make
  // "one pending chunk" read as two.
  flushAllFrames();
  await vi.waitFor(() => {
    if (!modal.bodyEl.querySelector(".ib-card")) throw new Error("grid not rendered");
  });
  return modal;
}

const cards = (modal) => Array.from(modal.bodyEl.querySelectorAll(".ib-card.is-file"));
const names = (modal) => cards(modal).map((c) => c.dataset.name);
const search = (modal, text) => {
  modal.searchEl.value = text;
  modal.searchEl.dispatchEvent(new Event("input", { bubbles: true }));
};
const pressKey = (key) =>
  window.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));

// 700 files is three chunks at the shipped 240: a synchronous one, a whole
// deferred one, and a partial tail. Two chunks would not distinguish "the
// second chunk is the last" from "chunking stops after one frame".
const N = 700;

beforeEach(() => {
  localStorage.clear();
  document.body.innerHTML = "";
  // jsdom implements no layout and therefore no scrollIntoView; applyFocus
  // calls it on every focus move. Whether the row is centred is a browser-tier
  // question — see the header.
  Element.prototype.scrollIntoView = () => {};
  stubSettings();
  installFrameStub();
  installObserverStub();
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("chunked grid construction", () => {
  it("paints the sync budget and defers the rest, then lands every card", async () => {
    stubFetch(pngs(N));
    const modal = await open();

    // Deferred: the tail is NOT in the DOM when renderGrid returns. This is the
    // assertion the whole change exists for, and it is the one that goes red if
    // the loop is put back.
    expect(cards(modal)).toHaveLength(SYNC_CARD_BUDGET);
    expect(names(modal)).not.toContain("f0699.png");

    // ...and complete: every card arrives, in listing order, with its index
    // into the WHOLE listing intact (data-idx is what click handlers read back
    // as renderedFiles[idx] — an off-by-a-chunk there addresses another file).
    flushAllFrames();
    expect(cards(modal)).toHaveLength(N);
    expect(names(modal)).toEqual(pngs(N).map((f) => f.name));
    expect(cards(modal).map((c) => c.dataset.idx)).toEqual(
      Array.from({ length: N }, (_, i) => String(i)),
    );
  });

  it("appends one chunk per frame, not the whole tail on the first", async () => {
    stubFetch(pngs(N));
    const modal = await open();

    flushFrame();
    expect(cards(modal)).toHaveLength(SYNC_CARD_BUDGET + CHUNK_CARDS);
    flushFrame();
    expect(cards(modal)).toHaveLength(N);
    // The tail is finished: nothing is left scheduled. A job that kept
    // rescheduling past the end would wake the main thread forever.
    expect(frameQueue).toHaveLength(0);
  });

  it("does not defer a listing that fits in the sync budget", async () => {
    stubFetch(pngs(SYNC_CARD_BUDGET - 1));
    const modal = await open();
    expect(cards(modal)).toHaveLength(SYNC_CARD_BUDGET - 1);
    expect(frameQueue).toHaveLength(0);
  });
});

describe("a re-render cancels the tail in flight", () => {
  it("cancels the pending frame rather than leaving it scheduled", async () => {
    stubFetch(pngs(N));
    const modal = await open();

    // PRECONDITION, asserted rather than assumed: exactly one frame is pending,
    // and it is the chunk job's. Without this the cancellation assertion below
    // could pass against a queue that was empty for some other reason.
    expect(frameQueue).toHaveLength(1);
    const pendingId = frameQueue[0].id;
    expect(cancelled).not.toContain(pendingId);

    search(modal, "f000");

    expect(cancelled).toContain(pendingId);
    expect(frameQueue.find((f) => f.id === pendingId)).toBeUndefined();
  });

  it("a stale frame callback that still fires appends nothing", async () => {
    stubFetch(pngs(N));
    const modal = await open();

    // The race the cancel above cannot close: a callback the engine has already
    // dispatched into the batch it is running. Held here and fired by hand
    // AFTER the re-render, which is exactly that ordering.
    expect(frameQueue).toHaveLength(1);
    const stale = frameQueue[0].cb;

    // A genuinely different listing, so a stale append is identifiable by name
    // and not only by count.
    search(modal, "f069");
    const afterFilter = names(modal);
    expect(afterFilter.length).toBeGreaterThan(0);
    expect(afterFilter).not.toContain("f0250.png");

    stale();

    // NEGATIVE: the old listing's chunk did not land.
    expect(names(modal)).toEqual(afterFilter);
    expect(names(modal)).not.toContain("f0250.png");
    expect(new Set(cards(modal).map((c) => c.dataset.idx)).size).toBe(afterFilter.length);

    // POSITIVE, in the same test: the guard rejected the STALE job, not every
    // job. Clearing the filter starts a new tail and it completes normally —
    // without this arm, an implementation that simply stopped chunking after
    // any re-render would pass the negative arm above.
    search(modal, "");
    expect(cards(modal)).toHaveLength(SYNC_CARD_BUDGET);
    flushAllFrames();
    expect(cards(modal)).toHaveLength(N);
  });

  it("a re-render onto the same listing cannot duplicate a card", async () => {
    stubFetch(pngs(N));
    const modal = await open();
    const stale = frameQueue[0].cb;

    // Re-render with the SAME listing. A stale chunk here appends indices
    // 240..479 a second time — a duplicate no name-based check would catch,
    // because those names legitimately belong to this listing too.
    modal.dialog.querySelector('.ib-density-seg[data-density="dense"]').click();
    expect(cards(modal)).toHaveLength(SYNC_CARD_BUDGET);

    stale();

    expect(cards(modal)).toHaveLength(SYNC_CARD_BUDGET);
    const idx = cards(modal).map((c) => c.dataset.idx);
    expect(new Set(idx).size).toBe(idx.length);
  });
});

describe("each chunk gets its own thumbnail observer", () => {
  it("observes the new chunk's media and nothing already observed", async () => {
    stubFetch(pngs(N));
    const modal = await open();

    // The synchronous chunk. One observer, over exactly its own cards.
    expect(observers).toHaveLength(1);
    const first = observers[0];
    expect(first.observed).toHaveLength(SYNC_CARD_BUDGET);
    expect(first.observed.every((el) => el.tagName === "IMG")).toBe(true);
    const chunk0 = new Set(first.observed);

    flushFrame();

    // A NEW observer for the new chunk...
    expect(observers).toHaveLength(2);
    const second = observers[1];
    expect(second).not.toBe(first);
    expect(second.observed).toHaveLength(CHUNK_CARDS);

    // POSITIVE: it watches the cards that just landed.
    const landed = cards(modal)
      .slice(SYNC_CARD_BUDGET)
      .map((c) => c.querySelector("img"));
    expect(new Set(second.observed)).toEqual(new Set(landed));

    // NEGATIVE: and none of the previous chunk's, which is what re-observing
    // the whole grid every frame would do — two live observers holding the
    // same still-pending card.
    expect(second.observed.some((el) => chunk0.has(el))).toBe(false);

    // The root and lookahead are the chunk observer's too, not just the first
    // one's: rooting a chunk on the grid makes every card in it report as
    // intersecting at once.
    expect(second.opts.root).toBe(first.opts.root);
    expect(second.opts.rootMargin).toBe(first.opts.rootMargin);
  });

  it("disconnects every chunk observer on re-render, not just the last", async () => {
    stubFetch(pngs(N));
    const modal = await open();
    flushFrame();
    expect(observers).toHaveLength(2);
    expect(observers.every((o) => o.disconnected)).toBe(false);

    search(modal, "f000");

    // Both — an implementation keeping a single handle would leave the first
    // one live, still referencing 240 cards that no longer exist.
    expect(observers[0].disconnected).toBe(true);
    expect(observers[1].disconnected).toBe(true);
  });
});

describe("keyboard focus past the painted tail", () => {
  it("G builds the tail it needs and focuses the last card", async () => {
    stubFetch(pngs(N));
    const modal = await open();

    // The shell's opening frame put focus in the search box, and the pack's
    // keyboard nav correctly ignores keys while a text field has it. Leave the
    // field, the way a user reaching for j/k/G has.
    modal.searchEl.blur();

    // PRECONDITION: the target genuinely is not painted yet, so the assertion
    // below is about the flush and not about a card that was there anyway.
    expect(names(modal)).not.toContain("f0699.png");

    pressKey("G");

    const all = cards(modal);
    expect(all).toHaveLength(N);
    const last = all[N - 1];
    expect(last.dataset.name).toBe("f0699.png");
    expect(last.classList.contains("is-focused")).toBe(true);
    // Exactly one focused card — a flush that rebuilt rather than appended
    // would leave the ring on a stale index too.
    expect(modal.bodyEl.querySelectorAll(".ib-card.is-focused")).toHaveLength(1);
  });

  it("a deferred card is built exactly like a synchronous one", async () => {
    stubFetch(pngs(N));
    const modal = await open();
    flushAllFrames();

    const controls = (card) =>
      Array.from(card.querySelectorAll("[data-action]"))
        .map((b) => b.dataset.action)
        .sort();

    const all = cards(modal);
    const early = controls(all[0]);
    const late = controls(all[N - 1]);

    // POSITIVE: a card built three frames later carries the same controls...
    expect(late).toEqual(early);
    // ...and the set is non-empty, so an implementation that appended blank
    // divs — or one whose extracted builder lost a ctx field and emitted no
    // buttons at all — cannot satisfy the equality above vacuously.
    expect(early.length).toBeGreaterThan(0);
    expect(early).toContain("delete");
    // The thumbnail is still deferred rather than eagerly sourced: the chunk
    // observer promotes it, and a late card that shipped a live `src` would
    // fetch every thumbnail in the tail at once.
    expect(all[N - 1].querySelector("img")?.dataset.src).toBeTruthy();
    expect(all[N - 1].querySelector("img")?.getAttribute("src")).toBeNull();
  });
});
