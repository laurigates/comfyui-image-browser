# CLAUDE.md

ComfyUI custom-node pack with a thin Python backend (a node + HTTP endpoints in `image_browser.py`) and a TypeScript frontend extension built to `web/dist/` via bun. See ADR-0001.

## The pattern ("the vein")

A mobile-first ComfyUI usability pack in the *standalone-modal* vein: instead of intercepting a per-node widget, a frontend extension opens a STANDALONE modal from the app chrome — an action-bar button plus a command (palette/hotkey-bindable) and a menu entry. There are **no target widgets to hook**, so there is no `TARGET_WIDGETS` / `onPointerDown` wrapping. The modal is **touch-first** (16px inputs to avoid iOS zoom, big tap targets, momentum scroll); its primitives come from `@laurigates/comfy-modal-kit` (`openModalShell` / `fuzzyScore` / `notify`), imported and inlined by `bun build` — not copied into the pack. `openShell()` is exported so the jsdom mount test can prove the modal body renders.

Concretely, this pack is a **full-canvas image browser + file manager**: the modal
fills the whole viewport (`width: 100vw; height: 100vh` on `.ib-dialog`), standing
in for the canvas while open. It reuses the card-grid file-explorer pattern proven
in `comfyui-gallery-loader`'s `image-picker` (breadcrumbs, thumbnail grid,
lazy-load, sort, fuzzy search), but as a standalone view that **manages** files
(delete / rename / move) rather than committing a value to a node widget. There is
**no custom node** — `NODE_CLASS_MAPPINGS` is intentionally empty; all value lives
in the HTTP endpoints + the served bundle.

## Endpoint surface (`/image_browser/`)

| Endpoint | Method | Purpose |
|---|---|---|
| `/base` | GET | ComfyUI well-known dirs (base/input/output/temp/user). Frontend hard-codes no paths. |
| `/list` | GET | Directory listing (`type=input\|output\|temp\|path`, `subfolder`/`path`, `extensions`). Returns `{dirs, files}`; each file carries `mtime/size/width/height/ext`. |
| `/thumb` | GET | WebP thumbnail for an arbitrary absolute-path image (path-mode only; sandboxed types use core `/api/view`). |
| `/file` | GET | Stream an absolute-path file (image/video), extension-gated. |
| `/delete` | POST | `{type, subfolder, name}` — delete a file. |
| `/rename` | POST | `{type, subfolder, name, new_name}` — rename in place. |
| `/move` | POST | `{type, subfolder, name, dest_type, dest_subfolder}` — move between roots/subfolders. |
| `/rating` | POST | `{type, subfolder, name, rating}` — persist a 0..5 star rating into the file's XMP (or sidecar). Sandboxed types only, like all writes. |

## File layout

| Path | Purpose |
|------|---------|
| `src/index.ts` | The extension: action-bar/command/menu launcher; exports `openShell()` → `openImageBrowser()`. |
| `src/browser.ts` | The full-canvas explorer — grid, tabs, breadcrumbs, sort/search, per-card delete/rename/move, the move-destination picker, and all CSS. |
| `src/api.ts` | Typed wrappers over the `/image_browser/*` endpoints + thumbnail/preview URL builders. No DOM. |
| `src/overlay.ts` | In-dialog overlays (confirm / text prompt / custom) — used for delete-confirm, rename, move. Kept in-dialog (not a second `openModalShell`) to avoid single-modal discipline closing the browser. |
| `src/comfyui-shims.d.ts` | Types the `/scripts/app.js` runtime import (via the `paths` mapping in `tsconfig.json`). |
| `__init__.py` | Loader stub. Imports (empty) node mappings from the backend module; exports `WEB_DIRECTORY = "./web/dist"`. |
| `image_browser.py` | HTTP endpoints only (no node). Bundled libs + stdlib only; reads gate on an extension whitelist, writes are sandboxed to input/output/temp. |
| `xmp_meta.py` | **Vendored verbatim** from its canonical home `comfyui-gallery-loader/xmp_meta.py` — do not edit here. Re-sync with `just sync-xmp`; CI fails on drift. Pure stdlib XMP rating read/write (in-file PNG/JPEG surgery + `.xmp` sidecar). |
| `web/dist/` | **Generated** by `bun run build`, committed (tracked) so git clone/update carries it. ComfyUI serves it at `/extensions/comfyui-image-browser/`. |
| `pyproject.toml` | Comfy Registry metadata. `PublisherId` + `version` are the fields you touch; `[tool.comfy] includes = ["web/dist"]` force-ships the built output. |
| `tsconfig.json` / `biome.json` / `knip.json` | Strict TS config, Biome lint/format, knip dead-code. |
| `.github/workflows/` | `ci.yml` (tsc+build/biome/vitest/ruff/pytest/gitleaks), `publish.yml` (builds then publishes on version bump), `release-please.yml`. |
| `tests/js/` | Vitest suite importing the `.ts` source directly. `tests/test_init.py` is the pytest backend suite. |
| `justfile` | `build`, `lint`, `format`, `test`, `check` recipes — the local CI gate. |

