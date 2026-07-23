// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
// Vitest transpiles TypeScript, so the test imports the `.ts` source directly
// (no build step). Importing the module also runs the registerExtension wiring
// against tests/js/__mocks__/app.js. The standalone modal is launched from the
// app chrome, so the meaningful smoke test is a jsdom modal-MOUNT check:
// openShell() must populate modal.bodyEl. This is exactly the empty-modal gap
// (openModalShell returns an EMPTY bodyEl you fill after opening) that passes
// pure-helper unit tests but ships a blank dialog — so it is asserted here.
// The initial fetch fires asynchronously and (harmlessly) fails under jsdom;
// the synchronous scaffold (root + toolbar tabs + grid) is what we assert on.
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
});

describe("comfyui-image-browser standalone modal", () => {
  it("mounts the full-canvas browser scaffold into the modal shell", () => {
    const modal = openShell();
    expect(modal.bodyEl).toBeTruthy();
    // The root container the browser fills.
    expect(modal.bodyEl.querySelector(".image-browser-body")).not.toBeNull();
    // The card grid is mounted synchronously (populated after the async fetch).
    expect(modal.bodyEl.querySelector(".ib-grid")).not.toBeNull();
    // Toolbar tabs for the sandboxed roots + arbitrary path mode.
    const tabs = modal.dialog.querySelectorAll(".ib-tab");
    expect(tabs.length).toBe(4);
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
