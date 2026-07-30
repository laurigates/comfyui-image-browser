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

# Run the full test suite (pytest + Vitest).
[group: "quality"]
test:
    uv run pytest -v
    bun run test

# Typecheck + build + lint + test in one shot — the local CI gate.
[group: "quality"]
check: typecheck build lint test check-xmp-drift check-thumb-cache-drift

##########
# Vendored code
##########

# Canonical home of the shared XMP rating module (vendored verbatim here).
xmp-upstream := "https://raw.githubusercontent.com/laurigates/comfyui-gallery-loader/main/xmp_meta.py"

# Canonical home of the shared thumbnail-cache module (vendored verbatim here).
thumb-cache-upstream := "https://raw.githubusercontent.com/laurigates/comfyui-gallery-loader/main/thumb_cache.py"

# Re-sync the vendored xmp_meta.py from its canonical home.
[group: "vendored"]
sync-xmp:
    curl -fsSL {{xmp-upstream}} -o xmp_meta.py
    @echo "xmp_meta.py synced from comfyui-gallery-loader@main"

# Re-sync the vendored thumb_cache.py from its canonical home.
[group: "vendored"]
sync-thumb-cache:
    curl -fsSL {{thumb-cache-upstream}} -o thumb_cache.py
    @echo "thumb_cache.py synced from comfyui-gallery-loader@main"

# Fail if the vendored xmp_meta.py has drifted from the canonical copy.
[group: "vendored"]
check-xmp-drift:
    @curl -fsSL {{xmp-upstream}} | diff -u - xmp_meta.py \
        && echo "xmp_meta.py matches canonical" \
        || { echo "DRIFT: xmp_meta.py differs from comfyui-gallery-loader@main — run 'just sync-xmp' (or land the fix upstream first)"; exit 1; }

# Fail if the vendored thumb_cache.py has drifted from the canonical copy.
[group: "vendored"]
check-thumb-cache-drift:
    @curl -fsSL {{thumb-cache-upstream}} | diff -u - thumb_cache.py \
        && echo "thumb_cache.py matches canonical" \
        || { echo "DRIFT: thumb_cache.py differs from comfyui-gallery-loader@main — run 'just sync-thumb-cache' (or land the fix upstream first)"; exit 1; }

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
