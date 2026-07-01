# Screenshot pipeline

Containerized, deterministic README screenshot for `comfyui-image-browser`.
Produces `docs/browser.png` — the full-canvas browser with a populated grid.

## Why containerized

The shot must not depend on whatever models / theme / frontend a dev machine
happens to have. The Docker image pins the ComfyUI release (hence the frontend
bundle) and the Playwright/Chromium revision (the largest source of cross-host
font drift), boots ComfyUI headless on CPU with **no models**, seeds sample
images, opens the browser via the pack's real launcher, and writes a PNG to a
mounted `docs/`. Re-runs are deterministic.

## Run

```sh
just screenshots
```

That is:

```sh
docker build -f screenshots/Dockerfile -t comfyui-image-browser-screenshots .
docker run --rm -v "$(pwd)/docs:/out" comfyui-image-browser-screenshots
```

First build ~4 min (clones ComfyUI, installs CPU torch); cached rebuild ~30 s.

## Iterate without rebuilding

Build once, then mount the fast-changing driver files into the cached image so
each run is ~10–15 s instead of a full rebuild:

```sh
docker build -f screenshots/Dockerfile -t comfyui-image-browser-screenshots .
docker run --rm \
  -v "$(pwd)/docs:/out" \
  -v "$(pwd)/screenshots/capture.mjs:/opt/screenshots/capture.mjs" \
  comfyui-image-browser-screenshots
```

To iterate on the pack's frontend itself, rebuild the bundle and mount it too:
`bun run build` then add
`-v "$(pwd)/web/dist/index.js:/opt/ComfyUI/custom_nodes/comfyui-image-browser/web/dist/index.js"`.

## Files

| File | Role |
|---|---|
| `Dockerfile` | Pins ComfyUI (`COMFYUI_REF`) + Playwright base; clones ComfyUI, installs CPU torch, seeds images, copies the pack. |
| `Dockerfile.dockerignore` | Trims the build context (per-Dockerfile ignore form). |
| `entrypoint.sh` | Boots ComfyUI on `--cpu :8188`, waits for `/system_stats`, runs the driver, asserts `browser.png` exists. |
| `capture.mjs` | Playwright driver — opens the browser via the registered extension command, waits for the grid + decoded thumbs, screenshots the full-canvas `.cmp-dialog`. |
| `seed_images.py` | Paints deterministic sample PNGs into input/output/temp (output fullest — the default tab). Stdlib + PIL only. |
| `package.json` | Pins the `playwright` npm version (keep in lockstep with the Dockerfile `FROM`). |

## Pins (bump deliberately, in lockstep)

- `COMFYUI_REF` (Dockerfile `ARG`) pins the frontend bundle — the render is
  sensitive to it.
- The Playwright version is pinned in **both** the Dockerfile `FROM` and
  `package.json`; bump together.

## Notes

- **Don't hand-edit `docs/browser.png`.** Edit `capture.mjs` / `seed_images.py`
  and regenerate. No CI auto-regeneration; the PNG is committed and refreshed
  manually on the same host.
- Optional `BROWSER_QUERY` env var types a filter into the search before the
  shot (to show the fuzzy-match state): `docker run … -e BROWSER_QUERY=render …`.
