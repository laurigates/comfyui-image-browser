// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { app } from "/scripts/app.js";
// Vitest transpiles TypeScript, so the test imports the `.ts` source directly
// (no build step). Importing the module also runs the registerExtension wiring
// against tests/js/__mocks__/app.js. The standalone modal is launched from the
// app chrome, so the meaningful smoke test is a jsdom modal-MOUNT check:
// openShell() must populate modal.bodyEl. This is exactly the empty-modal gap
// (openModalShell returns an EMPTY bodyEl you fill after opening) that passes
// pure-helper unit tests but ships a blank dialog — so it is asserted here.
// The initial fetch fires asynchronously and (harmlessly) fails under jsdom;
// the synchronous scaffold (root + toolbar tabs + grid) is what we assert on.
import {
  fetchMetadata,
  hasEmbeddedWorkflow,
  META_FIELDS,
  metaClipboardText,
  metaRows,
} from "../../src/api.ts";
import { openShell } from "../../src/index.ts";

/** Dispatch a real keydown on window (capture phase, cancelable). */
function pressKey(key) {
  window.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
}

/** Stub global fetch so /image_browser/list returns a populated output dir. */
function stubListing({ files = [], dirs = [] } = {}) {
  const fn = vi.fn(async () => ({
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
    }),
  }));
  vi.stubGlobal("fetch", fn);
  return fn;
}

const TWO_FILES = [
  { name: "a.png", ext: ".png", mtime: 2, size: 10, width: 8, height: 8, rating: 0 },
  { name: "b.png", ext: ".png", mtime: 1, size: 10, width: 8, height: 8, rating: 0 },
];

/** Open the browser and wait for the stubbed listing to render. */
async function openLoaded(modal) {
  await vi.waitFor(() => {
    if (!modal.bodyEl.querySelector(".ib-card.is-file")) throw new Error("grid not rendered");
  });
}

// The two files a recursive ("flat") /list returns: one nested under sub/deep,
// one at the top level (subpath ""). Newest-first, like the backend sorts.
const FLAT_FILES = [
  {
    name: "deep.png",
    ext: ".png",
    mtime: 3,
    size: 10,
    width: 8,
    height: 8,
    rating: 0,
    subpath: "sub/deep",
  },
  { name: "top.png", ext: ".png", mtime: 2, size: 10, width: 8, height: 8, rating: 0, subpath: "" },
];

/**
 * Fetch stub that answers /base, folder /list, recursive /list (recursive=1 →
 * FLAT_FILES with subpaths, dirs:[]), and records every call so a test can
 * assert on the request URL/body. Non-list POSTs (move/…) resolve ok:true.
 */
function recursiveListFetch(calls = []) {
  return vi.fn(async (url, init) => {
    const s = String(url);
    calls.push({ url: s, init });
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
    if (s.includes("/image_browser/list")) {
      const recursive = s.includes("recursive=1");
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          type: "output",
          subfolder: "",
          path: "/out",
          dirs: recursive ? [] : [{ name: "sub" }],
          files: recursive ? FLAT_FILES : TWO_FILES,
          exists: true,
          truncated: false,
        }),
      };
    }
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  });
}

// The mixed folder the media-type filter narrows: one still, one clip.
const MIXED_FILES = [
  { name: "a.png", ext: ".png", mtime: 2, size: 10, width: 8, height: 8, rating: 0 },
  { name: "b.mp4", ext: ".mp4", mtime: 1, size: 10, rating: 0 },
];

/**
 * Fetch stub that answers /list by honouring `kind=` the way the backend does —
 * so a test can assert the grid narrowed, not merely that a param was sent.
 * Deliberately separate from recursiveListFetch (which ~8 tests consume and
 * whose contract is already a paragraph long) rather than a second axis on it.
 */
function kindListFetch(calls = []) {
  return vi.fn(async (url, init) => {
    const s = String(url);
    calls.push({ url: s, init });
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
    if (s.includes("/image_browser/list")) {
      const kind = new URL(s, "http://x").searchParams.get("kind");
      const files = MIXED_FILES.filter(
        (f) =>
          kind === null ||
          (kind === "images" ? f.ext === ".png" : kind === "videos" ? f.ext === ".mp4" : true),
      );
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
    }
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  });
}

describe("touch multi-select affordances", () => {
  afterEach(async () => {
    vi.unstubAllGlobals();
    // Any dialog left open would leak its window key listener into later tests.
    document.querySelector(".ib-dialog")?.querySelector(".cmp-close")?.click();
    // Closing pops the back-button sentinel via history.back(); jsdom delivers
    // that popstate asynchronously and it would close the NEXT test's modal.
    // Flush it while no browser is open.
    await new Promise((r) => setTimeout(r, 20));
  });

  it("renders a selection checkbox per file card and move+delete buttons per dir card", async () => {
    stubListing({ files: TWO_FILES, dirs: [{ name: "sub" }] });
    const modal = openShell();
    await openLoaded(modal);
    expect(modal.bodyEl.querySelectorAll(".ib-card.is-file .ib-check").length).toBe(2);
    expect(modal.bodyEl.querySelectorAll(".ib-card.is-dir .ib-dir-del").length).toBe(1);
    expect(modal.bodyEl.querySelectorAll(".ib-card.is-dir .ib-dir-move").length).toBe(1);
    modal.close();
  });

  it("checkbox tap selects the card and reveals the batch action bar", async () => {
    stubListing({ files: TWO_FILES });
    const modal = openShell();
    await openLoaded(modal);
    const selBar = modal.dialog.querySelector(".ib-selbar");
    expect(selBar.classList.contains("is-visible")).toBe(false);

    modal.bodyEl.querySelector(".ib-card.is-file .ib-check").click();
    const card = modal.bodyEl.querySelector(".ib-card.is-file");
    expect(card.classList.contains("is-selected")).toBe(true);
    expect(selBar.classList.contains("is-visible")).toBe(true);
    expect(selBar.querySelector(".ib-selbar-count").textContent).toBe("1 selected");

    // Esc clears the selection and hides the bar. (The shell autofocuses its
    // search input on open; a real tap would have moved focus off it, but a
    // jsdom synthetic click does not — blur so Esc reaches the selection.)
    document.activeElement?.blur?.();
    pressKey("Escape");
    expect(selBar.classList.contains("is-visible")).toBe(false);
    expect(card.classList.contains("is-selected")).toBe(false);
    modal.close();
  });

  it("select mode makes a plain card tap toggle selection instead of opening", async () => {
    stubListing({ files: TWO_FILES });
    const opened = vi.fn();
    vi.stubGlobal("open", opened);
    const modal = openShell();
    await openLoaded(modal);

    modal.dialog.querySelector(".ib-select-toggle").click();
    expect(modal.dialog.classList.contains("is-selecting")).toBe(true);

    const cards = modal.bodyEl.querySelectorAll(".ib-card.is-file");
    cards[0].querySelector(".ib-thumb").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    cards[1].querySelector(".ib-thumb").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(opened).not.toHaveBeenCalled();
    expect(modal.bodyEl.querySelectorAll(".ib-card.is-selected").length).toBe(2);
    expect(modal.dialog.querySelector(".ib-selbar-count").textContent).toBe("2 selected");
    modal.close();
  });
});

