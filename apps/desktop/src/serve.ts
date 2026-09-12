import { serve } from "@hono/node-server";
import { createLocalApp } from "./host.js";

const PORT = Number(process.env.MEMORIES_PORT || 47821);

const hono = await createLocalApp(process.env.MEMORIES_DB);
serve({ fetch: hono.fetch, hostname: "127.0.0.1", port: PORT }, (info) => {
  console.log(`Memories API http://127.0.0.1:${info.port}`);
});
