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

  it("renders a selection checkbox per file card and a delete button per dir card", async () => {
    stubListing({ files: TWO_FILES, dirs: [{ name: "sub" }] });
    const modal = openShell();
    await openLoaded(modal);
    expect(modal.bodyEl.querySelectorAll(".ib-card.is-file .ib-check").length).toBe(2);
    expect(modal.bodyEl.querySelectorAll(".ib-card.is-dir .ib-dir-del").length).toBe(1);
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
      const primary = modal.dialog.querySelector(".ib-move-card .ib-ov-primary");
      if (primary?.textContent !== "Move to input/keep") throw new Error("picker did not jump");
    });
    // Cancel the picker so the modal closes cleanly.
    Array.from(modal.dialog.querySelectorAll(".ib-move-card .ib-ov-btn"))
      .find((b) => b.textContent === "Cancel")
      .click();
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
    expect(modal.dialog.querySelector(".ib-ov-backdrop")).toBeNull();
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
