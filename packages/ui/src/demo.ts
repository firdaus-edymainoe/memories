import type { MemoriesClient } from "@memories/client";
import type {
  BackupJob,
  BackupRun,
  CloudAdminUser,
  CloudDriveProvider,
  CloudRole,
  CloudStatus,
  CloudUser,
  ConnectedDrive,
  DirEntry,
  Drive,
  EventCluster,
  FileKind,
  LibraryFile,
} from "@memories/core";

const IMG = [
  "photo-1519741497674-611481863552",
  "photo-1502082553048-f009c37129b9",
  "photo-1464349095431-e9a21285b5f3",
  "photo-1507525428034-b723cf961d3e",
  "photo-1414235077428-338989a2e8c0",
  "photo-1556912173-46c336c7fd55",
  "photo-1511895426328-dc8714191300",
  "photo-1476514525535-07fb3b4ae5f1",
  "photo-1530103862676-de8c9debad1d",
  "photo-1469474968028-56623f02e42e",
  "photo-1506744038136-46273834b3fb",
  "photo-1522673607200-164d1b6ce486",
];

const drives: Drive[] = [
  { id: "mac", name: "This Mac · Pictures", kind: "computer", rootPath: "/Users/aisha/Pictures", volumeId: "mac", online: true },
  { id: "phone", name: "Aisha’s phone · Camera", kind: "phone", rootPath: "mtp://18d1-4ee2/DCIM/Camera", volumeId: "mtp:1", online: true },
  { id: "ssd", name: "Summer SSD", kind: "disk", rootPath: "/Volumes/Summer SSD/Family", volumeId: "ssd", online: false },
  { id: "usb", name: "Travel USB", kind: "usb", rootPath: "/Volumes/TRAVEL", volumeId: "usb", online: true },
];

function kindOf(name: string): FileKind {
  if (/\.(jpe?g|png|heic)$/i.test(name)) return "photo";
  if (/\.(mp4|mov)$/i.test(name)) return "video";
  return "document";
}

const seed: [string, string | null, string | null][] = [
  ["First dance.jpg", "2025-08-12T19:40:00", "Kuala Lumpur"],
  ["Garden vows.jpg", "2025-08-12T16:05:00", "Kuala Lumpur"],
  ["Cake cutting.jpg", "2025-08-12T20:10:00", "Kuala Lumpur"],
  ["Speeches.mp4", "2025-08-12T20:30:00", "Kuala Lumpur"],
  ["Family table.jpg", "2025-08-12T18:00:00", "Kuala Lumpur"],
  ["Wedding invitation.pdf", "2025-06-02T10:00:00", null],
  ["Seating plan.xlsx", "2025-07-28T21:00:00", null],
  ["Beach morning.jpg", "2025-12-26T08:10:00", "Langkawi"],
  ["Sandcastle.jpg", "2025-12-26T10:40:00", "Langkawi"],
  ["Boat ride.mp4", "2025-12-27T15:00:00", "Langkawi"],
  ["Sunset walk.jpg", "2025-12-27T19:05:00", "Langkawi"],
  ["Flight tickets.pdf", "2025-11-30T09:00:00", null],
  ["Hotel booking.pdf", "2025-11-30T09:05:00", null],
  ["Adam’s birthday.jpg", "2026-03-18T17:00:00", "Home"],
  ["Blowing candles.mp4", "2026-03-18T17:20:00", "Home"],
  ["Balloons.jpg", "2026-03-18T16:40:00", "Home"],
  ["School report 2026.pdf", "2026-06-20T12:00:00", null],
  ["Science project.docx", "2026-05-02T19:00:00", null],
  ["Family budget 2026.xlsx", "2026-01-03T20:00:00", null],
  ["Recipe book.docx", "2025-10-11T11:00:00", null],
  ["Holiday slideshow.pptx", "2026-01-10T20:00:00", null],
  ["Wi-Fi password.txt", "2025-09-01T09:00:00", null],
  ["Printer driver.dmg", "2026-02-14T10:00:00", null],
  ["Zoom installer.pkg", "2026-04-01T09:00:00", null],
  ["Minecraft setup.exe", "2025-12-24T18:00:00", null],
  ["Tax documents.zip", "2026-04-15T21:00:00", null],
  ["Grandma’s songs.mp3", "2025-09-20T15:00:00", null],
  ["Adam’s game.py", "2026-07-07T16:00:00", null],
  ["Park picnic.jpg", "2026-05-24T13:00:00", "Taman Tasik"],
  ["Ducks.jpg", "2026-05-24T13:30:00", "Taman Tasik"],
  ["Kite flying.mov", "2026-05-24T14:10:00", "Taman Tasik"],
  ["Rainy window.jpg", "2026-09-19T17:00:00", "Home"],
  ["Morning coffee.jpg", "2026-09-22T08:00:00", "Home"],
  ["Passport scan.pdf", null, null],
  ["Old family photo.jpg", null, null],
];

