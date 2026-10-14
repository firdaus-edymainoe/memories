import { join } from "node:path";
import { fileURLToPath } from "node:url";

let override: string | null = null;

/**
 * Where the bundled `adb` and `libmtp` binaries live. Defaults to this package's `vendor/`
 * folder; the desktop app points it elsewhere when the code is bundled or packaged.
 */
export function vendorDirectory() {
  return override ?? join(fileURLToPath(new URL(".", import.meta.url)), "..", "vendor");
}

export function configureVendorDirectory(directory: string | null) {
  override = directory;
}
