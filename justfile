# comfyui-image-browser — task runner. Run `just` (or `just --list`) for recipes.

set positional-arguments

# Show available recipes.
default:
    @just --list

##########
# Quality
##########

# Build the frontend bundle to web/dist/ (bun build).
[group: "quality"]
build:
    bun run build

# Typecheck the TypeScript source (tsc --noEmit; bun emits, tsc only checks).
[group: "quality"]
typecheck:
    bun run typecheck

# Lint Python + TS/JSON (no changes). Mirrors CI, which also format-checks.
[group: "quality"]
lint:
    uv run ruff check .
    uv run ruff format --check .
    bunx @biomejs/biome@2.4.15 check

# Auto-format Python + TS/JSON.
[group: "quality"]
format:
    uv run ruff format .
    uv run ruff check --fix .
    bunx @biomejs/biome@2.4.15 check --write

# Run the fast test suites (pytest + Vitest). Neither has a layout engine —
# see `test-e2e` for the half of the behaviour they structurally cannot see.
[group: "quality"]
test:
    uv run pytest -v
    bun run test

# Run the browser suite (Playwright, real Chromium at a phone viewport). This is
# the only suite that can see the scroll-restore regressions: jsdom performs no
# layout, so it neither clamps `scrollTop` on assignment nor answers 0 from a
# detached element. Serves the CURRENT web/dist bundle, so build first.
[group: "quality"]
test-e2e: build
    bun run test:e2e

# Typecheck + build + lint + test in one shot — the local CI gate.
[group: "quality"]
check: typecheck build lint test test-e2e check-xmp-drift check-thumb-cache-drift check-pins-store-drift

##########
# Vendored code
##########

# xmp_meta.py, thumb_cache.py and pins_store.py are vendored verbatim from
# comfyui-gallery-loader at the commit in scripts/vendored-pin. The checks diff
# against that PINNED commit, never against canonical main, so a canonical merge
# cannot turn an unrelated PR here red (comfyui-gallery-loader#92). The
# scheduled "Vendored sync" workflow opens the PR that moves the pin; to move it
# by hand, run `just bump-vendored`. Logic lives in scripts/vendored.sh.

# Move the pin to a canonical ref (default: main) and re-fetch every vendored file.
[group: "vendored"]
bump-vendored ref="main":
    scripts/vendored.sh bump {{ref}}

# Restore the vendored xmp_meta.py from the pinned canonical commit.
[group: "vendored"]
sync-xmp:
    scripts/vendored.sh sync xmp_meta.py

# Restore the vendored thumb_cache.py from the pinned canonical commit.
[group: "vendored"]
sync-thumb-cache:
    scripts/vendored.sh sync thumb_cache.py

# Restore the vendored pins_store.py from the pinned canonical commit.
[group: "vendored"]
sync-pins-store:
    scripts/vendored.sh sync pins_store.py

# Fail if the vendored xmp_meta.py differs from the pinned canonical commit.
[group: "vendored"]
check-xmp-drift:
    @scripts/vendored.sh check xmp_meta.py

# Fail if the vendored thumb_cache.py differs from the pinned canonical commit.
[group: "vendored"]
check-thumb-cache-drift:
    @scripts/vendored.sh check thumb_cache.py

# Fail if the vendored pins_store.py differs from the pinned canonical commit.
[group: "vendored"]
check-pins-store-drift:
    @scripts/vendored.sh check pins_store.py

# Regenerate the README screenshot (docs/browser.png) via the containerized
# Playwright pipeline. First build ~4 min; cached rebuild ~30 s. See
# screenshots/README.md.
[group: "quality"]
screenshots:
    docker build -f screenshots/Dockerfile -t comfyui-image-browser-screenshots .
    docker run --rm -v "$(pwd)/docs:/out" comfyui-image-browser-screenshots

##########
# Live smoke
##########

# Pinned CPU ComfyUI + this pack + seeded input/output/temp media — the
# CLAUDE.md live-smoke target without touching a real install.
# Run the screenshots image as a local ComfyUI server on :8188 (Ctrl+C stops).
[group: "smoke"]
smoke-server:
    docker build -f screenshots/Dockerfile -t comfyui-image-browser-smoke .
    docker run --rm -it --name ib-smoke -p 8188:8188 --entrypoint bash comfyui-image-browser-smoke -c 'cd /opt/ComfyUI && exec python main.py --cpu --listen 0.0.0.0 --port 8188 --disable-auto-launch'

# Backend .py changes still need a fresh smoke-server (baked into the image);
# after the swap, hard-refresh the browser — no container rebuild or restart.
# Rebuild the frontend bundle and hot-swap it into the running smoke server.
[group: "smoke"]
smoke-sync:
    bun run build
    docker cp web/dist/index.js ib-smoke:/opt/ComfyUI/custom_nodes/comfyui-image-browser/web/dist/index.js
    @echo "bundle swapped — hard-refresh the browser (Cmd+Shift+R)"

##########
# Assets
##########

# Requires rsvg-convert (librsvg): `brew install librsvg` / `apt-get install librsvg2-bin`.
# pyproject [tool.comfy] Icon/Banner point at the raw GitHub PNG URLs, so the
# registry shows a broken image until you rasterize and commit the PNGs.
#
# Rasterize icon.svg + banner.svg to the PNGs the registry serves (commit them).
[group: "assets"]
assets:
    # Placeholder gate: the scaffold ships a letter-initial glyph so the SVGs are
    # valid from commit one, but no pack may PUBLISH it — pyproject already points
    # Icon/Banner at the PNGs this recipe writes, so a forgotten placeholder ships
    # a generic letter tile to registry.comfy.org (nearly happened on
    # comfyui-output-swap). Draw the bespoke pictogram, delete the marker comment.
    grep -q 'PLACEHOLDER-GLYPH' icon.svg banner.svg && { echo "icon.svg/banner.svg still carry the PLACEHOLDER-GLYPH marker — replace the letter glyph with a bespoke pictogram (family spec: #ffb02e line-art on the dark tile) and delete the marker comment before rasterizing."; exit 1; } || true
    rsvg-convert -w 400 -h 400 icon.svg -o icon.png
    rsvg-convert -w 1344 -h 576 banner.svg -o banner.png
    # Consistency gate: the family tile must trim to 346x346+27+27 on a 400x400
    # canvas. A mismatch means the icon drifted off the family spec (wrong
    # canvas size or a full-bleed tile) — see comfy-registry-lifecycle. Skipped
    # when ImageMagick's `identify` is absent (rsvg-convert is the only hard dep).
    command -v identify >/dev/null 2>&1 && { test "$(identify -format '%wx%h/%@' icon.png)" = "400x400/346x346+27+27" || { echo "icon.png off family spec (want 400x400/346x346+27+27)"; exit 1; }; } || true
