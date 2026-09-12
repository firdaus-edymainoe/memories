export type AdbTarget = {
  serial: string;
  remoteRoot: string;
};

const PREFIX = "adb://";

export function isAdbPath(rootPath: string) {
  return rootPath.startsWith(PREFIX);
}

export function assertSafeRemote(path: string) {
  if (path.includes("..") || /[;`$\\\n\r]/.test(path)) {
    throw new Error("Path escapes drive root");
  }
}

export function quoteShell(value: string) {
  assertSafeRemote(value);
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function parseAdbRoot(rootPath: string): AdbTarget {
  if (!isAdbPath(rootPath)) throw new Error("Not an Android adb path");
  const rest = rootPath.slice(PREFIX.length);
  const slash = rest.indexOf("/");
  const serial = slash < 0 ? rest : rest.slice(0, slash);
  if (!/^[A-Za-z0-9._:-]+$/.test(serial)) throw new Error("Invalid Android serial");
  let remoteRoot = slash < 0 ? "/sdcard" : rest.slice(slash);
  if (!remoteRoot.startsWith("/")) remoteRoot = `/${remoteRoot}`;
  assertSafeRemote(remoteRoot);
  return { serial, remoteRoot };
}

export function adbRoot(serial: string, remoteRoot = "/sdcard/DCIM") {
  if (!/^[A-Za-z0-9._:-]+$/.test(serial)) throw new Error("Invalid Android serial");
  const remote = remoteRoot.startsWith("/") ? remoteRoot : `/${remoteRoot}`;
  assertSafeRemote(remote);
  return `${PREFIX}${serial}${remote}`;
}
