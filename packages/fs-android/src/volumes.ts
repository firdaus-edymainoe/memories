import type { VolumePresence, Volumes } from "@memories/core";
import { adbRoot } from "./uri.js";
import { adb, defaultRunner, type Runner } from "./run.js";

export class AndroidVolumes implements Volumes {
  constructor(private readonly run: Runner = defaultRunner) {}

  async list(): Promise<VolumePresence[]> {
    let stdout = "";
    try {
      stdout = (await adb(this.run, ["devices", "-l"])).stdout;
    } catch {
      return [];
    }
    const found: VolumePresence[] = [];
    for (const line of stdout.split("\n")) {
      const match = line.match(/^(\S+)\s+device\b(.*)$/);
      if (!match) continue;
      const serial = match[1]!;
      const rest = match[2] ?? "";
      const model = rest.match(/model:(\S+)/)?.[1]?.replaceAll("_", " ") ?? "Android";
      found.push({
        volumeId: serial,
        mountPath: adbRoot(serial, "/sdcard"),
        label: model,
      });
    }
    return found;
  }

  async identify(rootPath: string): Promise<VolumePresence> {
    const volumes = await this.list();
    const match = volumes.find(
      (volume) => rootPath === volume.mountPath || rootPath.startsWith(`${volume.mountPath}/`) || rootPath.startsWith(`adb://${volume.volumeId}/`),
    );
    if (match) {
      return { ...match, mountPath: rootPath.startsWith("adb://") ? rootPath : match.mountPath };
    }
    throw new Error("Android phone not connected. Enable USB debugging and File transfer.");
  }
}