## Hard rules

- **Pack directory name is part of the URL.** `web/dist/index.js` is served at
  `/extensions/comfyui-image-browser/index.js`. Renaming the pack dir breaks every fetch. If
  unavoidable, sync `EXT_NAME` in the source.
- **TypeScript source, bun build.** Author in `src/` (entry `src/index.ts`),
  build to `web/dist/` via `bun build ./src/index.ts --target browser --format
  esm --outdir web/dist --external '/scripts/*'`. `tsc --noEmit` is the type
  gate; `bun build` is the emit — they are decoupled. The `/scripts/app.js`
  import is left **unbundled** (resolved at runtime against ComfyUI's served
  module). See ADR-0001.
- **No new Python dependencies. Backend uses ComfyUI-bundled libs only (aiohttp, PIL, folder_paths, server) + the stdlib (os, shutil, hashlib). A feature needing another lib → a separate companion pack.**
- **Security perimeter — reads gate on extensions, writes are sandboxed.** The arbitrary-path read endpoints (`/thumb`, `/file`) accept an absolute `path` and MUST gate on `IMG_EXTS`/`STREAMABLE_EXTS` before touching disk — never read an arbitrary path without the whitelist. The write endpoints (`/delete`, `/rename`, `/move`) go through `_resolve_sandboxed_file`, which **rejects `type=path`** (writes only in input/output/temp), re-asserts a bare traversal-free filename, the media-extension whitelist, and containment via `commonpath`. **Do not** add an arbitrary-path write path, and **do not** widen a write to `type=path` — arbitrary-path mutation is out of scope by design (ADR-0002). When adding a new file type, widen `IMG_EXTS`/`VIDEO_EXTS` explicitly and add a `tests/test_helpers.py` case.
- **The frontend write UI must mirror the backend's write gate.** `renderGrid` only emits the rename/move/delete buttons for `SANDBOXED_TYPES` (the `canWrite` flag); the `browse…`/path tab shows open-only. If the backend gate changes, change this predicate in lockstep (see `comfyui-pack-live-smoke.md` — a partial frontend mirror ships a dead/available-when-it-shouldn't-be control that passes green tests).
- ****Modal primitives come from `@laurigates/comfy-modal-kit`** — import them, do NOT copy `modal-shell.js`/`modal-fuzzy.js` into the pack. `bun build` inlines the imported code into `web/dist`.**
- **Additive only.** Never clobber an existing tooltip/control; fall back to
  the native widget when there's no match. Never fabricate data.
- **Launcher API is version-sensitive.** The modal opens from `registerExtension`'s `actionBarButtons` / `commands` / `menuCommands`. If a future frontend renames or drops one, keep at least one launcher (button OR command) wired so the modal stays reachable.
- **Never hand-edit `CHANGELOG.md` or the `version` field** — release-please
  owns them (conventional commits drive the bump).

## Dev workflow

