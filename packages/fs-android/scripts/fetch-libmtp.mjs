#!/usr/bin/env node
import { execFile } from "node:child_process";
import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readlinkSync, rmSync, symlinkSync } from "node:fs";
import { arch, platform, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const pkg = join(fileURLToPath(new URL(".", import.meta.url)), "..");

async function formula(name) {
  const { stdout } = await execFileAsync("curl", ["-fsSL", `https://formulae.brew.sh/api/formula/${name}.json`]);
  return JSON.parse(stdout);
}

function bottleUrl(json, macArch) {
  const files = json.bottle?.stable?.files ?? {};
  if (macArch === "arm64") {
    return files.arm64_sequoia ?? files.arm64_sonoma ?? files.arm64_tahoe ?? files.arm64_golden_gate;
  }
  return files.sonoma ?? files.ventura ?? files.monterey;
}

async function downloadBottle(url, dest) {
  await execFileAsync("curl", [
    "-fsSL",
    "-H",
    "Authorization: Bearer QQ==",
    "-H",
    "Accept: application/vnd.oci.image.layer.v1.tar+gzip",
    url,
    "-o",
    dest,
  ]);
}

function findFile(root, match) {
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    for (const name of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, name.name);
      if (name.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (match(name.name, full)) return full;
    }
  }
  return null;
}

function copyReal(from, to) {
  mkdirSync(dirname(to), { recursive: true });
  let src = from;
  for (let i = 0; i < 8; i += 1) {
    const st = lstatSync(src);
    if (!st.isSymbolicLink()) break;
    const target = readlinkSync(src);
    src = target.startsWith("/") ? target : join(dirname(src), target);
  }
  copyFileSync(src, to);
}

async function pour(name, dylibPattern, destName, macArch, destDir, work) {
  const json = await formula(name);
  const bottle = bottleUrl(json, macArch);
  if (!bottle?.url) throw new Error(`No Homebrew bottle for ${name} ${macArch}`);
  const tar = join(work, `${name}-${macArch}.tar.gz`);
  console.log(`Fetching ${name} ${macArch}`);
  await downloadBottle(bottle.url, tar);
  const extract = join(work, `${name}-${macArch}`);
  mkdirSync(extract, { recursive: true });
  await execFileAsync("tar", ["-xzf", tar, "-C", extract]);
  const found = findFile(extract, (file) => dylibPattern.test(file));
  if (!found) throw new Error(`${name} bottle did not contain ${dylibPattern}`);
  copyReal(found, join(destDir, destName));
  return join(destDir, destName);
}

async function fixInstallNames(libmtp, libusb) {
  if (platform() !== "darwin") return;
  await execFileAsync("install_name_tool", ["-id", "@loader_path/libmtp.dylib", libmtp]);
  await execFileAsync("install_name_tool", ["-id", "@loader_path/libusb-1.0.dylib", libusb]);
  const { stdout } = await execFileAsync("otool", ["-L", libmtp]);
  for (const line of stdout.split("\n")) {
    const match = line.trim().match(/^(\S*libusb-1\.0[^\s]*)\s/);
    if (match?.[1] && !match[1].startsWith("@loader_path")) {
      await execFileAsync("install_name_tool", ["-change", match[1], "@loader_path/libusb-1.0.dylib", libmtp]);
    }
  }
  for (const file of [libmtp, libusb]) {
    await execFileAsync("codesign", ["--sign", "-", "--force", "--timestamp=none", file]);
  }
}

async function copyFromBrew(macArch, destDir) {
  if (platform() !== "darwin" || (arch() === "arm64" ? "arm64" : "x64") !== macArch) return false;
  try {
    const { stdout: mtpPrefix } = await execFileAsync("brew", ["--prefix", "libmtp"]);
    const { stdout: usbPrefix } = await execFileAsync("brew", ["--prefix", "libusb"]);
    const libmtp = join(mtpPrefix.trim(), "lib", "libmtp.dylib");
    const libusb = join(usbPrefix.trim(), "lib", "libusb-1.0.dylib");
    if (!existsSync(libmtp) || !existsSync(libusb)) return false;
    copyReal(libusb, join(destDir, "libusb-1.0.dylib"));
    copyReal(libmtp, join(destDir, "libmtp.dylib"));
    await fixInstallNames(join(destDir, "libmtp.dylib"), join(destDir, "libusb-1.0.dylib"));
    console.log(`libmtp → ${join(destDir, "libmtp.dylib")} (Homebrew)`);
    return true;
  } catch {
    return false;
  }
}

async function vendorArch(macArch) {
  const destDir = join(pkg, "vendor", `darwin-${macArch}`);
  mkdirSync(destDir, { recursive: true });
  if (existsSync(join(destDir, "libmtp.dylib")) && existsSync(join(destDir, "libusb-1.0.dylib"))) {
    console.log(`libmtp already at ${join(destDir, "libmtp.dylib")}`);
    return;
  }
  if (await copyFromBrew(macArch, destDir)) return;
  const work = join(tmpdir(), `memories-libmtp-${macArch}-${Date.now()}`);
  mkdirSync(work, { recursive: true });
  try {
    const libusb = await pour("libusb", /^libusb-1\.0(\.\d+)?\.dylib$/, "libusb-1.0.dylib", macArch, destDir, work);
    const libmtp = await pour("libmtp", /^libmtp(\.\d+)?\.dylib$/, "libmtp.dylib", macArch, destDir, work);
    await fixInstallNames(libmtp, libusb);
    const versioned = join(destDir, "libmtp.9.dylib");
    if (!existsSync(versioned)) {
      try {
        symlinkSync("libmtp.dylib", versioned);
      } catch {
        copyFileSync(libmtp, versioned);
      }
    }
    console.log(`libmtp → ${libmtp}`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

if (platform() !== "darwin") {
  console.log("libmtp vendor is macOS-only");
  process.exit(0);
}

const targets = process.argv.includes("--current")
  ? [arch() === "arm64" ? "arm64" : "x64"]
  : ["arm64", "x64"];

try {
  for (const macArch of targets) {
    await vendorArch(macArch);
  }
} catch (error) {
  console.warn(error instanceof Error ? error.message : error);
  if (process.env.npm_lifecycle_event !== "postinstall") process.exit(1);
}
