import { defineConfig } from "vite";

export default defineConfig({
  // Electron loads dist/index.html through file:// in the packaged app.
  // Keep JS/CSS asset URLs relative to dist/index.html.
  base: "./",
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
