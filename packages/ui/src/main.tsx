import { MemoriesClient } from "@memories/client";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { MemoriesApp } from "./App.js";
import "./app.css";

const api = new URLSearchParams(window.location.search).get("api") || "/api";
const client = new MemoriesClient(api);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <MemoriesApp client={client} />
  </StrictMode>,
);
