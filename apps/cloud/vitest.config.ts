/// <reference types="vitest/config" />
import { defineConfig } from "vitest/config";

export default defineConfig({
  // Starting PGlite (Postgres in WebAssembly) takes a few seconds.
  test: { include: ["src/**/*.test.ts"], testTimeout: 30_000 },
});