describe("scroll memory across directory traversal", () => {
  afterEach(async () => {
    vi.unstubAllGlobals();
    document.querySelector(".ib-dialog")?.querySelector(".cmp-close")?.click();
    await new Promise((r) => setTimeout(r, 20));
  });

  /** Wait until the grid shows (or stops showing) the "up" card. */
  async function waitInSubfolder(modal, inside) {
    await vi.waitFor(() => {
      const up = modal.bodyEl.querySelector(".ib-card.is-up");
      if (inside ? !up : up) throw new Error("navigation not rendered");
    });
  }

  it("each directory keeps its own scroll position when traversing up and down", async () => {
    stubListing({ files: TWO_FILES, dirs: [{ name: "sub" }] });
    const modal = openShell();
    await openLoaded(modal);

    modal.bodyEl.scrollTop = 500;
    modal.bodyEl.querySelector(".ib-card.is-dir").click();
    await waitInSubfolder(modal, true);
    // First visit of the subfolder starts at the top.
    expect(modal.bodyEl.scrollTop).toBe(0);

    modal.bodyEl.scrollTop = 250;
    modal.bodyEl.querySelector(".ib-card.is-up").click();
    await waitInSubfolder(modal, false);
    // Back in the parent — restored to where we left it.
    expect(modal.bodyEl.scrollTop).toBe(500);

    modal.bodyEl.querySelector(".ib-card.is-dir").click();
    await waitInSubfolder(modal, true);
    // Descending again restores the subfolder's own position.
    expect(modal.bodyEl.scrollTop).toBe(250);
    modal.close();
  });
});

describe("pinned directories", () => {
  afterEach(async () => {
    vi.unstubAllGlobals();
    localStorage.clear();
    document.querySelector(".ib-dialog")?.querySelector(".cmp-close")?.click();
    await new Promise((r) => setTimeout(r, 20));
  });

  it("the toolbar 📌 pins/unpins the current folder and renders a chip row", async () => {
    stubListing({ files: TWO_FILES });
    const modal = openShell();
    await openLoaded(modal);
    const toggle = modal.dialog.querySelector(".ib-pin-toggle");
    expect(toggle).not.toBeNull();
    expect(modal.dialog.querySelector(".ib-pin-chip")).toBeNull();

    toggle.click();
    expect(toggle.classList.contains("is-active")).toBe(true);
    const chip = modal.dialog.querySelector(".ib-pin-chip .ib-pin-go");
    expect(chip.textContent).toContain("output");
    expect(JSON.parse(localStorage.getItem("comfyui-image-browser:pins"))).toEqual([
      { type: "output", subfolder: "" },
    ]);

    // Unpin via the chip's ✕.
    modal.dialog.querySelector(".ib-pin-x").click();
    expect(modal.dialog.querySelector(".ib-pin-chip")).toBeNull();
    expect(toggle.classList.contains("is-active")).toBe(false);
    modal.close();
  });

  it("a pin chip navigates to the pinned folder", async () => {
    localStorage.setItem(
      "comfyui-image-browser:pins",
      JSON.stringify([{ type: "output", subfolder: "sub" }]),
    );
    stubListing({ files: TWO_FILES, dirs: [{ name: "sub" }] });
    const modal = openShell();
    await openLoaded(modal);
    expect(modal.bodyEl.querySelector(".ib-card.is-up")).toBeNull();

    modal.dialog.querySelector(".ib-pin-go").click();
    await vi.waitFor(() => {
      if (!modal.bodyEl.querySelector(".ib-card.is-up")) throw new Error("did not navigate");
    });
    // The crumbs now show the pinned subfolder.
    const crumbs = Array.from(modal.dialog.querySelectorAll(".ib-crumbs .ib-crumb"));
    expect(crumbs.map((c) => c.textContent)).toEqual(["output", "sub"]);
    modal.close();
  });

  it("the move picker lists pinned folders as one-tap destinations", async () => {
    localStorage.setItem(
      "comfyui-image-browser:pins",
      JSON.stringify([{ type: "input", subfolder: "keep" }]),
    );
    stubListing({ files: TWO_FILES });
    const modal = openShell();
    await openLoaded(modal);

    modal.bodyEl.querySelector('[data-action="move"]').click();
    const pinRow = await vi.waitFor(() => {
      const r = modal.dialog.querySelector(".ib-move-row.is-pin");
      if (!r) throw new Error("picker pin row not rendered");
      return r;
    });
    expect(pinRow.textContent).toContain("input/keep");

    pinRow.click();
    await vi.waitFor(() => {
      const primary = modal.dialog.querySelector(".ib-move-card .cmp-ov-primary");
      if (primary?.textContent !== "Move to input/keep") throw new Error("picker did not jump");
    });
    // Cancel the picker so the modal closes cleanly.
    Array.from(modal.dialog.querySelectorAll(".ib-move-card .cmp-ov-btn"))
      .find((b) => b.textContent === "Cancel")
      .click();
    modal.close();
  });
});

describe("create folder affordance", () => {
  afterEach(async () => {
    vi.unstubAllGlobals();
    document.querySelector(".ib-dialog")?.querySelector(".cmp-close")?.click();
    await new Promise((r) => setTimeout(r, 20));
  });

  it("shows the New folder button on a sandboxed tab", async () => {
    stubListing({ files: TWO_FILES });
    const modal = openShell();
    await openLoaded(modal);
    const btn = modal.dialog.querySelector(".ib-newfolder");
    expect(btn).not.toBeNull();
    expect(btn.style.display).not.toBe("none");
    modal.close();
  });

  it("prompts for a name and POSTs /mkdir, then re-lists", async () => {
    // A fetch stub that records the /mkdir call and answers /list normally.
    const calls = [];
    const fetchFn = vi.fn(async (url, init) => {
      calls.push({ url, init });
      if (String(url).includes("/image_browser/mkdir")) {
        return { ok: true, status: 200, json: async () => ({ ok: true, name: "fresh" }) };
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
          files: TWO_FILES,
          exists: true,
        }),
      };
    });
    vi.stubGlobal("fetch", fetchFn);

    const modal = openShell();
    await openLoaded(modal);
    modal.dialog.querySelector(".ib-newfolder").click();

    // The prompt overlay is open; type a name and confirm.
    const input = await vi.waitFor(() => {
      const el = modal.dialog.querySelector(".cmp-ov-input");
      if (!el) throw new Error("prompt not rendered");
      return el;
    });
    input.value = "fresh";
    modal.dialog.querySelector(".cmp-ov-primary").click();

    const mkdir = await vi.waitFor(() => {
      const c = calls.find((x) => String(x.url).includes("/image_browser/mkdir"));
      if (!c) throw new Error("mkdir not called");
      return c;
    });
    expect(mkdir.init.method).toBe("POST");
    expect(JSON.parse(mkdir.init.body)).toEqual({
      type: "output",
      subfolder: "",
      name: "fresh",
    });
    modal.close();
  });

  it("hides the New folder button on the browse-only path tab", async () => {
    // Path-tab switch fetches /base then /list; answer both.
    const fetchFn = vi.fn(async (url) => {
      if (String(url).includes("/image_browser/base")) {
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
          type: "path",
          subfolder: "",
          path: "/",
          dirs: [],
          files: TWO_FILES,
          exists: true,
        }),
      };
    });
    vi.stubGlobal("fetch", fetchFn);
    const modal = openShell();
    await openLoaded(modal);

    modal.dialog.querySelector('.ib-tab[data-type="path"]').click();
    await vi.waitFor(() => {
      const btn = modal.dialog.querySelector(".ib-newfolder");
      if (btn.style.display !== "none") throw new Error("still visible");
    });
    modal.close();
  });
});

