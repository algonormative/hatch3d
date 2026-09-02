/// <reference types="vitest/config" />
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const entry = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  base: "/hatch3d/",
  plugins: [react()],
  optimizeDeps: {
    exclude: ["hatch3d-wasm"],
  },
  build: {
    target: "esnext",
    rollupOptions: {
      // Two pages: the main app, and a redirect stub at /hatch3d/inksight/
      // keeping the old InkSight URL alive now that the tool ships as
      // @endonny/inksight and is hosted at algonormative.github.io/inksight/.
      input: {
        main: entry("./index.html"),
        inksight: entry("./inksight/index.html"),
      },
    },
  },
  worker: {
    format: "es",
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: "./src/test-setup.ts",
    // In-bounds sweep tests iterate many control combos; under full-suite
    // parallel load they exceed the 5s default while staying honest work.
    testTimeout: 30000,
  },
});
