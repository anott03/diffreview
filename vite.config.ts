import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

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
            const port = request.socket.localPort;
            if (port === undefined) return;
            const origin = request.headers.origin;
            const expectedOrigin = URL.parse(`http://${request.headers.host ?? ""}`)?.origin;
            const devOrigins = new Set(["localhost", "127.0.0.1", "[::1]"].map((host) =>
              new URL(`http://${host}:${port}`).origin));
            if (origin !== undefined && origin === expectedOrigin && devOrigins.has(origin)) {
              proxyRequest.setHeader("origin", apiOrigin);
            }
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