describe("move folder", () => {
  afterEach(async () => {
    vi.unstubAllGlobals();
    localStorage.clear();
    document.querySelector(".ib-dialog")?.querySelector(".cmp-close")?.click();
    await new Promise((r) => setTimeout(r, 20));
  });

  it("the picker hides the source folder and POSTs /move_dir to the chosen destination", async () => {
    // Records the /move_dir POST; answers /list for the grid and the picker's
    // navigation (root shows album+dest; inside dest shows nothing).
    const calls = [];
    const listResp = (subfolder, dirs, files = []) => ({
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        type: "output",
        subfolder,
        path: `/out/${subfolder}`,
        dirs,
        files,
        exists: true,
      }),
    });
    const fetchFn = vi.fn(async (url, init) => {
      calls.push({ url, init });
      const s = String(url);
      if (s.includes("/image_browser/move_dir")) {
        return { ok: true, status: 200, json: async () => ({ ok: true }) };
      }
      // Picker descends into "dest"; everything else is the root listing.
      if (s.includes("subfolder=dest")) return listResp("dest", []);
      return listResp("", [{ name: "album" }, { name: "dest" }], TWO_FILES);
    });
    vi.stubGlobal("fetch", fetchFn);

    const modal = openShell();
    await openLoaded(modal);

    // Open the picker from the "album" folder's move button.
    const albumCard = Array.from(modal.bodyEl.querySelectorAll(".ib-card.is-dir")).find(
      (c) => c.dataset.name === "album",
    );
    albumCard.querySelector(".ib-dir-move").click();

    // The picker lists "dest" but hides the source "album".
    await vi.waitFor(() => {
      const rows = Array.from(modal.dialog.querySelectorAll(".ib-move-card .ib-move-row"));
      const names = rows.map((r) => r.dataset.name).filter(Boolean);
      if (!names.includes("dest")) throw new Error("dest row missing");
      if (names.includes("album")) throw new Error("source folder not hidden");
    });

    // Descend into "dest" and confirm the move.
    Array.from(modal.dialog.querySelectorAll(".ib-move-card .ib-move-row"))
      .find((r) => r.dataset.name === "dest")
      .click();
    const primary = await vi.waitFor(() => {
      const p = modal.dialog.querySelector(".ib-move-card .cmp-ov-primary");
      if (p?.textContent !== "Move to output/dest") throw new Error("picker did not descend");
      if (p.disabled) throw new Error("move button disabled");
      return p;
    });
    primary.click();

    const move = await vi.waitFor(() => {
      const c = calls.find((x) => String(x.url).includes("/image_browser/move_dir"));
      if (!c) throw new Error("move_dir not called");
      return c;
    });
    expect(move.init.method).toBe("POST");
    expect(JSON.parse(move.init.body)).toEqual({
      type: "output",
      subfolder: "",
      name: "album",
      dest_type: "output",
      dest_subfolder: "dest",
    });
    modal.close();
  });

  it("a merge with file conflicts keeps the source folder and surfaces the count", async () => {
    // /move_dir merges into a same-named folder but reports a colliding file;
    // the source folder is left behind, so it must remain in the grid after the
    // handler re-lists (unlike a clean move, which removes the card).
    const listResp = (subfolder, dirs, files = []) => ({
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        type: "output",
        subfolder,
        path: `/out/${subfolder}`,
        dirs,
        files,
        exists: true,
      }),
    });
    const fetchFn = vi.fn(async (url) => {
      const s = String(url);
      if (s.includes("/image_browser/move_dir")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ok: true,
            merged: true,
            errors: [{ name: "clash.png", error: "already exists at the destination" }],
          }),
        };
      }
      if (s.includes("subfolder=dest")) return listResp("dest", []);
      // The source "album" is still present after the merge (it kept the conflict).
      return listResp("", [{ name: "album" }, { name: "dest" }], TWO_FILES);
    });
    vi.stubGlobal("fetch", fetchFn);

    const modal = openShell();
    await openLoaded(modal);

    Array.from(modal.bodyEl.querySelectorAll(".ib-card.is-dir"))
      .find((c) => c.dataset.name === "album")
      .querySelector(".ib-dir-move")
      .click();

    const destRow = await vi.waitFor(() => {
      const r = Array.from(modal.dialog.querySelectorAll(".ib-move-card .ib-move-row")).find(
        (row) => row.dataset.name === "dest",
      );
      if (!r) throw new Error("dest row missing");
      return r;
    });
    destRow.click();
    const primary = await vi.waitFor(() => {
      const p = modal.dialog.querySelector(".ib-move-card .cmp-ov-primary");
      if (p?.textContent !== "Move to output/dest") throw new Error("picker did not descend");
      return p;
    });
    primary.click();

    // The source folder survives the merge (conflict left in place) and a toast
    // reports the leftover count.
    await vi.waitFor(() => {
      const stillThere = Array.from(modal.bodyEl.querySelectorAll(".ib-card.is-dir")).some(
        (c) => c.dataset.name === "album",
      );
      if (!stillThere) throw new Error("source folder was removed despite the conflict");
      if (!document.body.textContent.includes("left in place")) {
        throw new Error("conflict count not surfaced");
      }
    });
    modal.close();
  });
});

