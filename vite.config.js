import { defineConfig } from "vite";

const aiTarget = process.env.VITE_AICONDUCTOR_URL || "https://aiconductor.vercel.app";

// Same-origin proxy so the browser never talks cross-origin to the AI
// provider (avoids CORS preflight failures). Requests to /aiconductor/...
// are forwarded server-side to aiTarget.
const aiProxy = {
  "/aiconductor": {
    target: aiTarget,
    changeOrigin: true,
    secure: true,
    rewrite: (path) => path.replace(/^\/aiconductor/, ""),
  },
};

export default defineConfig({
  server: {
    port: 5173,
    proxy: {
      ...aiProxy,
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
    proxy: aiProxy,
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