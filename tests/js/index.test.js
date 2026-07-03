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

/** Dispatch a real keydown on window (capture phase, cancelable). */
function pressKey(key) {
  window.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
}

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
