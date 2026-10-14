import type { VolumePresence, Volumes } from "@memories/core";
import { execFile } from "node:child_process";
import { readdir, realpath, stat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

function pathOnMount(rootPath: string, mountPath: string) {
  if (rootPath === mountPath) return true;
  if (mountPath === "/") return rootPath.startsWith("/");
  const prefix = mountPath.endsWith("/") ? mountPath : `${mountPath}/`;
  return rootPath.startsWith(prefix);
}

async function volumeUuid(target: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync("diskutil", ["info", target]);
    const match = stdout.match(/Volume UUID:\s+(\S+)/);
    if (match?.[1] && match[1] !== "(null)") return match[1];
    const ident = stdout.match(/Disk \/ Partition UUID:\s+(\S+)/);
    if (ident?.[1]) return ident[1];
  } catch {
    /* fall through */
  }
  return `path:${target}`;
}

export class DarwinVolumes implements Volumes {
  /**
   * `diskutil` is slow and the UI polls presence every few seconds, so each mount's id is cached
   * until the device behind that path changes (a different drive mounted at the same place).
   */
  private readonly ids = new Map<string, { dev: number; volumeId: string }>();

  private async idFor(mountPath: string, dev: number) {
    const cached = this.ids.get(mountPath);
    if (cached?.dev === dev) return cached.volumeId;
    const volumeId = await volumeUuid(mountPath);
    this.ids.set(mountPath, { dev, volumeId });
    return volumeId;
  }

  async list(): Promise<VolumePresence[]> {
    const found: VolumePresence[] = [
      { volumeId: await this.idFor("/", (await stat("/")).dev), mountPath: "/", label: "Macintosh HD" },
    ];
    let names: string[] = [];
    try {
      names = await readdir("/Volumes");
    } catch {
      return found;
    }
    for (const name of names) {
      const mountPath = join("/Volumes", name);
      try {
        const info = await stat(mountPath);
        if (!info.isDirectory()) continue;
        // /Volumes also links the startup disk back to "/"; it is already listed above.
        if ((await realpath(mountPath).catch(() => mountPath)) === "/") continue;
        found.push({ volumeId: await this.idFor(mountPath, info.dev), mountPath, label: name });
      } catch {
        /* unreadable mount */
      }
    }
    return found;
  }

  async identify(rootPath: string): Promise<VolumePresence> {
    const volumes = await this.list();
    const match = volumes
      .filter((volume) => pathOnMount(rootPath, volume.mountPath))
      .sort((a, b) => b.mountPath.length - a.mountPath.length)[0];
    if (match) return match;
    return { volumeId: await volumeUuid(rootPath), mountPath: rootPath, label: rootPath };
  }
}
