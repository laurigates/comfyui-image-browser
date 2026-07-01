// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
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
});
