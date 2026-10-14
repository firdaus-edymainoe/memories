import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

/**
 * Builds the desktop app into dist/: the Electron main process (with the API, adapters and
 * catalog bundled in), the preload script, and the UI. Native modules stay external.
 */
const desktop = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(desktop, "dist");
mkdirSync(dist, { recursive: true });

await build({
  entryPoints: [join(desktop, "src/main.ts")],
  outfile: join(dist, "main.mjs"),
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  sourcemap: true,
  external: ["electron", "koffi", "usb"],
  // Some bundled dependencies still call require(); give the ESM bundle a working one.
  banner: {
    js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
  },
  logLevel: "info",
});

copyFileSync(join(desktop, "preload.cjs"), join(dist, "preload.cjs"));

if (!process.argv.includes("--skip-ui")) {
  execFileSync("npm", ["run", "build", "-w", "@memories/ui", "--", "--outDir", join(dist, "ui"), "--emptyOutDir"], {
    cwd: join(desktop, "..", ".."),
    stdio: "inherit",
  });
}
