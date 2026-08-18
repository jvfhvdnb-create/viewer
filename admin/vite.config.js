import { defineConfig } from "vite";

export default defineConfig({
  // Electron loads dist/index.html through file:// in the packaged app.
  // Relative asset URLs are required; absolute /assets URLs produce a blank window.
  base: "./",
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
