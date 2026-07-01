---
id: ADR-0001
date: 2026-07-01
status: Accepted
deciders: Lauri Gates
domain: build-tooling
github-issues: []
---

# ADR-0001: TypeScript source + bun build (browser ESM)

## Context

This pack reaches deep into the **minified** ComfyUI frontend's LiteGraph
widget/node/canvas objects (`widget.onPointerDown`, `node.widgets`,
`app.canvas`, `ds.scale`/`ds.offset`). Those accesses are exactly where a
frontend-version bump silently breaks the pack. A vanilla-JS single file has no
static type checking at that seam — the largest source of silent breakage is
uncaught until runtime.

## Decision

Author the frontend in **TypeScript** under `src/` (entry `src/index.ts`) and
build to `web/dist/` with **`bun build`**:

```sh
bun build ./src/index.ts --target browser --format esm --outdir web/dist --external '/scripts/*'
```

- **Type gate**: `bun run typecheck` → `tsc --noEmit` against
  `@comfyorg/comfyui-frontend-types`. `tsc` never emits; `bun build` never
  type-checks — the two are decoupled and each stays fast and single-purpose.
- **Emit**: `bun build` produces browser-clean ESM with the `/scripts/app.js`
  runtime import left **unbundled** (`--external '/scripts/*'`), resolved at
  runtime against ComfyUI's served module. If the pack ships a static data
  corpus, append `&& cp -R web/data web/dist/data` to the build script.
- **Serve**: `__init__.py` sets `WEB_DIRECTORY = "./web/dist"`. ComfyUI serves
  that tree at `/extensions/comfyui-image-browser/`, so the built JS is at
  `/extensions/comfyui-image-browser/index.js`.
- **Distribution**: `web/dist/` is committed (tracked, generated) so a git
  clone / update carries the served bundle. The Comfy Registry tarball also
  includes it via `[tool.comfy] includes = ["web/dist"]`, and `publish.yml`
  runs `bun run build` before `publish-node-action`.

## Shared modal kit (not copied)

The modal-shell + fuzzy-matcher primitives come from `@laurigates/comfy-modal-kit`
(a dependency), imported in `src/index.ts`. They are **not** vendored into the
pack — `bun build` inlines the imported code into `web/dist`. This single-sources
the primitives that were previously copied byte-identically across packs.

## Type-seam notes (for future maintainers)

- `@comfyorg/comfyui-frontend-types` exports `ComfyApp` at the module root but
  **not** `LGraphNode` / `LGraphCanvas` / the widget interfaces (declared
  internally, un-exported). Model the small surface this pack touches with local
  structural interfaces rather than importing un-exportable types.
- TypeScript will not match an ambient `declare module` against a rooted
  (`/scripts/app.js`) path specifier. A `paths` mapping in `tsconfig.json` points
  that import at `src/comfyui-shims.d.ts` for type resolution; the emitted import
  string stays `/scripts/app.js` and `--external '/scripts/*'` keeps it unbundled.

## Consequences

- **Positive**: static type checking at the version-sensitive frontend seam;
  output is still plain browser ESM served as a static file (no runtime bundler,
  no framework); `knip` + `tsc` + Vitest + Biome give a complete local gate
  chain; Vitest imports the `.ts` source directly (no build dependency in tests).
- **Negative**: the edit → refresh loop now requires a `bun run build` step; a
  build artifact must exist before the registry publish (CI wires this); one more
  dev-dependency set (`typescript`, `@comfyorg/comfyui-frontend-types`, `knip`)
  and a `tsconfig.json` to maintain.

## Supersedes

This replaces the earlier vanilla-JS approach (a single `web/js/<short>.js` with
copied-in `modal-shell.js` / `modal-fuzzy.js`). The modal primitives are now
consumed from `@laurigates/comfy-modal-kit` and `bun build` inlines them.
