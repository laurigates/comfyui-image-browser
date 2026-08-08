# comfyui-image-browser

Full-canvas file explorer for browsing and managing images across ComfyUI's input, output, temp and arbitrary paths — thumbnails plus delete, rename and move.

> Part of a family of mobile-first ComfyUI usability packs
> ([gallery-loader](https://github.com/laurigates/comfyui-gallery-loader),
> [sampler-info](https://github.com/laurigates/comfyui-sampler-info)):
> touch-friendly HTML modals launched from the toolbar/command palette
> that replace clunky native LiteGraph dialogs, additive and self-contained.

![full-canvas image browser: Input/Output/Temp tabs, thumbnail grid, per-card open/rename/move/delete](docs/browser.png)

*The full-canvas browser, opened from the top-bar button — thumbnails of the
Output folder with per-card manage actions.*

## Install

```sh
cd <ComfyUI>/custom_nodes
git clone https://github.com/laurigates/comfyui-image-browser
cd comfyui-image-browser
bun install
bun run build      # emit web/dist/ (served by ComfyUI)
```

Restart ComfyUI; hard-refresh the browser tab (Ctrl+Shift+R / Cmd+Shift+R).

## What it does

Adds an **Image Browser** button to the ComfyUI top bar (also a command in the
palette and an **Extensions → Image Browser** menu entry). Clicking it opens a
**full-viewport** file explorer that stands in for the canvas while open — a
touch-first card grid of thumbnails you can browse and manage without leaving
ComfyUI.

- **Browse** the **Input / Output / Temp** folders as tabs, plus a **browse…**
  tab for arbitrary absolute paths (`models/`, `custom_nodes/`, anywhere on
  disk). Breadcrumbs, folder descend, sort (newest / oldest / name / size /
  resolution), and fuzzy filename filter.
- **Filter by media type** — a segmented **All / 🖼 Images / 🎬 Videos** control
  narrows the grid to one kind. It filters on the server, so in a big output
  folder "Videos" shows the newest clips rather than only the clips that happen
  to fall inside the listing limit. The choice is remembered.
- **Thumbnails** for images (WebP previews) and videos (poster frames), lazily
  loaded as you scroll. Tap a card to open the full-size file in a new tab.
- **⤓ Load workflow** (`w`) — reopen the graph embedded in a file, on any tab
  including `browse…`. ComfyUI writes the workflow into every image *and video*
  it saves, so this turns the browser into a durable way back into a past
  generation — unlike the stock sidebar, whose list is cleared on every ComfyUI
  restart. Files re-encoded elsewhere (a phone gallery, a chat app) lose that
  metadata, and the button says so rather than failing silently.
- **ⓘ Metadata** (`i`) — the prompt, model, seed, steps, CFG, sampler and
  scheduler read back out of the file, each copyable, with the full raw
  metadata behind a disclosure.

  Both work on **videos** as well as images: MP4/MOV/M4V and WebM/MKV are read
  natively, including clips written by `WanVideoWrapper` and other custom
  savers whose metadata layout ComfyUI's own loader does not understand.
  (`.avi`/`.mpg` carry no ComfyUI metadata, so they show neither button rather
  than one that fails on tap.)
- **Manage** files in the sandboxed roots (Input / Output / Temp):
  - **🗑 Delete** — with a confirm step.
  - **✎ Rename** — in place (extension preserved).
  - **⇄ Move** — into another root or subfolder via a destination picker.
- **📌 Pin** folders *and* individual files. A pinned folder becomes a one-tap
  chip in the toolbar and a shortcut row in the move picker; pinned files
  collect on their own **📌 pinned** tab, where each card behaves exactly like
  any other (thumbnail, stars, ⓘ/⤓, rename/move/delete, multi-select) and is
  labelled with its full address, because pins span roots.

  The pin list lives **on the server**, in `<user_dir>/comfy-pins.json` — not in
  the browser. Two consequences worth knowing:

  - It follows you between **devices** and is shared with
    [`comfyui-gallery-loader`](https://github.com/laurigates/comfyui-gallery-loader):
    pin six renders on your phone, they are there on the desktop, and in the
    other pack's picker. A phone and a desktop are two browsers against one
    ComfyUI, which browser-local storage cannot bridge — that is the whole
    reason the list moved.
  - It is therefore **per-install, not per-user**. Anyone else using that
    ComfyUI sees and can change the same list. There are no accounts here.

  Nothing watches the disk, so a pinned file deleted from elsewhere shows as a
  dimmed card until you unpin it or hit **🧹 Prune missing**. Up to 200 pins;
  past that an add is refused out loud rather than silently dropped. Any pins
  you had before this version are migrated automatically on first open.

### Star ratings on ComfyUI's own Media Assets sidebar

Ratings are stored in each image's **XMP** (or a sidecar), so they are a
property of the file rather than of this pack. That makes them worth showing
where you actually look at a fresh generation — ComfyUI's stock **Media
Assets** sidebar — and not only inside the browser.

Enabled by default; switch it off under **Settings → Image Browser → Sidebar**.

ComfyUI exposes no extension point for media-asset cards (`ComfyExtension` has
hooks for commands, menus, settings, sidebar *tabs* and canvas/node context
menus — nothing per card, and `MediaAssetCard.vue` has no slot), so this is a
deliberate, contained DOM injection. It is written to fail soft: if a frontend
update changes the card markup, the stars simply stop appearing — they never
throw, and never intercept the card's own clicks. The setting is the kill
switch if a future version misbehaves.

Note that the sidebar's own list is cleared whenever ComfyUI restarts. The
ratings are not — they are on disk, so anything you star there is still starred
in the Image Browser afterwards.

### Rate and delete in the asset lightbox

A thumbnail is not enough to judge a fresh generation, so the same two verdict
actions are available full-screen: open an asset with **Inspect asset** from the
Media Assets sidebar and a bar appears at the bottom of the viewer with a
**0–5 star row** and a **🗑 delete** button. With the lightbox's own ←/→
navigation, that is a complete cull pass over a batch — rate the keepers, bin
the duds, arrow to the next — without going back to the grid.

- **Delete asks first**, then **advances to the next item** (it closes instead
  when there is nothing left to advance to). While the confirm is up, ← / → /
  Esc do nothing, so you cannot navigate to a different file between the
  question and the answer.
- **Ratings are shared with everything else** — the stars here, the sidebar
  card underneath, and the Image Browser all read and write the same XMP.
  The lightbox re-reads on every navigation, so it never shows you a stale one.
- **The sidebar's list is not ours to refresh.** A file you delete stays in the
  list until the sidebar reloads; arrow back onto it and the bar says *Deleted*
  rather than offering stars on a file that is gone.
- **Images only, for now.** VHS-format videos get no bar, because the URL the
  stock viewer builds for them is wrong: `AssetsSidebarTab.vue` hard-codes
  `subfolder: ''` when it maps an asset to a result item and overrides only the
  image URL, so a video in a subfolder is requested from the wrong path. (That
  is an upstream bug in its own right — the stock viewer shows a blank player
  for those files; measured HTTP 204.) Addressing off that URL would rate and
  delete the wrong file, so this pack declines to guess. Video ratings still
  work in the Image Browser itself.

Enabled by default; switch it off under **Settings → Image Browser → Sidebar**.
Like the card stars, this is a contained DOM injection (`MediaLightbox.vue`
takes props and emits an index — it has no slot and no extension hook) written
to fail soft: if a frontend update changes the viewer, the bar stops appearing
rather than breaking it. Navigation is driven through the viewer's own keyboard
contract rather than by clicking its buttons, whose labels and icons move
between versions.

Management actions are intentionally **disabled in the arbitrary-path
(`browse…`) tab** — that mode is browse-only. The backend rejects writes outside
the Input/Output/Temp roots, so an arbitrary path can never be mutated by URL
crafting. See the security posture in `docs/blueprint/adrs/0002-*`.

## Compatibility

- ComfyUI: modern Vue frontend (`comfyui-frontend-package >= 1.40`) for the
  `registerExtension` action-bar/command launcher API.
- Frontend changes take effect after `bun run build` + a browser hard-refresh —
  no ComfyUI restart.

## License

MIT — see `LICENSE`.
