import { configDefaults, defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    /**
     * Node, not jsdom. Components are tested by rendering them to HTML with
     * react-dom/server, which needs no browser. Add jsdom only when a test
     * genuinely needs clicks or browser APIs.
     */
    environment: "node",
    include: ["src/**/*.test.{ts,tsx}", "test/**/*.test.ts"],
    exclude: [...configDefaults.exclude],
    // Database tests start PGlite (real PostgreSQL compiled to WebAssembly);
    // the first start can take several seconds while other files run.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src"),
      // see test/mocks/server-only.ts
      "server-only": path.resolve(import.meta.dirname, "test/mocks/server-only.ts"),
    },
  },
});
