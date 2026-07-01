# comfyui-image-browser

Full-canvas file explorer for browsing and managing images across ComfyUI's input, output, temp and arbitrary paths — thumbnails plus delete, rename and move.

> Part of a family of mobile-first ComfyUI usability packs
> ([gallery-loader](https://github.com/laurigates/comfyui-gallery-loader),
> [sampler-info](https://github.com/laurigates/comfyui-sampler-info)):
> touch-friendly HTML modals launched from the toolbar/command palette
> that replace clunky native LiteGraph dialogs, additive and self-contained.

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
- **Thumbnails** for images (WebP previews) and videos (poster frames), lazily
  loaded as you scroll. Tap a card to open the full-size file in a new tab.
- **Manage** files in the sandboxed roots (Input / Output / Temp):
  - **🗑 Delete** — with a confirm step.
  - **✎ Rename** — in place (extension preserved).
  - **⇄ Move** — into another root or subfolder via a destination picker.

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
