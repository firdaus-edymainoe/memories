import { serve } from "@hono/node-server";
import { PlainSecretBox } from "@memories/cloud-link";
import { createLocalHost } from "./host.js";

const PORT = Number(process.env.MEMORIES_PORT || 47821);

// Set MEMORIES_CLOUD_URL to try cloud mode against a cloud server (`npm start -w @memories/cloud`).
const { app: hono } = await createLocalHost(process.env.MEMORIES_DB, {}, {
  serverUrl: process.env.MEMORIES_CLOUD_URL ?? null,
  secrets: new PlainSecretBox(),
  openExternal: async (url) => console.log(`Open this to sign in: ${url}`),
});
serve({ fetch: hono.fetch, hostname: "127.0.0.1", port: PORT }, (info) => {
  console.log(`Memories API http://127.0.0.1:${info.port}`);
});
