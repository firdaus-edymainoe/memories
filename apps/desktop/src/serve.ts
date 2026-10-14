import { serve } from "@hono/node-server";
import { createLocalHost } from "./host.js";

const PORT = Number(process.env.MEMORIES_PORT || 47821);

const { app: hono } = await createLocalHost(process.env.MEMORIES_DB);
serve({ fetch: hono.fetch, hostname: "127.0.0.1", port: PORT }, (info) => {
  console.log(`Memories API http://127.0.0.1:${info.port}`);
});
