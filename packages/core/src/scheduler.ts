import type { BackupJob } from "./domain.js";
import type { Ports } from "./ports.js";
import { isBackupRunning, runBackupJob, syncDrivePresence } from "./use-cases.js";

/**
 * Runs automatic backups. Call `tick()` every few seconds from the host. A backup with `auto` on
 * starts when one of its places is plugged in while the other is connected, and otherwise at
 * most once per `interval` while both stay connected (folders on this computer always are).
 */
export class BackupScheduler {
  private online = new Map<string, boolean>();
  private ticking = false;

  constructor(
    private readonly ports: Ports,
    private readonly interval = 60 * 60 * 1000,
  ) {}

  async tick(now = new Date()): Promise<string[]> {
    if (this.ticking) return [];
    this.ticking = true;
    const started: string[] = [];
    try {
      await syncDrivePresence(this.ports);
      const drives = await this.ports.catalog.listDrives();
      const wasOnline = this.online;
      this.online = new Map(drives.map((drive) => [drive.id, drive.online]));

      for (const job of await this.ports.catalog.listBackupJobs()) {
        if (!job.auto || isBackupRunning(job.id)) continue;
        const ends = [job.sourceDriveId, job.destDriveId];
        if (!ends.every((driveId) => this.online.get(driveId))) continue;
        const pluggedIn = ends.some((driveId) => wasOnline.get(driveId) === false);
        if (!pluggedIn && !this.due(job, now)) continue;
        started.push(job.id);
        await runBackupJob(this.ports, job.id, { trigger: "auto" }).catch(() => undefined);
      }
    } finally {
      this.ticking = false;
    }
    return started;
  }

  private due(job: BackupJob, now: Date) {
    if (!job.lastRunAt) return true;
    return now.getTime() - new Date(job.lastRunAt).getTime() >= this.interval;
  }
}
