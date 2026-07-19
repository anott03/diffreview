import { defineConfig } from "vitest/config";

// Separate from vite.config.ts: that one sets root=src/web for the UI build,
// which would hide the server/mcp tests from vitest.
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
  },
});
