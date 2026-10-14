import "@fontsource/atkinson-hyperlegible/400.css";
import "@fontsource/atkinson-hyperlegible/700.css";
import "@fontsource-variable/literata";
import { MemoriesClient } from "@memories/client";
import { StrictMode, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { MemoriesApp } from "./App.js";
import "./app.css";

const params = new URLSearchParams(window.location.search);
const api = params.get("api") || "/api";
const token = launchToken();

/**
 * The desktop app opens the UI with `?token=…` (a secret for this launch). Keep it for this
 * window only and remove it from the address bar.
 */
function launchToken() {
  const fromUrl = params.get("token");
  try {
    if (fromUrl) {
      sessionStorage.setItem("memories-token", fromUrl);
      const url = new URL(window.location.href);
      url.searchParams.delete("token");
      window.history.replaceState(window.history.state, "", url);
      return fromUrl;
    }
    return sessionStorage.getItem("memories-token");
  } catch {
    return fromUrl;
  }
}

/** Sample library for local design work and the Vercel stakeholder preview. */
function useDemoData() {
  if (params.get("live") === "1") return false;
  if (params.has("demo")) return true;
  return import.meta.env.VITE_MEMORIES_DEMO === "true";
}

function useDemoAuth() {
  return import.meta.env.VITE_DEMO_AUTH === "true";
}

async function boot() {
  let client = new MemoriesClient(api, token);
  if (useDemoData()) {
    const { demoClient } = await import("./demo.js");
    client = demoClient();
  }

  let tree: ReactNode = <MemoriesApp client={client} />;
  if (useDemoAuth()) {
    const { DemoGate } = await import("./DemoGate.js");
    tree = <DemoGate>{tree}</DemoGate>;
  }

  createRoot(document.getElementById("root")!).render(<StrictMode>{tree}</StrictMode>);
}

void boot();
