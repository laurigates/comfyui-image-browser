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

# Lint Python + TS/JSON (no changes).
[group: "quality"]
lint:
    uv run ruff check .
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
check: typecheck build lint test check-xmp-drift

##########
# Vendored code
##########

# Canonical home of the shared XMP rating module (vendored verbatim here).
xmp-upstream := "https://raw.githubusercontent.com/laurigates/comfyui-gallery-loader/main/xmp_meta.py"

# Re-sync the vendored xmp_meta.py from its canonical home.
[group: "vendored"]
sync-xmp:
    curl -fsSL {{xmp-upstream}} -o xmp_meta.py
    @echo "xmp_meta.py synced from comfyui-gallery-loader@main"

# Fail if the vendored xmp_meta.py has drifted from the canonical copy.
[group: "vendored"]
check-xmp-drift:
    @curl -fsSL {{xmp-upstream}} | diff -u - xmp_meta.py \
        && echo "xmp_meta.py matches canonical" \
        || { echo "DRIFT: xmp_meta.py differs from comfyui-gallery-loader@main — run 'just sync-xmp' (or land the fix upstream first)"; exit 1; }

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
