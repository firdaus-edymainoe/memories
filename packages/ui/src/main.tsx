import "@fontsource/atkinson-hyperlegible/400.css";
import "@fontsource/atkinson-hyperlegible/700.css";
import "@fontsource-variable/literata";
import { MemoriesClient } from "@memories/client";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { MemoriesApp } from "./App.js";
import "./app.css";

const params = new URLSearchParams(window.location.search);
const api = params.get("api") || "/api";

/** Sample library for local design work and the Vercel stakeholder preview. */
function useDemoData() {
  if (params.get("live") === "1") return false;
  if (params.has("demo")) return true;
  return import.meta.env.VITE_MEMORIES_DEMO === "true";
}

async function boot() {
  let client = new MemoriesClient(api);
  if (useDemoData()) {
    const { demoClient } = await import("./demo.js");
    client = demoClient();
  }
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <MemoriesApp client={client} />
    </StrictMode>,
  );
}

void boot();
