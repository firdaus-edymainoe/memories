import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import { REPO, TZ } from "./env.js";

export type ApiServer = {
  url: string;
  port: number;
  dbPath: string;
  child: ChildProcess;
  logs: () => string;
  stop: () => Promise<void>;
};

export type StartOptions = {
  dbPath?: string;
  testMode?: boolean;
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
};

const TSX = join(REPO, "node_modules", ".bin", process.platform === "win32" ? "tsx.cmd" : "tsx");
const SERVE = join(REPO, "apps", "desktop", "src", "serve.ts");

/** Start the real desktop API (Hono + SQLite + local FS) on a free port. */
export function startApi(options: StartOptions = {}): Promise<ApiServer> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries({ ...process.env, TZ, MEMORIES_PORT: "0", ...options.env })) {
    if (value !== undefined) env[key] = value;
  }
  if (options.testMode !== false) env.MEMORIES_TEST_MODE = "1";
  else delete env.MEMORIES_TEST_MODE;
  env.MEMORIES_TEST_PARENT_PID = String(process.pid);
  if (options.dbPath) env.MEMORIES_DB = options.dbPath;
  else delete env.MEMORIES_DB;
  // Belt and braces: never let a test download or run a real adb.
  env.MEMORIES_ADB ??= join(REPO, "e2e", "support", "no-adb");

  const child = spawn(TSX, [SERVE], { cwd: REPO, env, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout!.on("data", (chunk) => (out += chunk));
  child.stderr!.on("data", (chunk) => (out += chunk));

  const stop = () =>
    new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) return resolve();
      child.once("exit", () => resolve());
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 3000).unref();
    });

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      void stop();
      reject(new Error(`API did not start in time.\n${out}`));
    }, options.timeoutMs ?? 30_000);
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`API exited early with code ${code}.\n${out}`));
    });
    const onData = () => {
      const match = out.match(/Memories API http:\/\/127\.0\.0\.1:(\d+)/);
      if (!match) return;
      clearTimeout(timer);
      child.stdout!.off("data", onData);
      child.removeAllListeners("exit");
      const port = Number(match[1]);
      resolve({ url: `http://127.0.0.1:${port}`, port, dbPath: options.dbPath ?? "", child, logs: () => out, stop });
    };
    child.stdout!.on("data", onData);
  });
}

/** Run the API entry and wait for it to exit (for start-up refusal tests). */
export function runApiToExit(options: StartOptions = {}): Promise<{ code: number | null; output: string }> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries({ ...process.env, TZ, MEMORIES_PORT: "0", ...options.env })) {
    if (value !== undefined) env[key] = value;
  }
  if (options.testMode !== false) env.MEMORIES_TEST_MODE = "1";
  if (options.dbPath) env.MEMORIES_DB = options.dbPath;
  else delete env.MEMORIES_DB;
  return new Promise((resolve) => {
    const child = spawn(TSX, [SERVE], { cwd: REPO, env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout!.on("data", (chunk) => (output += chunk));
    child.stderr!.on("data", (chunk) => (output += chunk));
    const timer = setTimeout(() => child.kill("SIGKILL"), options.timeoutMs ?? 20_000);
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve({ code, output });
    });
  });
}
