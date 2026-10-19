import { defineConfig } from "vite";

export default defineConfig({
  server: {
    port: 5173,
    proxy: {
      // Local API backend (server/index.js). Falls through to Vite's
      // 404 when the backend isn't running — callers degrade gracefully.
      "/api": {
        target: "http://localhost:3001",
        changeOrigin: true,
      },
    },
  },
  preview: {
    port: 4173,
  },
  build: {
    minify: "esbuild",
    cssMinify: true,
    sourcemap: false,
    chunkSizeWarningLimit: 600,
    rollupOptions: {
      output: {
        // Fabric is the heaviest static dep: isolate it for long-term caching.
        // (tesseract.js already splits via dynamic import in ocrProvider.)
        manualChunks: {
          fabric: ["fabric"],
        },
      },
    },
  },
});