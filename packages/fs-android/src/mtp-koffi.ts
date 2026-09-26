import { createRequire } from "node:module";
import type koffi from "koffi";

export type Koffi = typeof koffi;

export function loadKoffi(): Koffi {
  return createRequire(import.meta.url)("koffi") as Koffi;
}
