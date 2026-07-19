import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  root: "src/web",
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      // Keep this trailing slash. `/api` also matches Vite's `/api.ts`
      // module URL for src/web/api.ts, causing the UI to blank in dev.
      "/api/": "http://127.0.0.1:4777",
    },
  },
  build: {
    outDir: "../../dist/web",
    emptyOutDir: true,
  },
});