describe("flat (recursive) view", () => {
  afterEach(async () => {
    vi.unstubAllGlobals();
    localStorage.clear();
    document.querySelector(".ib-dialog")?.querySelector(".cmp-close")?.click();
    await new Promise((r) => setTimeout(r, 20));
  });

  it("the flat toggle re-fetches with recursive=1 and labels each card with its subpath", async () => {
    const calls = [];
    vi.stubGlobal("fetch", recursiveListFetch(calls));
    const modal = openShell();
    await openLoaded(modal);
    // Folder view first — no subpath labels.
    expect(modal.bodyEl.querySelector(".ib-subpath")).toBeNull();

    modal.dialog.querySelector(".ib-view-toggle").click();
    await vi.waitFor(() => {
      if (!modal.bodyEl.querySelector(".ib-subpath")) throw new Error("no subpath label");
    });
    // A recursive listing was requested.
    expect(calls.some((c) => c.url.includes("recursive=1"))).toBe(true);
    // The nested file shows its folder as a clickable label carrying the full
    // effective subfolder in data-sub (for the jump-to-folder affordance).
    const label = Array.from(modal.bodyEl.querySelectorAll(".ib-subpath")).find(
      (e) => e.textContent === "sub/deep",
    );
    expect(label).toBeTruthy();
    expect(label.dataset.sub).toBe("sub/deep");
    // The toggle reads as engaged.
    expect(modal.dialog.querySelector(".ib-view-toggle").classList.contains("is-active")).toBe(
      true,
    );
    modal.close();
  });

  it("tapping a subpath label drops back to folder view at that directory", async () => {
    localStorage.setItem("comfyui-image-browser:view", "flat");
    vi.stubGlobal("fetch", recursiveListFetch());
    const modal = openShell();
    await openLoaded(modal);

    const label = await vi.waitFor(() => {
      const e = Array.from(modal.bodyEl.querySelectorAll(".ib-subpath")).find(
        (x) => x.textContent === "sub/deep",
      );
      if (!e) throw new Error("subpath label not rendered");
      return e;
    });
    label.click();
    // Folder view at output/sub/deep — crumbs reflect the descent, labels gone.
    await vi.waitFor(() => {
      const crumbs = Array.from(modal.dialog.querySelectorAll(".ib-crumbs .ib-crumb")).map(
        (c) => c.textContent,
      );
      if (crumbs.join("/") !== "output/sub/deep") throw new Error(`crumbs: ${crumbs}`);
      if (modal.bodyEl.querySelector(".ib-subpath")) throw new Error("still in flat view");
    });
    modal.close();
  });

  it("a flat-view card's move sends the file's real (nested) subfolder", async () => {
    localStorage.setItem("comfyui-image-browser:view", "flat");
    localStorage.setItem(
      "comfyui-image-browser:pins",
      JSON.stringify([{ type: "input", subfolder: "keep" }]),
    );
    const calls = [];
    vi.stubGlobal("fetch", recursiveListFetch(calls));
    const modal = openShell();
    await openLoaded(modal);

    const deepCard = await vi.waitFor(() => {
      const c = Array.from(modal.bodyEl.querySelectorAll(".ib-card.is-file")).find(
        (card) => card.querySelector(".ib-subpath")?.textContent === "sub/deep",
      );
      if (!c) throw new Error("deep card not rendered");
      return c;
    });
    deepCard.querySelector('[data-action="move"]').click();

    const pinRow = await vi.waitFor(() => {
      const r = modal.dialog.querySelector(".ib-move-row.is-pin");
      if (!r) throw new Error("pin row missing");
      return r;
    });
    pinRow.click();
    const primary = await vi.waitFor(() => {
      const p = modal.dialog.querySelector(".ib-move-card .cmp-ov-primary");
      if (p?.textContent !== "Move to input/keep") throw new Error("picker did not jump");
      return p;
    });
    primary.click();

    const move = await vi.waitFor(() => {
      const c = calls.find(
        (x) => x.url.includes("/image_browser/move") && !x.url.includes("move_"),
      );
      if (!c) throw new Error("move not called");
      return c;
    });
    expect(JSON.parse(move.init.body)).toEqual({
      type: "output",
      subfolder: "sub/deep",
      name: "deep.png",
      dest_type: "input",
      dest_subfolder: "keep",
    });
    modal.close();
  });

  it("hides the flat toggle on the browse-only path tab", async () => {
    localStorage.setItem("comfyui-image-browser:view", "flat");
    vi.stubGlobal("fetch", recursiveListFetch());
    const modal = openShell();
    await openLoaded(modal);
    expect(modal.dialog.querySelector(".ib-view-toggle").style.display).not.toBe("none");

    modal.dialog.querySelector('.ib-tab[data-type="path"]').click();
    await vi.waitFor(() => {
      if (modal.dialog.querySelector(".ib-view-toggle").style.display !== "none") {
        throw new Error("flat toggle still visible on path tab");
      }
      // Path tab is never recursive even with the flat preference set.
      if (modal.bodyEl.querySelector(".ib-subpath")) throw new Error("flat labels on path tab");
    });
    modal.close();
  });

  // A flat listing is thousands of cards. If the lazy-thumb observer's root is
  // the grid — which has no overflow clip — the root rectangle is the grid's
  // whole bounding box, so EVERY card reports as intersecting on the first
  // callback and every thumbnail (plus a <video> per clip) loads at once,
  // OOM-ing the tab. The root must be the scrolling ancestor, .cmp-body.
  it("observes thumbnails against the scroll container, not the grid", async () => {
    const roots = [];
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        constructor(_cb, opts) {
          roots.push(opts?.root);
        }
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    stubListing({ files: TWO_FILES });
    const modal = openShell();
    await openLoaded(modal);
    expect(roots.length).toBeGreaterThan(0);
    for (const root of roots) {
      expect(root).toBe(modal.bodyEl);
      expect(root.classList.contains("cmp-body")).toBe(true);
      expect(root.classList.contains("ib-grid")).toBe(false);
    }
    modal.close();
  });

  // The view preference persists, so a flat load heavy enough to kill the tab
  // would reopen straight into the same failure with the toggle unreachable.
  // The pending breadcrumb makes that state self-healing.
  it("recovers to folder view when the previous flat load never finished", async () => {
    localStorage.setItem("comfyui-image-browser:view", "flat");
    localStorage.setItem("comfyui-image-browser:view-pending", "1");
    const calls = [];
    vi.stubGlobal("fetch", recursiveListFetch(calls));
    const modal = openShell();
    await openLoaded(modal);
    const lists = calls.filter((c) => c.url.includes("/image_browser/list"));
    expect(lists.length).toBeGreaterThan(0);
    // Recovered: the reopen listed the folder, not the whole subtree.
    expect(lists.every((c) => !c.url.includes("recursive=1"))).toBe(true);
    expect(modal.bodyEl.querySelector(".ib-subpath")).toBeNull();
    // Both the breadcrumb and the poisoned preference are cleared, so the next
    // open is a normal folder-view open and the toggle is reachable again.
    expect(localStorage.getItem("comfyui-image-browser:view-pending")).toBeNull();
    expect(localStorage.getItem("comfyui-image-browser:view")).toBe("folder");
    modal.close();
  });

  // The other half of the contract: a flat load that DOES complete must clear
  // the breadcrumb, or every subsequent open would falsely "recover".
  it("clears the pending breadcrumb once the flat grid has rendered", async () => {
    vi.stubGlobal("fetch", recursiveListFetch());
    const modal = openShell();
    await openLoaded(modal);
    modal.dialog.querySelector(".ib-view-toggle").click();
    await vi.waitFor(() => {
      if (!modal.bodyEl.querySelector(".ib-subpath")) throw new Error("no subpath label");
    });
    expect(localStorage.getItem("comfyui-image-browser:view-pending")).toBeNull();
    expect(localStorage.getItem("comfyui-image-browser:view")).toBe("flat");
    modal.close();
  });
});

