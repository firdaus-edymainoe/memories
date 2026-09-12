export type MtpTarget = {
  vendorId: number;
  productId: number;
  serial: string | null;
  remoteRoot: string;
};

const PREFIX = "mtp://";

export function isMtpPath(rootPath: string) {
  return rootPath.startsWith(PREFIX);
}

export function isPhonePath(rootPath: string) {
  return isMtpPath(rootPath) || rootPath.startsWith("adb://");
}

function hexId(value: number) {
  return value.toString(16).padStart(4, "0");
}

export function parseMtpRoot(rootPath: string): MtpTarget {
  if (!isMtpPath(rootPath)) throw new Error("Not an Android MTP path");
  const rest = rootPath.slice(PREFIX.length);
  const slash = rest.indexOf("/");
  const idPart = slash < 0 ? rest : rest.slice(0, slash);
  const match = idPart.match(/^([0-9a-f]+)-([0-9a-f]+)(?:\.([A-Za-z0-9._:-]+))?$/i);
  if (!match) throw new Error("Invalid MTP device id");
  const remoteRoot = slash < 0 ? "/" : rest.slice(slash);
  if (remoteRoot.includes("..") || /[;`$\\\n\r]/.test(remoteRoot)) {
    throw new Error("Path escapes drive root");
  }
  return {
    vendorId: Number.parseInt(match[1]!, 16),
    productId: Number.parseInt(match[2]!, 16),
    serial: match[3] ?? null,
    remoteRoot: remoteRoot.startsWith("/") ? remoteRoot : `/${remoteRoot}`,
  };
}

export function mtpRoot(vendorId: number, productId: number, serial?: string | null, remoteRoot = "") {
  const id = `${hexId(vendorId)}-${hexId(productId)}${serial ? `.${serial}` : ""}`;
  const remote = remoteRoot ? (remoteRoot.startsWith("/") ? remoteRoot : `/${remoteRoot}`) : "";
  return `${PREFIX}${id}${remote}`;
}
