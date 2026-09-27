import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const dist = path.join(root, "packages/ui/dist");
const appDir = path.join(dist, "app");

await mkdir(appDir, { recursive: true });
await rename(path.join(dist, "index.html"), path.join(appDir, "index.html"));
await rename(path.join(dist, "assets"), path.join(appDir, "assets"));

let html = await readFile(path.join(root, "product.html"), "utf8");
html = html
  .replaceAll('href="./app/"', 'href="/app/"')
  .replaceAll("Open the mock", "Try the preview")
  .replaceAll(">UI mock<", ">Live preview<");

await writeFile(path.join(dist, "index.html"), html);
console.log("Vercel preview: product page at / , demo app at /app/");
