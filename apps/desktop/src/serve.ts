import { serve } from "@hono/node-server";
import { createApp, DEFAULT_ORIGINS, type AppOptions } from "@memories/server";
import { createLocalPorts, defaultCatalogPath } from "./host.js";
import { osFolderPicker } from "./pick-folder.js";

const PORT = Number(process.env.MEMORIES_PORT || 47821);

/** Browser origins of the UI. The desktop app passes its own; the Vite dev server is the default. */
function allowedOrigins() {
  const extra = (process.env.MEMORIES_UI_ORIGINS ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return [...new Set([...DEFAULT_ORIGINS, ...extra])];
}

/** Exit when the process that started us (the desktop app or a test runner) goes away. */
function exitWithParent() {
  const parent = Number(process.env.MEMORIES_PARENT_PID || process.env.MEMORIES_TEST_PARENT_PID);
  if (!parent) return;
  setInterval(() => {
    try {
      process.kill(parent, 0);
    } catch {
      process.exit(0);
    }
  }, 2000).unref();
}

async function createFetch(): Promise<(request: Request) => Response | Promise<Response>> {
  const options: AppOptions = { allowedOrigins: allowedOrigins() };
  if (process.env.MEMORIES_TEST_MODE !== "1") {
    const ports = await createLocalPorts(process.env.MEMORIES_DB || defaultCatalogPath());
    return createApp(ports, { ...options, pickFolder: osFolderPicker }).fetch;
  }
  const { createTestPorts, createTestRoutes, requireTestCatalogPath } = await import("./test-hooks.js");
  const state = await createTestPorts(requireTestCatalogPath());
  const app = createApp(state.ports, { ...options, pickFolder: state.picker.pick });
  const test = createTestRoutes(state);
  return (request) => (new URL(request.url).pathname.startsWith("/__test/") ? test.fetch(request) : app.fetch(request));
}

exitWithParent();
const fetch = await createFetch();
serve({ fetch, hostname: "127.0.0.1", port: PORT }, (info) => {
  const mode = process.env.MEMORIES_TEST_MODE === "1" ? " (test mode)" : "";
  console.log(`Memories API http://127.0.0.1:${info.port}${mode}`);
});
