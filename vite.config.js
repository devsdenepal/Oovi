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
    proxy: aiProxy,
  },
  preview: {
    port: 4173,
    proxy: aiProxy,
  },
});