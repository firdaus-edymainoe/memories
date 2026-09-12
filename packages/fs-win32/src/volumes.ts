import type { VolumePresence, Volumes } from "@memories/core";
import { access } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

async function volumeSerial(letter: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync("cmd.exe", ["/c", `vol ${letter}:`], { windowsHide: true });
    const match = stdout.match(/serial number is\s+(\S+)/i);
    if (match?.[1]) return match[1];
  } catch {
    /* ignore */
  }
  return `win:${letter}`;
}

export class Win32Volumes implements Volumes {
  async list(): Promise<VolumePresence[]> {
    const found: VolumePresence[] = [];
    for (const letter of "ABCDEFGHIJKLMNOPQRSTUVWXYZ") {
      const mountPath = `${letter}:\\`;
      try {
        await access(mountPath);
        found.push({
          volumeId: await volumeSerial(letter),
          mountPath,
          label: `${letter}:`,
        });
      } catch {
        /* letter not mounted */
      }
    }
    return found;
  }

  async identify(rootPath: string): Promise<VolumePresence> {
    const volumes = await this.list();
    const match = volumes
      .filter((volume) => rootPath.toLowerCase().startsWith(volume.mountPath.toLowerCase().slice(0, 2)))
      .sort((a, b) => b.mountPath.length - a.mountPath.length)[0];
    if (match) return match;
    const letter = rootPath.slice(0, 1).toUpperCase();
    return {
      volumeId: await volumeSerial(letter),
      mountPath: `${letter}:\\`,
      label: `${letter}:`,
    };
  }
}
