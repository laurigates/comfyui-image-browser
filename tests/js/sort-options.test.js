// @vitest-environment jsdom
//
// The sort menu is the kit's SORT_OPTIONS, not a hand-copy.
//
// This pack shipped a private eight-entry VALID_SORTS plus a hardcoded eight
// <option> list while the kit exported TEN, and the copy had drifted twice
// over: `size:asc` and `pixels:asc` were missing entirely, and `pixels:desc`
// was labelled "Highest resolution" against the kit's "Largest resolution".
// Nothing could see either drift, because the menu and the whitelist agreed
// with each other and neither was compared to the kit.
//
// So the assertions below compare the RENDERED menu to SORT_OPTIONS itself
// rather than to a literal list written out here. A literal would be a third
// hand-copy, and a future kit addition would slip past it exactly the way the
// last two did.
import { SORT_OPTIONS } from "@laurigates/comfy-modal-kit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openShell } from "../../src/index.ts";

const SORT_STORAGE_KEY = "comfyui-image-browser:sort";

/** Minimal fetch stub: the toolbar mounts synchronously, the listing does not. */
function stubFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url) => {
      const s = String(url);
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
          files: [],
          exists: true,
        }),
      };
    }),
  );
}

/** The toolbar's sort <select>. */
function sortSelect(modal) {
  const el = modal.dialog.querySelector("select.ib-control");
  if (!el) throw new Error("sort <select> not found in the toolbar");
  return el;
}

beforeEach(() => {
  localStorage.clear();
  stubFetch();
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("the sort menu is rendered from the kit's SORT_OPTIONS", () => {
  it("offers exactly the kit's option values, in the kit's order", () => {
    const modal = openShell();
    const values = Array.from(sortSelect(modal).options).map((o) => o.value);
    expect(values).toEqual(SORT_OPTIONS.map((o) => o.value));
    modal.close();
  });

  it("offers exactly the kit's option labels, in the kit's order", () => {
    // The value half above cannot see a label drift, and a label drift is what
    // actually shipped ("Highest resolution" vs the kit's "Largest resolution").
    const modal = openShell();
    const labels = Array.from(sortSelect(modal).options).map((o) => o.textContent);
    expect(labels).toEqual(SORT_OPTIONS.map((o) => o.label));
    modal.close();
  });

  it("surfaces the two orders the hand-copied list had dropped", () => {
    // Named explicitly so the regression that motivated this adoption is
    // legible: an implementation that goes back to eight options passes the
    // two assertions above only by also changing the kit, and fails this one
    // outright.
    const modal = openShell();
    const values = Array.from(sortSelect(modal).options).map((o) => o.value);
    expect(values).toContain("size:asc");
    expect(values).toContain("pixels:asc");
    modal.close();
  });
});

describe("the stored sort preference round-trips through the kit's isValidSort", () => {
  it("applies a stored preference the kit accepts", () => {
    localStorage.setItem(SORT_STORAGE_KEY, "rating:asc");
    const modal = openShell();
    expect(sortSelect(modal).value).toBe("rating:asc");
    modal.close();
  });

  it("applies a stored preference the OLD eight-entry whitelist would have rejected", () => {
    // The paired positive for the widening: `size:asc` is valid to the kit and
    // was not in this pack's private list, so before the adoption this stored
    // value fell back to the mtime:desc default.
    localStorage.setItem(SORT_STORAGE_KEY, "size:asc");
    const modal = openShell();
    expect(sortSelect(modal).value).toBe("size:asc");
    modal.close();
  });

  it("falls back to the default for a value the kit rejects", () => {
    // The negative half. On its own it passes against a loader hard-wired to
    // return null, which is why it never stands alone here.
    localStorage.setItem(SORT_STORAGE_KEY, "colour:sideways");
    const modal = openShell();
    expect(sortSelect(modal).value).toBe("mtime:desc");
    modal.close();
  });

  it("writes the chosen order back under this pack's own key", () => {
    // Pack-scoped storage is what makes widening the menu safe in isolation:
    // comfyui-gallery-loader persists under "comfyui-gallery-loader:sort" and
    // therefore never reads a value this pack's menu produced.
    const modal = openShell();
    const el = sortSelect(modal);
    el.value = "pixels:asc";
    el.dispatchEvent(new Event("change", { bubbles: true }));
    expect(localStorage.getItem(SORT_STORAGE_KEY)).toBe("pixels:asc");
    expect(localStorage.getItem("comfyui-gallery-loader:sort")).toBeNull();
    modal.close();
  });
});
