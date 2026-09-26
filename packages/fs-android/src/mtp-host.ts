import { platform } from "node:os";
import { releaseOtherMtpClients } from "./mtp-darwin.js";
import type { MtpDeviceInfo, MtpHost } from "./mtp.js";
import { UsbMtpHost } from "./mtp-usb.js";
import { WpdMtpHost } from "./mtp-wpd.js";

/** Try one MTP stack, then the other. Never leave a half-open session behind. */
export class FallbackMtpHost implements MtpHost {
  constructor(
    private readonly primary: MtpHost,
    private readonly secondary: MtpHost,
  ) {}

  async listDevices() {
    const primary = await this.primary.listDevices();
    if (primary.length) return primary;
    return this.secondary.listDevices();
  }

  async open(device: MtpDeviceInfo) {
    try {
      return await this.primary.open(device);
    } catch (primaryError) {
      await releaseOtherMtpClients();
      await new Promise((resolve) => setTimeout(resolve, 400));
      try {
        return await this.secondary.open(device);
      } catch {
        throw primaryError;
      }
    }
  }
}

export function createOsMtpHost(os = platform()): MtpHost {
  if (os === "win32") return new WpdMtpHost();
  // USB only. libmtp GetStorageInfo fails on Xiaomi, and opening libmtp after
  // node-usb has claimed the interface wedges the pipe until the cable is replugged.
  return new UsbMtpHost();
}
