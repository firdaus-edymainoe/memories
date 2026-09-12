import type { VolumePresence, Volumes } from "@memories/core";
import { execFile } from "node:child_process";
import { readdir, stat } from "node:fs/promises";
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
  async list(): Promise<VolumePresence[]> {
    const found: VolumePresence[] = [
      { volumeId: await volumeUuid("/"), mountPath: "/", label: "Macintosh HD" },
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
        found.push({ volumeId: await volumeUuid(mountPath), mountPath, label: name });
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
