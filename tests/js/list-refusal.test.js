// A refused listing carries the backend's reason, not a bare status code.
//
// /image_browser/list answers 403 {ok:false, error} for a path outside
// ComfyUI's directories (issue #113), and that error names the fix: register
// the folder in extra_model_paths.yaml or symlink it inside the tree.
// fetchListing used to throw `HTTP ${status}` on any non-2xx before reading the
// body, so the browse… tab showed "HTTP 403" and nothing about the remedy.
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchListing } from "../../src/api.ts";

const REFUSAL =
  "path is outside ComfyUI's directories. To browse another folder, register it in " +
  "extra_model_paths.yaml or symlink it inside the ComfyUI tree, then restart ComfyUI.";

afterEach(() => vi.unstubAllGlobals());

describe("fetchListing on a refusal", () => {
  it("throws the backend's error, not the status code", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 403,
        json: async () => ({ ok: false, error: REFUSAL }),
      })),
    );
    await expect(fetchListing({ type: "path", path: "/home/u/Pictures" })).rejects.toThrow(
      "extra_model_paths.yaml",
    );
  });

  it("falls back to the status when the body is not JSON", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 502,
        json: async () => {
          throw new SyntaxError("Unexpected token <");
        },
      })),
    );
    await expect(fetchListing({ type: "output" })).rejects.toThrow("HTTP 502");
  });
});