describe("media-type filter", () => {
  afterEach(async () => {
    vi.unstubAllGlobals();
    localStorage.clear();
    document.querySelector(".ib-dialog")?.querySelector(".cmp-close")?.click();
    await new Promise((r) => setTimeout(r, 20));
  });

  // The load-bearing test for the whole feature: the narrowing must happen on
  // the SERVER, above the backend's mtime sort and 5000-file cap. Asserting
  // both the request param and the resulting grid makes it fail two ways — if
  // the param is dropped, and if the handler re-slices the already-fetched list
  // (renderGrid) instead of re-fetching (loadAndRender), which would issue no
  // second request at all.
  it("re-fetches the listing with kind=videos rather than filtering client-side", async () => {
    const calls = [];
    vi.stubGlobal("fetch", kindListFetch(calls));
    const modal = openShell();
    await openLoaded(modal);
    expect(modal.bodyEl.querySelectorAll(".ib-card.is-file").length).toBe(2);
    const before = calls.filter((c) => c.url.includes("/image_browser/list")).length;

    modal.dialog.querySelector('.ib-filter-seg[data-filter="videos"]').click();
    await vi.waitFor(() => {
      const cards = modal.bodyEl.querySelectorAll(".ib-card.is-file");
      if (cards.length !== 1) throw new Error(`expected 1 card, got ${cards.length}`);
    });
    const listCalls = calls.filter((c) => c.url.includes("/image_browser/list"));
    expect(listCalls.length).toBeGreaterThan(before);
    expect(listCalls.at(-1).url).toContain("kind=videos");
    expect(modal.bodyEl.querySelector(".ib-name").textContent).toContain("b.mp4");
    expect(
      modal.dialog
        .querySelector('.ib-filter-seg[data-filter="videos"]')
        .classList.contains("is-active"),
    ).toBe(true);
    modal.close();
  });

  // The filter is NOT a sandboxed-root affordance (unlike flat view), so it has
  // to reach the path branch of fetchListing too — the branch that already
  // drops `recursive`. Setting the param inside the branches instead of after
  // them reproduces exactly that bug, and this is what catches it.
  it("sends kind on the browse…/path tab, whose request is built by a separate branch", async () => {
    const calls = [];
    vi.stubGlobal("fetch", kindListFetch(calls));
    const modal = openShell();
    await openLoaded(modal);

    modal.dialog.querySelector('.ib-tab[data-type="path"]').click();
    await vi.waitFor(() => {
      if (!calls.some((c) => c.url.includes("type=path"))) throw new Error("no path listing");
    });
    modal.dialog.querySelector('.ib-filter-seg[data-filter="videos"]').click();
    // Wait on the RENDER, not on the recorded request: `calls` is appended at
    // request time, so a waitFor on the URL alone would return one tick before
    // the response repainted the grid and the card assertion would race it.
    await vi.waitFor(() => {
      const cards = modal.bodyEl.querySelectorAll(".ib-card.is-file");
      if (cards.length !== 1) throw new Error(`expected 1 card, got ${cards.length}`);
    });
    const pathCalls = calls.filter(
      (c) => c.url.includes("/image_browser/list") && c.url.includes("type=path"),
    );
    expect(pathCalls.some((c) => c.url.includes("kind=videos"))).toBe(true);
    modal.close();
  });

  it("persists the choice and applies it to the first request of the next session", async () => {
    const calls = [];
    vi.stubGlobal("fetch", kindListFetch(calls));
    const modal = openShell();
    await openLoaded(modal);
    modal.dialog.querySelector('.ib-filter-seg[data-filter="images"]').click();
    await vi.waitFor(() => {
      if (!calls.at(-1).url.includes("kind=images")) throw new Error("not requested yet");
    });
    expect(localStorage.getItem("comfyui-image-browser:filter")).toBe("images");
    modal.close();
    await new Promise((r) => setTimeout(r, 20));

    // Reopen: the very FIRST listing must already carry the filter, and the
    // segment must read as engaged before any interaction.
    const reopened = [];
    vi.stubGlobal("fetch", kindListFetch(reopened));
    const modal2 = openShell();
    await openLoaded(modal2);
    expect(reopened[0].url).toContain("kind=images");
    expect(
      modal2.dialog
        .querySelector('.ib-filter-seg[data-filter="images"]')
        .classList.contains("is-active"),
    ).toBe(true);
    modal2.close();
  });

  it("ignores a stored value outside the whitelist instead of sending it", async () => {
    // A hand-edited or stale key must not reach the backend as an unknown kind
    // — the whitelist-on-read is what makes the lenient server-side handling of
    // a bad `kind` unreachable from our own UI.
    localStorage.setItem("comfyui-image-browser:filter", "movies");
    const calls = [];
    vi.stubGlobal("fetch", kindListFetch(calls));
    const modal = openShell();
    await openLoaded(modal);
    expect(calls[0].url).not.toContain("kind=");
    expect(modal.bodyEl.querySelectorAll(".ib-card.is-file").length).toBe(2);
    expect(
      modal.dialog
        .querySelector('.ib-filter-seg[data-filter="all"]')
        .classList.contains("is-active"),
    ).toBe(true);
    modal.close();
  });
});