```sh
uv sync --group dev          # ruff, pytest, pre-commit
bun install                  # TypeScript, Biome, Vitest, knip, @laurigates/comfy-modal-kit (inlined at build)
pre-commit install
just check                   # typecheck + build + lint + test — the local CI gate
```

Iterating on the frontend needs a **`bun run build`** (the served file is
`web/dist/index.js`, not the source) plus a browser hard-refresh — no ComfyUI
restart. Changes to `image_browser.py` (backend) DO require a ComfyUI restart.

### Endpoint reachability check

```sh
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8188/extensions/comfyui-image-browser/index.js
curl -s http://127.0.0.1:8188/image_browser/base | jq .
curl -s "http://127.0.0.1:8188/image_browser/list?type=output" | jq '{ok, exists, files: (.files|length)}'
```

### Live smoke matrix (after non-trivial changes)

Backend `.py` changes need a ComfyUI restart; frontend needs `bun run build` +
hard-refresh. See `comfyui-pack-live-smoke.md` — `just check` cannot catch
frontend↔backend contract bugs (route names, JSON shapes, the write-gate mirror).

| Action | Expected |
|---|---|
| Toolbar **Image Browser** button | Opens a full-viewport gallery; Output tab shows newest-first thumbnails. |
| Input / Output / Temp tabs | Switch roots; breadcrumbs + folder descend work; delete/rename/move buttons present. |
| **browse…** tab | Starts at `base_path`; navigate into `models/` etc.; **only the ↗ open button** on cards (no write buttons). |
| Delete | Confirm overlay → file gone from grid; re-list confirms it's off disk. |
| Rename | Overlay input (extension enforced) → card renames; a name collision returns a 409 error toast. |
| Move | Destination picker (tabs + folder nav) → file leaves the source grid; appears under the destination. |
| Error path | Kill the server mid-action → a **copyable** `notify()` error toast (not a silent console log). |
| Phone width (~400px) | Resize; grid reflows, tap targets ≥34px, modal is full-bleed. |

## Verify the frontend API against the sourcemap

The ComfyUI frontend (`comfyui-frontend-package`) ships **minified** — property
and method names are renamed in the bundle, so reading the running app's objects
by guessed names (or trusting old tutorials) is unreliable. The TypeScript types
from `@comfyorg/comfyui-frontend-types` cover `ComfyApp` but **not** the internal
`LGraphNode` / `LGraphCanvas` / widget interfaces (un-exported). Model the small
surface you touch with local structural interfaces, and verify the real shape
against the bundled sourcemap before coding against a LiteGraph / canvas API.

LiteGraph is bundled in the **`api-*.js.map`** chunk under
`.venv/lib/python*/site-packages/comfyui_frontend_package/static/assets/`. The
`.js.map` embeds the original TypeScript in `sourcesContent` — grep that, not the
minified `.js`:

```sh
cd .venv/lib/python*/site-packages/comfyui_frontend_package/static/assets
grep -l 'LGraphGroup' *.js.map        # find the chunk
```

Facts worth confirming this way (recheck on a `comfyui-frontend-package` bump):
`LiteGraph.NODE_TITLE_HEIGHT` (30); `canvas.selectedItems` is a
`Set<Positionable>` holding nodes + groups + reroutes; `canvas.selected_nodes` is
a node-only dictionary; canvas zoom is **wheel-driven**
(`processMouseWheel -> ds.changeScale`).

Two gotchas that follow: discriminate selected items by **shape, not
`instanceof`** (the class is renamed under minification); and to suppress native
zoom during a gesture, intercept `wheel` (capture, `passive:false`,
`preventDefault`), not just pointer events. Record what you confirm in a
"Verified frontend API" table above so the next change doesn't re-derive it.

## Releases

Merge the release-please PR → the published GitHub release triggers
`publish.yml`, which runs `bun run build`, publishes via
`Comfy-Org/publish-node-action`, attaching the release notes as the per-version registry changelog (the "Updates" section). Requires the
`REGISTRY_ACCESS_TOKEN` repo secret. Use conventional commits; release-please
maintains `CHANGELOG.md` and the version bump PR.
