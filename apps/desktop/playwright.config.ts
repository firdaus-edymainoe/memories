import { defineConfig } from "@playwright/test";

/** Drives the built Electron app. `npm run test:e2e` builds first. */
export default defineConfig({
  testDir: "./e2e",
  workers: 1,
  timeout: 60_000,
  reporter: "list",
  use: { trace: "retain-on-failure" },
});