describe("image metadata helpers", () => {
  it("emits META_FIELDS order regardless of the response's own key order", () => {
    // The backend serialises in parser order, which differs between the ComfyUI
    // graph walk and the A1111 block — display order must come from META_FIELDS.
    const rows = metaRows({
      scheduler: "karras",
      seed: "42",
      positive: "a cat",
      model: "sd15.safetensors",
    });
    expect(rows.map((r) => r.key)).toEqual(["positive", "model", "seed", "scheduler"]);
    const order = META_FIELDS.map((f) => f.key);
    for (let i = 1; i < rows.length; i++) {
      expect(order.indexOf(rows[i].key)).toBeGreaterThan(order.indexOf(rows[i - 1].key));
    }
  });

  it("omits absent keys — an unknown field is never rendered", () => {
    const rows = metaRows({ seed: "1" });
    expect(rows).toEqual([{ key: "seed", label: "Seed", value: "1" }]);
  });

  it("drops empty and whitespace-only values (never a bare 'Negative:' row)", () => {
    expect(metaRows({ positive: "cat", negative: "", steps: "   " })).toEqual([
      { key: "positive", label: "Positive", value: "cat" },
    ]);
  });

  it("coerces non-string values and survives null/undefined/empty input", () => {
    expect(metaRows({ steps: 20, cfg: 7.5 }).map((r) => r.value)).toEqual(["20", "7.5"]);
    expect(metaRows(null)).toEqual([]);
    expect(metaRows(undefined)).toEqual([]);
    expect(metaRows({})).toEqual([]);
  });

  it("hasEmbeddedWorkflow accepts either raw graph key, preferring neither", () => {
    expect(hasEmbeddedWorkflow({ raw: { workflow: '{"nodes":[]}' } })).toBe(true);
    // prompt-only images (saved by a node that omits the UI graph) still load —
    // ComfyUI reconstructs a graph from the API format.
    expect(hasEmbeddedWorkflow({ raw: { prompt: '{"1":{}}' } })).toBe(true);
    expect(hasEmbeddedWorkflow({ raw: { parameters: "steps: 20" } })).toBe(false);
  });

  it("hasEmbeddedWorkflow treats empty-but-present keys as absent", () => {
    // Some writers emit the key with nothing in it. A truthiness check alone
    // would light the button and then produce no graph, which reads as a bug.
    for (const v of ["", "   ", "null", "{}", "[]"]) {
      expect(hasEmbeddedWorkflow({ raw: { workflow: v } })).toBe(false);
    }
    expect(hasEmbeddedWorkflow({ raw: { workflow: 42 } })).toBe(false);
  });

  it("hasEmbeddedWorkflow survives null/undefined/empty metadata", () => {
    expect(hasEmbeddedWorkflow(null)).toBe(false);
    expect(hasEmbeddedWorkflow(undefined)).toBe(false);
    expect(hasEmbeddedWorkflow({})).toBe(false);
    expect(hasEmbeddedWorkflow({ raw: {} })).toBe(false);
  });

  it("metaClipboardText joins 'Label: value' and keeps a multi-line prompt verbatim", () => {
    const rows = metaRows({ positive: "line one\nline two", seed: "5" });
    expect(metaClipboardText(rows)).toBe("Positive: line one\nline two\nSeed: 5");
    expect(metaClipboardText([])).toBe("");
  });

  it("addresses /metadata like /thumb — type=path switches to an absolute path", async () => {
    const calls = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url) => {
        calls.push(String(url));
        return { ok: true, status: 200, json: async () => ({ ok: true, source: "none" }) };
      }),
    );
    await fetchMetadata("output", "sub", "a.png", "/ignored");
    expect(calls[0]).toBe("/image_browser/metadata?type=output&subfolder=sub&name=a.png");
    await fetchMetadata("path", "", "a.png", "/abs/dir");
    expect(calls[1]).toBe("/image_browser/metadata?path=%2Fabs%2Fdir%2Fa.png");
    vi.unstubAllGlobals();
  });

  it("surfaces the backend's error message from a 4xx body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 400,
        json: async () => ({ ok: false, error: "unsupported file type" }),
      })),
    );
    await expect(fetchMetadata("output", "", "a.mp4", "/")).rejects.toThrow(
      "unsupported file type",
    );
    vi.unstubAllGlobals();
  });
});

