// Vitest setup: restore `localStorage` in the jsdom environment.
//
// Ported verbatim in mechanism from comfyui-gallery-loader's
// tests/js/setup-jsdom.js — both packs hit the identical wall, so keep the two
// in step rather than inventing a second fix.
//
// Node 22+ defines its OWN global `localStorage` accessor, which evaluates to
// `undefined` unless the process was started with `--localstorage-file`. Vitest
// populates the jsdom window's properties onto `globalThis` but SKIPS any name
// already defined there — so jsdom's real Storage never lands, and every jsdom
// test file dies in `beforeEach` on `localStorage.clear()`:
//
//     TypeError: Cannot read properties of undefined (reading 'clear')
//
// Observed on Node v26.5.0 with vitest 4.1.9 / jsdom 29, against test files
// that predate this pack's pin work (16 of them, on origin/main). CI is green
// because it runs a different runtime. A browser always has localStorage, so
// installing a Storage-shaped shim restores the environment the browser
// actually runs in rather than papering over a behaviour difference — the
// pack's own reads are already try/catch-guarded for the private-mode case.
if (typeof globalThis.localStorage === "undefined") {
  const makeStorage = () => {
    const map = new Map();
    return {
      get length() {
        return map.size;
      },
      key: (i) => [...map.keys()][i] ?? null,
      getItem: (k) => (map.has(String(k)) ? map.get(String(k)) : null),
      setItem: (k, v) => {
        map.set(String(k), String(v));
      },
      removeItem: (k) => {
        map.delete(String(k));
      },
      clear: () => {
        map.clear();
      },
    };
  };
  for (const name of ["localStorage", "sessionStorage"]) {
    Object.defineProperty(globalThis, name, {
      value: makeStorage(),
      configurable: true,
      writable: true,
    });
  }
}
