import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

export const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const TZ = "Asia/Kuala_Lumpur";
/** The browser clock is frozen here (MYT noon). Fixture files are dated before it. */
export const FIXED_NOW = new Date("2026-10-11T12:00:00+08:00");
export const UI_ORIGIN = process.env.E2E_UI_ORIGIN ?? "http://127.0.0.1:5173";
