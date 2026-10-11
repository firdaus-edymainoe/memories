import { MemoriesError } from "@memories/core";
import { execFile } from "node:child_process";
import { platform } from "node:os";

function run(command: string, args: string[]): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: 10 * 60_000, windowsHide: true }, (error, stdout) => {
      if (error && (error as NodeJS.ErrnoException).code === "ENOENT") return reject(error);
      resolve({ code: error ? Number((error as { code?: number }).code ?? 1) : 0, stdout: String(stdout) });
    });
  });
}

/**
 * The system "choose a folder" dialog, for when the UI runs in a plain browser against the local API.
 * Inside the desktop app the UI asks Electron's dialog over IPC instead. Null when the user cancels.
 */
export async function osFolderPicker(): Promise<string | null> {
  const os = platform();
  try {
    if (os === "darwin") {
      const out = await run("osascript", ["-e", 'POSIX path of (choose folder with prompt "Choose a folder for Memories")']);
      const path = out.stdout.trim().replace(/(.)\/$/, "$1");
      return out.code === 0 && path ? path : null;
    }
    if (os === "win32") {
      const script =
        "Add-Type -AssemblyName System.Windows.Forms; $d = New-Object System.Windows.Forms.FolderBrowserDialog; " +
        "if ($d.ShowDialog() -eq 'OK') { [Console]::Out.Write($d.SelectedPath) }";
      const out = await run("powershell.exe", ["-NoProfile", "-STA", "-Command", script]);
      return out.code === 0 && out.stdout.trim() ? out.stdout.trim() : null;
    }
    const out = await run("zenity", ["--file-selection", "--directory", "--title=Choose a folder for Memories"]);
    return out.code === 0 && out.stdout.trim() ? out.stdout.trim() : null;
  } catch {
    throw new MemoriesError("No folder picker is available here. Type the folder location instead.", 501);
  }
}
