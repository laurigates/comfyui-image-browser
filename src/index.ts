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

import { type ModalShellController, notify } from "@laurigates/comfy-modal-kit";
import { app } from "/scripts/app.js";
import { EXT_NAME } from "./api.js";
import { openImageBrowser } from "./browser.js";

const OPEN_COMMAND_ID = "image-browser.open";

// Exported so the jsdom mount smoke test can open the view without the app
// chrome and assert the body renders. Delegates to the real explorer.
export function openShell(): ModalShellController {
  return openImageBrowser();
}

function openShellSafe(): void {
  try {
    openImageBrowser();
  } catch (e) {
    console.warn(`[${EXT_NAME}] open failed`, e);
    notify({
      severity: "error",
      summary: "Image Browser failed to open",
      detail: e instanceof Error ? e.message : String(e),
    });
  }
}

app.registerExtension({
  name: "comfy.image-browser",
  actionBarButtons: [
    {
      icon: "icon-[lucide--images]",
      label: "Image Browser",
      tooltip: "Browse & manage input/output images",
      onClick: openShellSafe,
    },
  ],
  commands: [
    {
      id: OPEN_COMMAND_ID,
      label: "Open Image Browser",
      function: openShellSafe,
    },
  ],
  menuCommands: [
    {
      path: ["Extensions", "Image Browser"],
      commands: [OPEN_COMMAND_ID],
    },
  ],
});