const files: LibraryFile[] = seed.map(([name, takenAt, place], i) => ({
  id: `f${i}`,
  objectHash: `h${i}`,
  name,
  kind: kindOf(name),
  takenAt,
  place,
  inbox: i >= 31,
}));

const imageFor = new Map<string, string>();
let n = 0;
for (const file of files) {
  if (file.kind === "photo") imageFor.set(file.id, `https://images.unsplash.com/${IMG[n++ % IMG.length]}?w=480&q=70`);
}

const events: EventCluster[] = (() => {
  const map = new Map<string, EventCluster>();
  for (const file of files) {
    if (!file.takenAt || file.kind === "document") continue;
    const day = file.takenAt.slice(0, 10);
    const key = `${day}-${file.place}`;
    const cluster = map.get(key) ?? { day, place: file.place, fileIds: [] };
    cluster.fileIds.push(file.id);
    map.set(key, cluster);
  }
  return [...map.values()];
})();

const tree: Record<string, DirEntry[]> = {
  "": [
    { name: "Wedding", relativePath: "Wedding", directory: true, size: 0, kind: null },
    { name: "Langkawi 2025", relativePath: "Langkawi 2025", directory: true, size: 0, kind: null },
    { name: "School", relativePath: "School", directory: true, size: 0, kind: null },
    { name: "Downloads", relativePath: "Downloads", directory: true, size: 0, kind: null },
    ...files.slice(28, 33).map((f) => ({ name: f.name, relativePath: f.name, directory: false, size: 2_400_000, kind: f.kind })),
  ],
  Wedding: files.slice(0, 7).map((f) => ({ name: f.name, relativePath: `Wedding/${f.name}`, directory: false, size: 3_100_000, kind: f.kind })),
  "Langkawi 2025": files.slice(7, 13).map((f) => ({ name: f.name, relativePath: `Langkawi 2025/${f.name}`, directory: false, size: 4_200_000, kind: f.kind })),
  School: files.slice(16, 18).map((f) => ({ name: f.name, relativePath: `School/${f.name}`, directory: false, size: 220_000, kind: f.kind })),
  Downloads: files.slice(22, 28).map((f) => ({ name: f.name, relativePath: `Downloads/${f.name}`, directory: false, size: 88_000_000, kind: f.kind })),
};

let jobs: BackupJob[] = [
  { id: "j1", sourceDriveId: "phone", destDriveId: "ssd", sourceRelativePaths: [""], lastRunAt: "2026-09-12T20:00:00" },
  { id: "j2", sourceDriveId: "mac", destDriveId: "usb", sourceRelativePaths: ["Wedding", "Langkawi 2025"], lastRunAt: null },
];

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let runs: BackupRun[] = [
  {
    id: "r2",
    jobId: "j1",
    trigger: "auto",
    status: "done",
    startedAt: "2026-09-12T20:00:00",
    finishedAt: "2026-09-12T20:03:00",
    copied: 14,
    skipped: 120,
    failed: 0,
    error: null,
  },
  {
    id: "r1",
    jobId: "j2",
    trigger: "manual",
    status: "failed",
    startedAt: "2026-09-10T18:30:00",
    finishedAt: "2026-09-10T18:30:01",
    copied: 0,
    skipped: 0,
    failed: 0,
    error: "Destination drive is offline",
  },
];
const trashed = new Map<string, string>();