describe("metadata overlay", () => {
  // The kit's toast stack is a body-level singleton that outlives a test, and
  // two of these tests assert on toast presence/absence — start from a clean one.
  beforeEach(() => {
    document.getElementById("cmn-notify-container")?.remove();
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    document.querySelector(".ib-dialog")?.querySelector(".cmp-close")?.click();
    await new Promise((r) => setTimeout(r, 20));
  });

  /** /list + /metadata fetch stub; `meta` is the /metadata response body. */
  function metadataFetch(meta, type = "output") {
    return vi.fn(async (url) => {
      const s = String(url);
      if (s.includes("/image_browser/metadata")) {
        return { ok: true, status: 200, json: async () => ({ ok: true, ...meta }) };
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
          type,
          subfolder: "",
          path: "/out",
          dirs: [],
          files: TWO_FILES,
          exists: true,
        }),
      };
    });
  }

  const COMFY_META = {
    format: "png",
    source: "comfyui",
    summary: {
      positive: "a cat",
      negative: "blurry",
      seed: "42",
      steps: "20",
      cfg: "8",
      sampler: "euler",
      scheduler: "normal",
      model: "sd15.safetensors",
    },
    raw: { prompt: '{"1": {}}' },
    truncated: false,
  };

  it("'i' on the focused card opens the overlay with a Copy per field and no toast", async () => {
    vi.stubGlobal("fetch", metadataFetch(COMFY_META));
    const modal = openShell();
    await openLoaded(modal);
    // The shell autofocuses its search input; a real tap would have moved focus
    // off it, but a jsdom synthetic click does not — blur so 'i' reaches the grid.
    document.activeElement?.blur?.();
    pressKey("i");

    const card = await vi.waitFor(() => {
      const c = modal.dialog.querySelector(".ib-meta-card .ib-meta-row");
      if (!c) throw new Error("metadata overlay not rendered");
      return modal.dialog.querySelector(".ib-meta-card");
    });
    // One row (and one Copy) per known field, in META_FIELDS order.
    const labels = Array.from(card.querySelectorAll(".ib-meta-k")).map((e) => e.textContent);
    expect(labels).toEqual([
      "Positive",
      "Negative",
      "Model",
      "Seed",
      "Steps",
      "CFG",
      "Sampler",
      "Scheduler",
    ]);
    expect(card.querySelectorAll(".ib-meta-row .ib-meta-copy").length).toBe(8);
    expect(card.querySelector(".ib-meta-src").textContent).toContain("ComfyUI");
    expect(card.querySelector("[data-copy-all]")).not.toBeNull();
    // The raw disclosure is present but collapsed.
    expect(card.querySelector("details.ib-meta-raw")?.hasAttribute("open")).toBe(false);
    // No notify() toast: a toast over an open overlay parks its ✕ on the shell's.
    expect(document.querySelector(".cmn-toast")).toBeNull();
    modal.close();
  });

  it("a per-field Copy button writes the value and flips its label to 'Copied ✓'", async () => {
    const writes = [];
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: async (t) => void writes.push(t) },
      configurable: true,
    });
    vi.stubGlobal("fetch", metadataFetch(COMFY_META));
    const modal = openShell();
    await openLoaded(modal);
    modal.bodyEl.querySelector('[data-action="meta"]').click();

    const btn = await vi.waitFor(() => {
      const b = modal.dialog.querySelector('[data-copy-row="0"]');
      if (!b) throw new Error("copy button not rendered");
      return b;
    });
    btn.click();
    await vi.waitFor(() => {
      if (btn.textContent !== "Copied ✓") throw new Error(`label: ${btn.textContent}`);
    });
    expect(writes).toEqual(["a cat"]);

    // Copy all joins the whole summary.
    modal.dialog.querySelector("[data-copy-all]").click();
    await vi.waitFor(() => {
      if (writes.length < 2) throw new Error("copy-all did not write");
    });
    expect(writes[1]).toContain("Seed: 42");
    expect(writes[1].split("\n")[0]).toBe("Positive: a cat");
    modal.close();
  });

  // Regression: the feedback label must be restored from the button's REAL label,
  // not from whatever it happened to read at click time. A second click inside
  // the 1500 ms window used to capture the transient label as the restore target,
  // latching it forever — and in the fail-then-succeed order it settled on "Copy
  // failed" after a copy that WORKED, telling the user the opposite of the truth
  // about their clipboard.
  it("a second Copy click inside the feedback window still restores 'Copy' and reports the last outcome", async () => {
    let succeed = false;
    Object.defineProperty(navigator, "clipboard", {
      // Rejecting sends copyTextToClipboard down its execCommand fallback, which
      // jsdom does not implement — so the whole call answers false.
      value: {
        writeText: async () => {
          if (!succeed) throw new Error("clipboard denied");
        },
      },
      configurable: true,
    });
    vi.stubGlobal("fetch", metadataFetch(COMFY_META));
    const modal = openShell();
    await openLoaded(modal);
    modal.bodyEl.querySelector('[data-action="meta"]').click();
    const btn = await vi.waitFor(() => {
      const b = modal.dialog.querySelector('[data-copy-row="0"]');
      if (!b) throw new Error("copy button not rendered");
      return b;
    });

    // Fake timers only from here: the 1500 ms restore is the thing under test,
    // and the two clicks have to land at a known offset from each other.
    vi.useFakeTimers();
    try {
      btn.click();
      await vi.advanceTimersByTimeAsync(0);
      expect(btn.textContent).toBe("Copy failed");
      // Second click at t+500, i.e. while "Copy failed" is still painted.
      succeed = true;
      await vi.advanceTimersByTimeAsync(500);
      btn.click();
      await vi.advanceTimersByTimeAsync(0);
      expect(btn.textContent).toBe("Copied ✓");
      // Well past both clicks' windows: the button is back to its real label,
      // never parked on a stale "Copy failed" / "Copied ✓".
      await vi.advanceTimersByTimeAsync(3600);
      expect(btn.textContent).toBe("Copy");
      expect(btn.classList.contains("is-copied")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
    modal.close();
  });

  it("shows the empty state (no rows, no raw disclosure) when nothing was found", async () => {
    vi.stubGlobal("fetch", metadataFetch({ format: "", source: "none", summary: {}, raw: {} }));
    const modal = openShell();
    await openLoaded(modal);
    modal.bodyEl.querySelector('[data-action="meta"]').click();

    const empty = await vi.waitFor(() => {
      const e = modal.dialog.querySelector(".ib-meta-card .ib-meta-empty");
      if (!e) throw new Error("empty state not rendered");
      return e;
    });
    expect(empty.textContent).toContain("No generation metadata found");
    const card = modal.dialog.querySelector(".ib-meta-card");
    expect(card.querySelectorAll(".ib-meta-row").length).toBe(0);
    expect(card.querySelector("details.ib-meta-raw")).toBeNull();
    expect(card.querySelector("[data-copy-all]")).toBeNull();
    modal.close();
  });

  // Metadata is a READ — /metadata accepts type=path — so ⓘ is the one card
  // control deliberately outside the canWrite mirror. It IS gated on image-ness.
  it("renders ⓘ on a path-tab card while the write buttons stay absent", async () => {
    vi.stubGlobal("fetch", metadataFetch(COMFY_META, "path"));
    const modal = openShell();
    await openLoaded(modal);
    modal.dialog.querySelector('.ib-tab[data-type="path"]').click();
    await vi.waitFor(() => {
      if (modal.dialog.querySelector(".ib-view-toggle").style.display !== "none") {
        throw new Error("still on a sandboxed tab");
      }
    });
    const card = modal.bodyEl.querySelector(".ib-card.is-file");
    expect(card.querySelector('[data-action="meta"]')).not.toBeNull();
    for (const action of ["rename", "move", "delete"]) {
      expect(card.querySelector(`[data-action="${action}"]`)).toBeNull();
    }
    modal.close();
  });

  // The ⓘ / ⤓ gate is META_EXTS, not IMG_EXTS: the backend reads embedded
  // metadata out of ISOBMFF (MP4/MOV/M4V) and Matroska (WebM/MKV) containers
  // too, so those cards carry the same two read controls an image does.
  const listingOf = (files) =>
    vi.fn(async () => ({
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
      }),
    }));

  it("renders ⓘ and ⤓ on video cards whose container the backend can read", async () => {
    vi.stubGlobal(
      "fetch",
      listingOf([
        { name: "clip.mp4", ext: ".mp4", mtime: 3, size: 10 },
        { name: "clip.webm", ext: ".webm", mtime: 2, size: 10 },
        { name: "clip.mkv", ext: ".mkv", mtime: 1, size: 10 },
      ]),
    );
    const modal = openShell();
    await openLoaded(modal);
    const cards = [...modal.bodyEl.querySelectorAll(".ib-card.is-file")];
    expect(cards.map((c) => c.dataset.ext)).toEqual([".mp4", ".webm", ".mkv"]);
    for (const card of cards) {
      expect(card.querySelector('[data-action="meta"]')).not.toBeNull();
      expect(card.querySelector('[data-action="workflow"]')).not.toBeNull();
    }
    modal.close();
  });

  it("loads a video's workflow as JSON, never by handing the video to handleFile", async () => {
    // The load-bearing assertion of the video ⤓ path. ComfyUI's own
    // getWorkflowDataFromFile() reads only the mdta `keys`+`ilst` MP4 layout;
    // for a container it cannot read (kijai's bare `©cmt` atom), handleFile's
    // no-workflow branch PASTES A LoadVideo NODE instead of erroring. Handing
    // it the video bytes is therefore silently wrong for a large share of real
    // files, so the pack hands over the graph the BACKEND parsed instead.
    const graph = JSON.stringify({ nodes: [{ id: 1, type: "KSampler" }] });
    const fetchFn = vi.fn(async (url) => {
      const s = String(url);
      if (s.includes("/image_browser/metadata")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ok: true,
            format: "mp4",
            source: "comfyui",
            raw: { workflow: graph },
          }),
        };
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
          files: [{ name: "clip.mp4", ext: ".mp4", mtime: 3, size: 10 }],
          exists: true,
        }),
      };
    });
    vi.stubGlobal("fetch", fetchFn);
    app.handleFileCalls.length = 0;
    const modal = openShell();
    await openLoaded(modal);
    modal.bodyEl.querySelector('[data-action="workflow"]').click();
    await vi.waitFor(() => {
      if (app.handleFileCalls.length === 0) throw new Error("handleFile not called");
    });

    const file = app.handleFileCalls[0];
    expect(file.type).toBe("application/json");
    // Named after the video with its extension REPLACED, so the workflow tab
    // reads "clip" rather than "clip.mp4".
    expect(file.name).toBe("clip.json");
    expect(await file.text()).toBe(graph);
    // Nothing fetched the video's BYTES — that is the difference between this
    // path and the image one, which downloads the full file to re-parse it.
    // Matched on the byte-serving routes (/api/view, /image_browser/file), not
    // on the filename: the /metadata request names the file too, so a bare
    // "no URL mentions clip.mp4" assertion fails against correct code.
    const byteFetches = fetchFn.mock.calls.filter(([u]) => {
      const s = String(u);
      return s.includes("/api/view") || s.includes("/image_browser/file");
    });
    expect(byteFetches).toEqual([]);
    modal.close();
  });

  it("still withholds ⓘ and ⤓ from a container with no reader (.avi)", async () => {
    // .avi is in VIDEO_EXTS — it lists, previews and deletes like any video —
    // but image_meta has no reader for it, so /metadata answers 400. A button
    // here would be a control that fails on tap, which is the whole reason the
    // gate mirrors the backend rather than "is it a video".
    vi.stubGlobal("fetch", listingOf([{ name: "clip.avi", ext: ".avi", mtime: 3, size: 10 }]));
    const modal = openShell();
    await openLoaded(modal);
    const card = modal.bodyEl.querySelector(".ib-card.is-file");
    expect(card.dataset.ext).toBe(".avi");
    expect(card.querySelector('[data-action="meta"]')).toBeNull();
    expect(card.querySelector('[data-action="workflow"]')).toBeNull();
    // The open (↗) button is still there — only the two read affordances are gated.
    expect(card.querySelector('[data-action="open"]')).not.toBeNull();
    modal.close();
  });

  it("closes the overlay and raises a copyable toast when the read fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url) => {
        if (String(url).includes("/image_browser/metadata")) {
          return { ok: false, status: 500, json: async () => ({ ok: false, error: "boom" }) };
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
            files: TWO_FILES,
            exists: true,
          }),
        };
      }),
    );
    const modal = openShell();
    await openLoaded(modal);
    modal.bodyEl.querySelector('[data-action="meta"]').click();

    await vi.waitFor(() => {
      const toasts = Array.from(document.querySelectorAll(".cmn-toast"));
      if (!toasts.length) throw new Error("no error toast");
      if (!toasts.some((t) => t.textContent.includes("boom"))) {
        throw new Error("toast lacks the reason");
      }
    });
    // The overlay closed FIRST, so the toast is not sitting on top of it.
    expect(modal.dialog.querySelector(".ib-meta-card")).toBeNull();
    expect(document.querySelector(".ib-dialog")).not.toBeNull();
    modal.close();
  });
});

