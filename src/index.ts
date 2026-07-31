// Image Browser — ComfyUI frontend extension (standalone-modal pack).
//
// TypeScript source in `src/`, built to ESM via `bun build` and emitted to
// `web/dist/` (served at /extensions/comfyui-image-browser/index.js — the pack
// directory name IS the URL segment). Do not rename the pack dir without syncing
// EXT_NAME in src/api.ts (used for log prefixes and every /image_browser/ fetch).
// See ADR-0001.
//
// Pattern ("the standalone-modal vein"): instead of intercepting a per-node
// widget, this pack opens a STANDALONE, full-viewport gallery from the app
// chrome — an action-bar button plus a command (palette/hotkey-bindable) and a
// menu entry. The view fills the whole viewport (stands in for the canvas while
// open) and MANAGES files (delete / rename / move), not just browses them.
//
// The shared modal primitives (openModalShell, fuzzyScore, notify) come from
// @laurigates/comfy-modal-kit — imported, not copied; `bun build` inlines them.

import { type ModalShellController, makeLauncher } from "@laurigates/comfy-modal-kit";
import { app } from "/scripts/app.js";
import { openImageBrowser } from "./browser.js";
import { installSidebarStars } from "./sidebar-stars.js";

// Exported so the jsdom mount smoke test can open the view without the app
// chrome and assert the body renders. Delegates to the real explorer.
export function openShell(): ModalShellController {
  return openImageBrowser();
}

// Teardown for the sidebar-star injector, kept module-level so the setting's
// onChange can toggle it. The settings store fires onChange once at
// registration with the stored value, so the setting IS the lifecycle — there
// is no separate startup call to keep in sync with it.
let uninstallSidebarStars: (() => void) | null = null;

app.registerExtension({
  name: "comfy.image-browser",
  settings: [
    {
      id: "ImageBrowser.SidebarStars",
      category: ["Image Browser", "Sidebar", "Star ratings"],
      name: "Star ratings on stock Media Assets cards",
      tooltip:
        "Adds a 0–5 star row to ComfyUI's own Media Assets sidebar cards, written to the image's XMP — the same rating the Image Browser shows. Injected into stock UI (ComfyUI exposes no extension point for asset cards), so switch this off if a frontend update makes it misbehave.",
      type: "boolean",
      defaultValue: true,
      onChange: (value: boolean) => {
        if (value && !uninstallSidebarStars) {
          uninstallSidebarStars = installSidebarStars();
        } else if (!value && uninstallSidebarStars) {
          uninstallSidebarStars();
          uninstallSidebarStars = null;
        }
      },
    },
  ],
  // Command + shared Extensions > Touch Tools menu entry + action-bar button,
  // built by the kit with the family conventions baked in (kebab command id,
  // PrimeIcons, safe-open with a copyable error toast). Kit ADR-0002.
  ...makeLauncher({
    id: "image-browser.open",
    label: "Image Browser",
    icon: "pi pi-images",
    tooltip: "Browse & manage input/output images",
    failSummary: "Image Browser failed to open",
    open: openImageBrowser,
    actionBar: { label: "Image Browser" },
  }),
});
