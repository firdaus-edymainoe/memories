import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolveAdbBin } from "./adb-bin.js";

const execFileAsync = promisify(execFile);

export type CommandResult = { stdout: string; stderr: string };

export type Runner = (bin: string, args: string[]) => Promise<CommandResult>;

export const defaultRunner: Runner = async (bin, args) => {
  try {
    const { stdout, stderr } = await execFileAsync(bin, args, { maxBuffer: 64 * 1024 * 1024 });
    return { stdout: String(stdout), stderr: String(stderr) };
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string; message: string };
    throw new Error(err.stderr?.trim() || err.message);
  }
};

export async function adb(runner: Runner, args: string[]) {
  return runner(resolveAdbBin(), args);
}