export function demoClient(): MemoriesClient {
  const byName = new Map(files.map((f) => [f.name, f.id]));
  // A pretend cloud account, so the preview can show cloud mode. Signing in makes you an admin.
  let cloudUser: CloudUser | null = null;
  let syncOn = false;
  let syncedAt: string | null = null;
  let ownDrives: ConnectedDrive[] = [];
  let people: CloudAdminUser[] = [
    { id: "p1", email: "aisha@example.com", name: "Aisha", role: "user", emailVerified: true, image: null, banned: false, banReason: null, createdAt: "2026-05-01T09:00:00Z" },
    { id: "p2", email: "adam@example.com", name: "Adam", role: "user", emailVerified: false, image: null, banned: false, banReason: null, createdAt: "2026-06-12T09:00:00Z" },
  ];
  const signIn = (email: string, name = "Firdaus") => {
    cloudUser = { id: "me", email, name, role: "admin", emailVerified: true, image: null };
    if (!people.some((p) => p.id === "me")) people = [{ ...cloudUser, banned: false, banReason: null, createdAt: new Date().toISOString() }, ...people];
    return cloudUser;
  };
  const cloudStatus = (): CloudStatus => ({
    available: true,
    serverUrl: "https://cloud.example",
    providers: ["google", "apple", "microsoft", "github"],
    user: cloudUser,
    sync: { enabled: syncOn, pending: 0, lastSyncedAt: syncedAt, error: null, running: false },
    storageDriveId: drives.find((d) => d.rootPath === "cloud://me")?.id ?? null,
    driveProviders: ["google-drive", "onedrive"],
    drives: ownDrives.map((drive) => ({ ...drive, placeId: drives.find((d) => d.rootPath === `cloud://me/drives/${drive.id}`)?.id ?? null })),
  });
  const updatePerson = (id: string, change: Partial<CloudAdminUser>) => {
    people = people.map((p) => (p.id === id ? { ...p, ...change } : p));
    return { ok: true };
  };

  return {
    cloudStatus: async () => cloudStatus(),
    cloudSignIn: async (input: { email: string }) => (await wait(500), signIn(input.email)),
    cloudSignUp: async (input: { email: string; name: string }) => (await wait(500), signIn(input.email, input.name)),
    cloudSignInWith: async () => {
      window.setTimeout(() => signIn("firdaus@example.com"), 1500);
      return { url: "" };
    },
    cloudSignOut: async () => {
      cloudUser = null;
      return { ok: true };
    },
    cloudForgotPassword: async () => ({ ok: true }),
    cloudResendVerification: async () => ({ ok: true }),
    cloudRefresh: async () => cloudUser,
    cloudSetSync: async (enabled: boolean) => {
      await wait(400);
      syncOn = enabled;
      syncedAt = enabled ? new Date().toISOString() : syncedAt;
      return cloudStatus();
    },
    cloudSyncNow: async () => (await wait(600), (syncedAt = new Date().toISOString()), cloudStatus()),
    cloudAddStorage: async () => {
      const drive: Drive = { id: "cloud", name: "Memories Cloud", kind: "cloud", rootPath: "cloud://me", volumeId: "cloud:me", online: true };
      if (!drives.some((d) => d.id === drive.id)) drives.push(drive);
      return drive;
    },
    cloudConnectDrive: async (provider: CloudDriveProvider) => {
      // Pretend the person allowed access in their browser.
      window.setTimeout(() => {
        const n = ownDrives.filter((d) => d.provider === provider).length + 1;
        const email = provider === "google-drive" ? (n === 1 ? "firdaus@gmail.com" : `firdaus.${n}@gmail.com`) : n === 1 ? "firdaus@outlook.com" : `firdaus@work${n}.example`;
        const label = `${provider === "google-drive" ? "Google Drive" : "OneDrive"} (${email})`;
        ownDrives = [...ownDrives, { id: `own${ownDrives.length + 1}`, provider, label, email, status: "connected", connectedAt: new Date().toISOString() }];
      }, 1500);
      return { url: "" };
    },
    cloudAddDrivePlace: async (driveId: string) => {
      const own = ownDrives.find((d) => d.id === driveId)!;
      const rootPath = `cloud://me/drives/${driveId}`;
      const existing = drives.find((d) => d.rootPath === rootPath);
      if (existing) return existing;
      const drive: Drive = { id: `cloud-${driveId}`, name: own.label, kind: "cloud", rootPath, volumeId: `cloud:me/drives/${driveId}`, online: true };
      drives.push(drive);
      return drive;
    },
    cloudRenameDrive: async (driveId: string, label: string) => {
      ownDrives = ownDrives.map((d) => (d.id === driveId ? { ...d, label } : d));
      return ownDrives.find((d) => d.id === driveId)!;
    },
    cloudDisconnectDrive: async (driveId: string) => {
      ownDrives = ownDrives.filter((d) => d.id !== driveId);
      return { ok: true };
    },
    cloudUsers: async (search = "") => {
      const q = search.toLowerCase();
      const users = people.filter((p) => !q || p.email.includes(q) || p.name.toLowerCase().includes(q));
      return { users, total: users.length };
    },
    cloudSetRole: async (id: string, role: CloudRole) => updatePerson(id, { role }),
    cloudBan: async (id: string) => updatePerson(id, { banned: true }),
    cloudUnban: async (id: string) => updatePerson(id, { banned: false }),
    cloudRemoveUser: async (id: string) => {
      people = people.filter((p) => p.id !== id);
      return { ok: true };
    },
    mediaUrl: (id: string) => imageFor.get(id) ?? "",
    thumbUrl: (id: string) => imageFor.get(id) ?? "",
    driveMediaUrl: (_drive: string, path: string) => imageFor.get(byName.get(path.split("/").pop() ?? "") ?? "") ?? "",
    driveThumbUrl: (_drive: string, path: string) => imageFor.get(byName.get(path.split("/").pop() ?? "") ?? "") ?? "",
    pickFolder: async () => "/Users/aisha/Documents",
    health: async () => ({ ok: true }),
    volumes: async () => [{ volumeId: "mtp:2", mountPath: "mtp://2717-ff40", label: "Adam’s Pixel" }],
    volumeEntries: async (_m: string, path = "") => (await wait(600), tree[path] ?? []),
    drives: async () => drives,
    registerDrive: async (input: { name: string; kind: Drive["kind"]; rootPath: string }) => {
      const drive = { id: `d${drives.length}`, volumeId: "x", online: true, ...input };
      drives.push(drive);
      return drive;
    },
    driveFolders: async () => [],
    driveEntries: async (_id: string, path = "") => (await wait(350), tree[path] ?? []),
    files: async () => files.filter((f) => !trashed.has(f.id)),
    trash: async () => files.filter((f) => trashed.has(f.id)).map((f) => ({ ...f, trashedAt: trashed.get(f.id)! })),
    moveToTrash: async (ids: string[]) => {
      for (const id of ids) trashed.set(id, new Date().toISOString());
      return ids.length;
    },
    restoreFromTrash: async (ids: string[]) => {
      for (const id of ids) trashed.delete(id);
      return ids.length;
    },
    deleteForever: async (ids: string[]) => {
      await wait(500);
      for (const id of ids) {
        trashed.delete(id);
        const index = files.findIndex((f) => f.id === id);
        if (index >= 0) files.splice(index, 1);
      }
      return { deleted: ids.length, removed: ids.length * 2, waiting: ["Travel SSD"] };
    },
    emptyTrash: async () => {
      const ids = [...trashed.keys()];
      for (const id of ids) {
        trashed.delete(id);
        const index = files.findIndex((f) => f.id === id);
        if (index >= 0) files.splice(index, 1);
      }
      return { deleted: ids.length, removed: ids.length * 2, waiting: [] };
    },
    exportFiles: async (input: { fileIds: string[] }) => (await wait(700), { exported: input.fileIds.length, failed: [] }),
    versionMediaUrl: (id: string) => imageFor.get(id) ?? "",
    backupRuns: async () => runs,
    setBackupAuto: async (id: string, auto: boolean) => {
      jobs = jobs.map((job) => (job.id === id ? { ...job, auto } : job));
      return jobs.find((job) => job.id === id)!;
    },
    file: async (id: string) => {
      const file = files.find((f) => f.id === id)!;
      return {
        file,
        object: { hash: file.objectHash, size: 1_800_000 + Number(id.slice(1)) * 91_000, mime: "" },
        replicas: [
          { replica: { fileId: id, driveId: "mac", relativePath: file.name, status: "ready", progress: null }, drive: drives[0]! },
          { replica: { fileId: id, driveId: "ssd", relativePath: file.name, status: "ready", progress: null }, drive: drives[2]! },
        ],
        // A sample edited document, to show version history.
        versions:
          file.kind === "document" && Number(id.slice(1)) % 3 === 0
            ? [
                { fileId: id, version: 2, objectHash: file.objectHash, size: 412_000, createdAt: "2026-09-02T09:15:00", current: true, copies: [] },
                {
                  fileId: id,
                  version: 1,
                  objectHash: `${file.objectHash}-v1`,
                  size: 388_000,
                  createdAt: "2026-08-20T16:40:00",
                  current: false,
                  copies: [
                    { replica: { fileId: id, driveId: "ssd", relativePath: file.name, status: "ready", progress: null }, drive: drives[2]! },
                  ],
                },
              ]
            : [],
      };
    },
    placeFile: async (id: string) => {
      const file = files.find((f) => f.id === id)!;
      file.inbox = false;
      return file;
    },
    copyFile: async () => (await wait(900), { fileId: "", driveId: "", relativePath: "" }),
    relocateFile: async () => ({ fileId: "", driveId: "", relativePath: "" }),
    moveToFolder: async () => ({ ok: true }),
    events: async () => events,
    ingest: async () => (await wait(1500), { files: 12, replicas: 12 }),
    folders: async () => [],
    createFolder: async () => ({ id: "", name: "", parentId: null }),
    backups: async () => jobs,
    saveBackup: async (input: { sourceDriveId: string; destDriveId: string; sourceRelativePaths: string[] }) => {
      const job = { id: `j${jobs.length + 1}`, lastRunAt: null, ...input };
      jobs = [...jobs, job];
      return job;
    },
    runBackup: async (id: string) => {
      await wait(2600);
      jobs = jobs.map((job) => (job.id === id ? { ...job, lastRunAt: new Date().toISOString() } : job));
      const now = new Date().toISOString();
      runs = [
        { id: `r${runs.length + 1}`, jobId: id, trigger: "manual", status: "done", startedAt: now, finishedAt: now, copied: 14, skipped: 120, failed: 0, error: null },
        ...runs,
      ];
      return { copied: 14, skipped: 120, failed: 0 };
    },
    sync: async () => ({ ok: true }),
  } as unknown as MemoriesClient;
}
