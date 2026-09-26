import { execFile } from "node:child_process";
import { platform } from "node:os";
import { promisify } from "node:util";

/** macOS Image Capture and Android File Transfer claim the MTP USB interface. */
export async function releaseOtherMtpClients() {
  if (platform() !== "darwin") return;
  const run = promisify(execFile);
  await Promise.allSettled([
    run("killall", ["PTPCamera"], { timeout: 2000 }),
    run("killall", ["Android File Transfer"], { timeout: 2000 }),
  ]);
}
