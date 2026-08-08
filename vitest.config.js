import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    include: ["tests/js/**/*.test.js"],
    environment: "node",
    // Restores `localStorage` in the jsdom files — Node 22+ shadows jsdom's own
    // with an accessor that is undefined without --localstorage-file. See the
    // file's header for the full mechanism.
    setupFiles: ["tests/js/setup-jsdom.js"],
  },
  resolve: {
    alias: {
      // ComfyUI's served-path runtime import. The TS source imports the
      // absolute `/scripts/app.js` form; vitest aliases it to the mock so
      // the pure functions can be imported (and the module side-effect —
      // app.registerExtension — runs against the stub).
      "/scripts/app.js": resolve(__dirname, "tests/js/__mocks__/app.js"),
    },
  },
});