describe("comfyui-image-browser standalone modal", () => {
  it("mounts the full-canvas browser scaffold into the modal shell", () => {
    const modal = openShell();
    expect(modal.bodyEl).toBeTruthy();
    // The root container the browser fills.
    expect(modal.bodyEl.querySelector(".image-browser-body")).not.toBeNull();
    // The card grid is mounted synchronously (populated after the async fetch).
    expect(modal.bodyEl.querySelector(".ib-grid")).not.toBeNull();
    // Toolbar tabs for the sandboxed roots + arbitrary path mode. This query is
    // dialog-wide, so the count only means "four root tabs" as long as nothing
    // else wears .ib-tab — the media-type filter segments share the tabs' CSS
    // through a comma selector precisely so they don't have to wear the class.
    const tabs = modal.dialog.querySelectorAll(".ib-tab");
    expect(tabs.length).toBe(4);
    expect(modal.dialog.querySelectorAll(".ib-filter-seg").length).toBe(3);
    // The flat-view toggle is part of the toolbar scaffold.
    expect(modal.dialog.querySelector(".ib-view-toggle")).not.toBeNull();
    modal.close();
  });

  it("opens the keyboard help overlay on '?'", () => {
    const modal = openShell();
    pressKey("?");
    // The help overlay card is rendered inside the dialog.
    const helpCard = modal.dialog.querySelector(".ib-help-card");
    expect(helpCard).not.toBeNull();
    // The help body has the Navigate/Select/Act/Other columns.
    const cols = helpCard.querySelectorAll(".ib-help-col");
    expect(cols.length).toBe(4);
    modal.close();
  });

  it("renders a selected-count badge in the header", () => {
    const modal = openShell();
    // The badge exists in the header even before any selection (hidden).
    const badge = modal.headerEl.querySelector(".ib-selected-badge");
    expect(badge).not.toBeNull();
    expect(badge.style.display).toBe("none");
    modal.close();
  });

  it("back button (popstate) closes the browser when already at a root", () => {
    const modal = openShell();
    expect(document.querySelector(".ib-dialog")).not.toBeNull();
    // Opens at output root (no subfolder) — back has nowhere to ascend, so it
    // closes the browser instead of leaving the page.
    window.dispatchEvent(new PopStateEvent("popstate"));
    expect(document.querySelector(".ib-dialog")).toBeNull();
    expect(modal.dialog.isConnected).toBe(false);
  });

  it("back button dismisses an open overlay instead of closing the browser", () => {
    const modal = openShell();
    pressKey("?");
    expect(modal.dialog.querySelector(".ib-help-card")).not.toBeNull();
    window.dispatchEvent(new PopStateEvent("popstate"));
    // The overlay is gone but the browser survived the back press.
    expect(modal.dialog.querySelector(".cmp-ov-backdrop")).toBeNull();
    expect(document.querySelector(".ib-dialog")).not.toBeNull();
    modal.close();
  });

  it("removes the global key listener when closed via the shell's real path", () => {
    const modal = openShell();
    // While open, '?' is intercepted (preventDefault) to open the help overlay.
    const openEv = new KeyboardEvent("keydown", { key: "?", cancelable: true });
    window.dispatchEvent(openEv);
    expect(openEv.defaultPrevented).toBe(true);

    // Close through the shell's × button — the teardown path that BYPASSES
    // controller.close. Regression: cleanup used to hang off a controller.close
    // wrapper, so this path leaked onWindowKey and it kept eating page-wide keys.
    modal.dialog.querySelector(".cmp-close").click();

    const afterEv = new KeyboardEvent("keydown", { key: "?", cancelable: true });
    window.dispatchEvent(afterEv);
    expect(afterEv.defaultPrevented).toBe(false);
  });
});
