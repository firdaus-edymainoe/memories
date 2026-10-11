import { serve } from "@hono/node-server";
import { createLocalApp } from "./host.js";

const PORT = Number(process.env.MEMORIES_PORT || 47821);

async function createFetch(): Promise<(request: Request) => Response | Promise<Response>> {
  if (process.env.MEMORIES_TEST_MODE !== "1") {
    const hono = await createLocalApp(process.env.MEMORIES_DB);
    return hono.fetch;
  }
  const { createApp } = await import("@memories/server");
  const { createTestPorts, createTestRoutes, exitWithParent, requireTestCatalogPath } = await import("./test-hooks.js");
  exitWithParent();
  const state = await createTestPorts(requireTestCatalogPath());
  const app = createApp(state.ports);
  const test = createTestRoutes(state);
  return (request) => (new URL(request.url).pathname.startsWith("/__test/") ? test.fetch(request) : app.fetch(request));
}

const fetch = await createFetch();
serve({ fetch, hostname: "127.0.0.1", port: PORT }, (info) => {
  const mode = process.env.MEMORIES_TEST_MODE === "1" ? " (test mode)" : "";
  console.log(`Memories API http://127.0.0.1:${info.port}${mode}`);
});
