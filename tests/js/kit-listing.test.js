// @vitest-environment jsdom
//
// Kit 0.14.0 adoption — the listing layer's pure half.
//
// This pack's copies of IMG_EXTS / VIDEO_EXTS / SANDBOXED_TYPES / joinAbs /
// META_FIELDS+metaRows+metaClipboardText / the flat-view store were deleted in
// favour of the kit's. Every one of them was verified comment-stripped against
// the kit before the delete; what the deletes cannot pin is the two things that
// would break SILENTLY afterwards, so those are what this file asserts.
//
//   1. THE VIEW-STORE NAMESPACE. `createViewStore(namespace)` takes the
//      localStorage prefix as a parameter precisely because the two gallery
//      packs must not share one. Passing the wrong string is invisible: the
//      store still works, the toggle still toggles, and every user's stored
//      preference is simply orphaned under a key nothing reads any more. There
//      is no error and no visual tell — which is exactly why the literal key is
//      asserted here rather than left to the behavioural flat-view tests in
//      index.test.js (those would also pass against a shared namespace).
//
//   2. THAT SANDBOXED_TYPES IS THE KIT'S ARRAY. api.ts casts it to
//      `readonly BrowseType[]` to keep this pack's narrowing, and a cast is
//      exactly the kind of thing a future edit can point at a fresh local
//      literal without changing a single call site. An identity check is what
//      distinguishes "narrowed the kit's array" from "re-copied it".
import {
  IMG_EXTS,
  SANDBOXED_TYPES as KIT_SANDBOXED_TYPES,
  VIDEO_EXTS,
} from "@laurigates/comfy-modal-kit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { META_EXTS, SANDBOXED_TYPES } from "../../src/api.ts";
import { openShell } from "../../src/index.ts";

const VIEW_KEY = "comfyui-image-browser:view";
const PENDING_KEY = "comfyui-image-browser:view-pending";
// The sibling gallery pack's namespace. Nothing here may read or write it.
const SIBLING_VIEW_KEY = "comfyui-gallery-loader:view";

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

/** The toolbar's ≣ flat-view toggle. */
function viewToggle(modal) {
  const el = modal.dialog.querySelector(".ib-view-toggle");
  if (!el) throw new Error("flat-view toggle not found in the toolbar");
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

describe("the flat-view store is namespaced to THIS pack", () => {
  it("writes the preference under comfyui-image-browser:view, and nowhere else", () => {
    const modal = openShell();
    viewToggle(modal).click();
    expect(localStorage.getItem(VIEW_KEY)).toBe("flat");
    // The failure this pins is a namespace typo, and a typo writes SOMEWHERE.
    // Asserting the sibling key is null is not enough on its own (a third,
    // misspelt key would pass it), so enumerate what was actually written.
    // `Object.keys(localStorage)` is empty under jsdom's Storage — enumerate
    // through the indexed accessor, which is the only one that sees the keys.
    const keys = [];
    for (let i = 0; i < localStorage.length; i++) keys.push(localStorage.key(i));
    expect(keys.filter((k) => k.endsWith(":view"))).toEqual([VIEW_KEY]);
    modal.close();
  });

  it("reads a preference stored under comfyui-image-browser:view", () => {
    // The positive half. Without it the negative below passes against a store
    // wired to a namespace nobody uses — which is the exact bug, not the fix.
    localStorage.setItem(VIEW_KEY, "flat");
    const modal = openShell();
    expect(viewToggle(modal).classList.contains("is-active")).toBe(true);
    modal.close();
  });

  it("ignores the sibling pack's preference under comfyui-gallery-loader:view", () => {
    // The negative half, on the same setting in the same test pair: a shared
    // namespace would make comfyui-gallery-loader's flat-view choice silently
    // decide this pack's, over a different set of roots.
    localStorage.setItem(SIBLING_VIEW_KEY, "flat");
    const modal = openShell();
    expect(viewToggle(modal).classList.contains("is-active")).toBe(false);
    modal.close();
  });

  it("recovers from an interrupted flat load using this pack's own breadcrumb", () => {
    localStorage.setItem(VIEW_KEY, "flat");
    localStorage.setItem(PENDING_KEY, "1");
    const modal = openShell();
    // The stored preference is overwritten, not merely ignored — reopening must
    // not walk back into the load that killed the tab.
    expect(viewToggle(modal).classList.contains("is-active")).toBe(false);
    expect(localStorage.getItem(VIEW_KEY)).toBe("folder");
    expect(localStorage.getItem(PENDING_KEY)).toBeNull();
    modal.close();
  });

  it("does not recover when the SIBLING pack's breadcrumb is the one raised", () => {
    // Pairs with the test above: the recovery must key on this pack's pending
    // breadcrumb, not on any pack's.
    localStorage.setItem(VIEW_KEY, "flat");
    localStorage.setItem("comfyui-gallery-loader:view-pending", "1");
    const modal = openShell();
    expect(viewToggle(modal).classList.contains("is-active")).toBe(true);
    expect(localStorage.getItem(VIEW_KEY)).toBe("flat");
    modal.close();
  });
});

describe("the listing vocabulary is the kit's, not a re-copy", () => {
  it("SANDBOXED_TYPES is the kit's array itself", () => {
    // Identity, not membership: a fresh local literal with the same three
    // strings passes a `toEqual` and is precisely the drift this adoption
    // removed.
    expect(SANDBOXED_TYPES).toBe(KIT_SANDBOXED_TYPES);
  });

  it("SANDBOXED_TYPES still names the three write roots and neither view", () => {
    expect([...SANDBOXED_TYPES]).toEqual(["input", "output", "temp"]);
    // The negative half. "path" is browse-only and "pinned" is a view whose
    // grid spans roots; either one appearing here would ship write controls the
    // backend rejects.
    expect(SANDBOXED_TYPES).not.toContain("path");
    expect(SANDBOXED_TYPES).not.toContain("pinned");
  });

  it("META_EXTS admits every image the kit knows about", () => {
    // META_EXTS is the one derived set that stays local (IMG_EXTS ∪ this pack's
    // narrower META_VIDEO_EXTS). Deriving it from the kit is what keeps the ⓘ /
    // ⤓ gate widening in step when the kit gains an image format.
    for (const ext of IMG_EXTS) expect(META_EXTS.has(ext)).toBe(true);
  });

  it("META_EXTS admits no video container without a reader", () => {
    // The paired negative: the narrowing is the point of META_VIDEO_EXTS, so a
    // positive-only assertion above would pass against META_EXTS = every
    // extension there is.
    expect(VIDEO_EXTS.has(".avi")).toBe(true);
    expect(META_EXTS.has(".avi")).toBe(false);
    expect(META_EXTS.has(".mp4")).toBe(true);
  });
});
