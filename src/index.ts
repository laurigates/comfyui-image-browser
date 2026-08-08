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
// chrome — a command (palette/hotkey-bindable), a menu entry, and a row in the
// family's shared "Touch Tools" action-bar button. The view fills the whole
// viewport (stands in for the canvas while open) and MANAGES files (delete /
// rename / move), not just browses them.
//
// The shared modal primitives (openModalShell, fuzzyScore, notify) come from
// @laurigates/comfy-modal-kit — imported, not copied; `bun build` inlines them.

import {
  installHubButton,
  type ModalShellController,
  makeHubEntry,
  registerHubEntry,
} from "@laurigates/comfy-modal-kit";
import { app } from "/scripts/app.js";
import { openImageBrowser } from "./browser.js";
import { installLightboxActions } from "./lightbox-actions.js";
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
let uninstallLightboxActions: (() => void) | null = null;

// The pack's family entry point: a command, an Extensions > Touch Tools menu
// item, and the row this pack contributes to the Touch Tools chooser. It emits
// NO action-bar button of its own — the family owns exactly one, claimed below
// by installHubButton().
const entry = makeHubEntry({
  id: "image-browser.open",
  label: "Image Browser",
  icon: "pi pi-images",
  tooltip: "Browse & manage input/output images",
  description: "Browse & manage input/output images",
  failSummary: "Image Browser failed to open",
  open: openImageBrowser,
  // Sorts above Touch Node Manager — the higher-frequency tool. This is the
  // mitigation for the 1-tap -> 2-tap regression the shared hub button costs
  // this pack when both chrome packs are installed.
  priority: 10,
});

app.registerExtension({
  name: "comfy.image-browser",
  settings: [
    {
      // The id is FROZEN — persistence is keyed on it end-to-end
      // (settingStore.ts:78/142/157/199) and `category` is read only by
      // getSettingInfo (:16-22), so re-keying the category is value-safe in
      // both directions while renaming the id would silently reset the user's
      // preference.
      id: "ImageBrowser.SidebarStars",
      // Three elements with a DISTINCT third, always: two settings sharing an
      // identical full category array silently collapse into one — buildTree
      // reuses the node at that path and unconditionally overwrites
      // parent.data (treeUtil.ts:24-38), so the first vanishes from the dialog
      // while its value stays stored. `sortOrder` is required too: flattenTree
      // pops a stack (treeUtil.ts:57-66), which reverses registration order.
      category: ["Touch Tools", "Image Browser", "Star ratings"],
      sortOrder: 100,
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
    {
      // FROZEN id; distinct third category element; explicit sortOrder — see
      // the note on ImageBrowser.SidebarStars above.
      id: "ImageBrowser.LightboxActions",
      category: ["Touch Tools", "Image Browser", "Lightbox actions"],
      sortOrder: 90,
      name: "Rate & delete in the asset lightbox",
      tooltip:
        "Adds a star row and a delete button to ComfyUI's full-screen asset viewer (Media Assets sidebar → Inspect asset), so you can arrow through fresh generations and rate or bin each one. Deleting advances to the next item; the sidebar's own list only drops the deleted entry when it reloads. Injected into stock UI (ComfyUI exposes no extension point for the lightbox), so switch this off if a frontend update makes it misbehave.",
      type: "boolean",
      defaultValue: true,
      onChange: (value: boolean) => {
        if (value && !uninstallLightboxActions) {
          uninstallLightboxActions = installLightboxActions();
        } else if (!value && uninstallLightboxActions) {
          uninstallLightboxActions();
          uninstallLightboxActions = null;
        }
      },
    },
  ],
  // TWO SIBLING SPREADS, and their key-disjointness is the guarantee — do NOT
  // hand-merge the arrays. makeHubEntry returns only `commands` / `menuCommands`
  // (plus the inert `hubEntry` field); installHubButton returns only
  // `actionBarButtons`, or `{}` once another inlined kit copy has already
  // claimed the single family button. Were the second spread to also carry
  // `commands`, it would win that key and orphan this pack's command: the menu
  // row would vanish (menuItemStore.ts:90-97 filters menuCommand.commands
  // against extension.commands ids) and a user keybinding on the orphaned id
  // would be re-added at boot with no isRegistered gate
  // (keybindingService.ts:116-124), squatting its combo and throwing on press.
  ...entry,
  ...installHubButton(),
  setup() {
    // Registered HERE, not at module evaluation. Every extension file is
    // imported regardless of the disable list (extensionService.ts:55-67) while
    // invokeExtensionsAsync only iterates `enabledExtensions` (:214) — so
    // registering at module scope would list this pack in the chooser even when
    // the user has disabled it.
    registerHubEntry(entry.hubEntry);
  },
});
