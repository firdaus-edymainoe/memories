import { defineConfig, devices } from "@playwright/test";

const CI = !!process.env.CI;
process.env.TZ = "Asia/Kuala_Lumpur";

export default defineConfig({
  testDir: "./e2e/specs",
  outputDir: "./e2e/.results",
  fullyParallel: false,
  forbidOnly: CI,
  retries: CI ? 1 : 0,
  workers: Number(process.env.E2E_WORKERS ?? (CI ? 3 : 2)),
  timeout: 30_000,
  expect: { timeout: 7_000 },
  reporter: CI ? [["list"], ["html", { open: "never", outputFolder: "e2e/.report" }], ["github"]] : [["list"]],
  use: {
    timezoneId: "Asia/Kuala_Lumpur",
    locale: "en-GB",
    reducedMotion: "reduce",
    viewport: { width: 1280, height: 800 },
    trace: CI ? "on-first-retry" : "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "api", testMatch: "api/**/*.spec.ts" },
    { name: "web", testMatch: "web/**/*.spec.ts", use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 800 } } },
    { name: "electron", testMatch: "electron/**/*.spec.ts", workers: 1 },
  ],
  // The UI dev server. The API is started per worker by the fixtures (e2e/support).
  webServer: {
    command: "npm run dev:ui",
    url: "http://127.0.0.1:5173",
    reuseExistingServer: !CI,
    timeout: 60_000,
    stdout: "ignore",
    stderr: "pipe",
  },
});
