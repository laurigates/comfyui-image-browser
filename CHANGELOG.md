# Changelog

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
