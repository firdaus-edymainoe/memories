import { serve } from "@hono/node-server";
import { configFromEnv } from "./config.js";
import { createCloudServer } from "./server.js";

const config = configFromEnv();
const server = createCloudServer(config);
await server.migrate();
serve({ fetch: server.app.fetch, port: config.port }, (info) => {
  console.log(`Memories cloud on ${config.baseURL} (port ${info.port})`);
});
