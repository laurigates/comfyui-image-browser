# Changelog

## [0.1.22](https://github.com/laurigates/comfyui-image-browser/compare/comfyui-image-browser-v0.1.21...comfyui-image-browser-v0.1.22) (2026-08-08)


### Features

* **pins:** a pinned view over folders and individual media ([#69](https://github.com/laurigates/comfyui-image-browser/issues/69)) ([51dbf86](https://github.com/laurigates/comfyui-image-browser/commit/51dbf866f309670cb917ae1c902973a10dc827b2))

## [0.1.21](https://github.com/laurigates/comfyui-image-browser/compare/comfyui-image-browser-v0.1.20...comfyui-image-browser-v0.1.21) (2026-08-06)


### Features

* **browser:** filter the grid by media type, server-side ([#65](https://github.com/laurigates/comfyui-image-browser/issues/65)) ([3fda8e3](https://github.com/laurigates/comfyui-image-browser/commit/3fda8e3edd3f4f04aa8f065d695ed3f08ec7b27b))
* **lightbox:** rate and delete from the stock asset viewer ([3e4e1bc](https://github.com/laurigates/comfyui-image-browser/commit/3e4e1bc0cf7b2f3d2c209e31d592a999083103e4))


### Documentation

* **lightbox:** record why /api/viewvideo must never be accepted ([fdaa1c1](https://github.com/laurigates/comfyui-image-browser/commit/fdaa1c16abce71def2af072844ca638824af55c1))

## [0.1.20](https://github.com/laurigates/comfyui-image-browser/compare/comfyui-image-browser-v0.1.19...comfyui-image-browser-v0.1.20) (2026-08-05)


### Features

* **metadata:** read embedded workflows from video containers ([#62](https://github.com/laurigates/comfyui-image-browser/issues/62)) ([085ba82](https://github.com/laurigates/comfyui-image-browser/commit/085ba82731d293693c47e149c096c925b2ecfad3))
* **metadata:** summarize the video node families, incl. MiniMax H3 ([#63](https://github.com/laurigates/comfyui-image-browser/issues/63)) ([1b3fb55](https://github.com/laurigates/comfyui-image-browser/commit/1b3fb55fbfc9981ab193e79a89e919418486d1d7))

## [0.1.19](https://github.com/laurigates/comfyui-image-browser/compare/comfyui-image-browser-v0.1.18...comfyui-image-browser-v0.1.19) (2026-08-03)


### Bug Fixes

* **list:** cap the non-recursive listing too ([#58](https://github.com/laurigates/comfyui-image-browser/issues/58)) ([c043127](https://github.com/laurigates/comfyui-image-browser/commit/c043127e1f7b3d44e3fd069232e592eda9290a79))

## [0.1.18](https://github.com/laurigates/comfyui-image-browser/compare/comfyui-image-browser-v0.1.17...comfyui-image-browser-v0.1.18) (2026-07-31)


### Features

* **sidebar:** star ratings on ComfyUI's stock Media Assets cards ([#56](https://github.com/laurigates/comfyui-image-browser/issues/56)) ([4bc9f4e](https://github.com/laurigates/comfyui-image-browser/commit/4bc9f4e136025690b8c8bc0dc5b7797c96c81d5f))
* **workflow:** load an image's embedded graph from a card ([#55](https://github.com/laurigates/comfyui-image-browser/issues/55)) ([52fb089](https://github.com/laurigates/comfyui-image-browser/commit/52fb0897fef92d9d666734cbcc109602311b3d62))


### Bug Fixes

* **deps:** bump comfy-modal-kit to 0.8.1 so the toast fix is actually live ([#52](https://github.com/laurigates/comfyui-image-browser/issues/52)) ([3d8a5b7](https://github.com/laurigates/comfyui-image-browser/commit/3d8a5b7c676b676684e8ae412d4cad8079261b48))

## [0.1.17](https://github.com/laurigates/comfyui-image-browser/compare/comfyui-image-browser-v0.1.16...comfyui-image-browser-v0.1.17) (2026-07-30)


### Bug Fixes

* **assets:** move the Assets section out of the Live smoke section ([#49](https://github.com/laurigates/comfyui-image-browser/issues/49)) ([18b719b](https://github.com/laurigates/comfyui-image-browser/commit/18b719b69ca8aefb1a1a3a49b2d17660367606cc))
* **scroll:** store the offset before the dialog detaches, and re-assert the restore ([#51](https://github.com/laurigates/comfyui-image-browser/issues/51)) ([960f429](https://github.com/laurigates/comfyui-image-browser/commit/960f429fe1f128fe075e9c6e5632349647723d5a))

## [0.1.16](https://github.com/laurigates/comfyui-image-browser/compare/comfyui-image-browser-v0.1.15...comfyui-image-browser-v0.1.16) (2026-07-30)


### Features

* **metadata:** view and copy an image's generation metadata ([#47](https://github.com/laurigates/comfyui-image-browser/issues/47)) ([5238160](https://github.com/laurigates/comfyui-image-browser/commit/52381603ac82f25683a23fef021c0c0afc2d12b6))

## [0.1.15](https://github.com/laurigates/comfyui-image-browser/compare/comfyui-image-browser-v0.1.14...comfyui-image-browser-v0.1.15) (2026-07-30)


### Bug Fixes

* **assets:** draw the registry banner and sync the display-assets gate ([#44](https://github.com/laurigates/comfyui-image-browser/issues/44)) ([2c3c794](https://github.com/laurigates/comfyui-image-browser/commit/2c3c794c370741e819117c92f847c4f7725170ac))

## [0.1.14](https://github.com/laurigates/comfyui-image-browser/compare/comfyui-image-browser-v0.1.13...comfyui-image-browser-v0.1.14) (2026-07-27)


### Bug Fixes

* make the flat view's cap keep the newest files, not the first walked ([#38](https://github.com/laurigates/comfyui-image-browser/issues/38)) ([d468ba2](https://github.com/laurigates/comfyui-image-browser/commit/d468ba2bc16e55f417e6826b85f5468d017eb824))
* stop flat view loading every thumbnail at once ([#36](https://github.com/laurigates/comfyui-image-browser/issues/36)) ([81e7dc5](https://github.com/laurigates/comfyui-image-browser/commit/81e7dc5282c57c5304880078bad70e93794579ac))

## [0.1.13](https://github.com/laurigates/comfyui-image-browser/compare/comfyui-image-browser-v0.1.12...comfyui-image-browser-v0.1.13) (2026-07-23)


### Features

* flat (recursive) thumbnail view across subfolders ([#33](https://github.com/laurigates/comfyui-image-browser/issues/33)) ([8f1ba0f](https://github.com/laurigates/comfyui-image-browser/commit/8f1ba0f87e9fbcdd426e5ebbbe3abee61912fc83))

## [0.1.12](https://github.com/laurigates/comfyui-image-browser/compare/comfyui-image-browser-v0.1.11...comfyui-image-browser-v0.1.12) (2026-07-17)


### Bug Fixes

* **registry:** shrink registry tarball scan surface + hygiene guard ([#30](https://github.com/laurigates/comfyui-image-browser/issues/30)) ([c2ed7c8](https://github.com/laurigates/comfyui-image-browser/commit/c2ed7c8b64f24306046cb5ca5a2b6cb1010be118))

## [0.1.11](https://github.com/laurigates/comfyui-image-browser/compare/comfyui-image-browser-v0.1.10...comfyui-image-browser-v0.1.11) (2026-07-08)


### Features

* merge folder move into a same-named destination folder ([#28](https://github.com/laurigates/comfyui-image-browser/issues/28)) ([6f36bed](https://github.com/laurigates/comfyui-image-browser/commit/6f36bed073ae35cfbc28e68190a0bf8d965c345b))

## [0.1.10](https://github.com/laurigates/comfyui-image-browser/compare/comfyui-image-browser-v0.1.9...comfyui-image-browser-v0.1.10) (2026-07-07)


### Features

* move directories as well as files ([#26](https://github.com/laurigates/comfyui-image-browser/issues/26)) ([b3d4158](https://github.com/laurigates/comfyui-image-browser/commit/b3d4158d87ca983983123c9b199fa9eaead468ae))

## [0.1.9](https://github.com/laurigates/comfyui-image-browser/compare/comfyui-image-browser-v0.1.8...comfyui-image-browser-v0.1.9) (2026-07-07)


### Features

* add create-folder affordance ([#24](https://github.com/laurigates/comfyui-image-browser/issues/24)) ([c25a04e](https://github.com/laurigates/comfyui-image-browser/commit/c25a04e19308ff9f8c62e7dbe8dc5202f6ebe2c1))

## [0.1.8](https://github.com/laurigates/comfyui-image-browser/compare/comfyui-image-browser-v0.1.7...comfyui-image-browser-v0.1.8) (2026-07-06)


### Features

* adopt kit makeLauncher and in-shell overlay primitives ([#21](https://github.com/laurigates/comfyui-image-browser/issues/21)) ([84780cf](https://github.com/laurigates/comfyui-image-browser/commit/84780cf4149ada3cede2d1208ef44248e19e42da))


### Bug Fixes

* regenerate bun.lock for comfy-modal-kit 0.6.0 ([#23](https://github.com/laurigates/comfyui-image-browser/issues/23)) ([6f083d9](https://github.com/laurigates/comfyui-image-browser/commit/6f083d9ba2db35388831ad7521e0756419d39164))

## [0.1.7](https://github.com/laurigates/comfyui-image-browser/compare/comfyui-image-browser-v0.1.6...comfyui-image-browser-v0.1.7) (2026-07-05)


### Features

* per-directory scroll memory + pinned folders ([#19](https://github.com/laurigates/comfyui-image-browser/issues/19)) ([6ab96e1](https://github.com/laurigates/comfyui-image-browser/commit/6ab96e105321f0f51451537eeb786df4c198e9e7))

## [0.1.6](https://github.com/laurigates/comfyui-image-browser/compare/comfyui-image-browser-v0.1.5...comfyui-image-browser-v0.1.6) (2026-07-05)


### Features

* mobile multi-select, folder delete, scroll preservation, move-destination memory ([#17](https://github.com/laurigates/comfyui-image-browser/issues/17)) ([3f91c5b](https://github.com/laurigates/comfyui-image-browser/commit/3f91c5b8d19953e9c93acc38c195aa77c5b064f5))

## [0.1.5](https://github.com/laurigates/comfyui-image-browser/compare/comfyui-image-browser-v0.1.4...comfyui-image-browser-v0.1.5) (2026-07-04)


### Bug Fixes

* **instrumentation:** log write-endpoint failures, copyable notify(), + registry icon ([#15](https://github.com/laurigates/comfyui-image-browser/issues/15)) ([32d74ec](https://github.com/laurigates/comfyui-image-browser/commit/32d74ec9ceb8b693d33883369bc88c2f6d63402c))

## [0.1.4](https://github.com/laurigates/comfyui-image-browser/compare/comfyui-image-browser-v0.1.3...comfyui-image-browser-v0.1.4) (2026-07-03)


### Bug Fixes

* Android modal position, back-button navigation, and toolbar overlap ([#13](https://github.com/laurigates/comfyui-image-browser/issues/13)) ([f81474c](https://github.com/laurigates/comfyui-image-browser/commit/f81474c91d93187c03986f20e2126c339ba9196b))

## [0.1.3](https://github.com/laurigates/comfyui-image-browser/compare/comfyui-image-browser-v0.1.2...comfyui-image-browser-v0.1.3) (2026-07-03)


### Features

* **thumb:** shared on-disk thumbnail cache + sandboxed /thumb addressing ([#11](https://github.com/laurigates/comfyui-image-browser/issues/11)) ([2b2127c](https://github.com/laurigates/comfyui-image-browser/commit/2b2127c24c2b82651827c75d556ec68c0d3910da))

## [0.1.2](https://github.com/laurigates/comfyui-image-browser/compare/comfyui-image-browser-v0.1.1...comfyui-image-browser-v0.1.2) (2026-07-03)


### Features

* **browser:** vim-style keyboard navigation ([#9](https://github.com/laurigates/comfyui-image-browser/issues/9)) ([cc6a8bb](https://github.com/laurigates/comfyui-image-browser/commit/cc6a8bbce316a34342f4a3c1e0659d79362b8a35))

## [0.1.1](https://github.com/laurigates/comfyui-image-browser/compare/comfyui-image-browser-v0.1.0...comfyui-image-browser-v0.1.1) (2026-07-02)


### Features

* full-canvas image browser + file manager (browse input/output/temp/path, thumbnails, delete/rename/move) ([636687c](https://github.com/laurigates/comfyui-image-browser/commit/636687cef6c670bcccde601f8b9fc8d7042e9b84))
* **rating:** 0..5 star ratings on cards, persisted as XMP ([#4](https://github.com/laurigates/comfyui-image-browser/issues/4)) ([6bcf765](https://github.com/laurigates/comfyui-image-browser/commit/6bcf7652cfe68793db728cbd103bf09d91179597))


### Bug Fixes

* **rating:** enlarge star tap targets for touch ([#5](https://github.com/laurigates/comfyui-image-browser/issues/5)) ([cf4d3bd](https://github.com/laurigates/comfyui-image-browser/commit/cf4d3bd3649da414a39f73e2bef2a38559cc409a))


### Documentation

* **screenshots:** add containerized Playwright pipeline + README hero ([40b8763](https://github.com/laurigates/comfyui-image-browser/commit/40b876351bdf4133c40d657e4927e15d1bac09cd))


### Miscellaneous

* **release:** sync uv.lock self-version via extra-files updater ([#8](https://github.com/laurigates/comfyui-image-browser/issues/8)) ([4faf7cc](https://github.com/laurigates/comfyui-image-browser/commit/4faf7cc94728ffb07908ae2e7ae60563538b67e5))
* **smoke:** add smoke-server + smoke-sync recipes ([#6](https://github.com/laurigates/comfyui-image-browser/issues/6)) ([1c5f13e](https://github.com/laurigates/comfyui-image-browser/commit/1c5f13e79c767d853ef0a6fd2338bc3dfabd14ca))
