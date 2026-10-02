import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { rewriteDevApiOrigin } from "./src/dev/api-proxy";

const apiOrigin = "http://127.0.0.1:4777";

export default defineConfig({
  root: "src/web",
  plugins: [react(), tailwindcss()],
  worker: { format: "es" },
  server: {
    port: 5173,
    proxy: {
      // Keep this trailing slash. `/api` also matches Vite's `/api.ts`
      // module URL for src/web/api.ts, causing the UI to blank in dev.
      "/api/": {
        target: apiOrigin,
        changeOrigin: true,
        configure(proxy) {
          proxy.on("proxyReq", (proxyRequest, request) => {
            rewriteDevApiOrigin(proxyRequest, request, apiOrigin);
          });
        },
      },
    },
  },
  build: {
    outDir: "../../dist/web",
    emptyOutDir: true,
  },
});
