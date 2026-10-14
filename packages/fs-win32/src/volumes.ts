import type { VolumePresence, Volumes } from "@memories/core";
import { stat } from "node:fs/promises";
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
  /**
   * Spawning `vol` for every drive letter on every poll is slow, so each letter's serial is
   * cached until the device behind it changes (another drive took that letter).
   */
  private readonly ids = new Map<string, { dev: number; volumeId: string }>();

  async list(): Promise<VolumePresence[]> {
    const found: VolumePresence[] = [];
    for (const letter of "ABCDEFGHIJKLMNOPQRSTUVWXYZ") {
      const mountPath = `${letter}:\\`;
      try {
        const { dev } = await stat(mountPath);
        let cached = this.ids.get(letter);
        if (cached?.dev !== dev) {
          cached = { dev, volumeId: await volumeSerial(letter) };
          this.ids.set(letter, cached);
        }
        found.push({
          volumeId: cached.volumeId,
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
