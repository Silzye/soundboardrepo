// Stages everything the Node sidecar needs before `tauri dev` / `tauri build`:
//   1. src-tauri/binaries/node-<target-triple>[.exe]   (Tauri "externalBin")
//   2. src-tauri/sidecar-dist/{server.js,node_modules}  (bundled as resources)
//
// The Node binary is a copy of the one running this script, so build with the
// official nodejs.org Node 22 (not a distro package linked against a shared libnode).

import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const win = process.platform === "win32";

let triple;
try {
  triple = execSync("rustc -vV", { encoding: "utf8" }).match(/host:\s*(\S+)/)[1];
} catch {
  console.error("Rust isn't installed (rustc not found). Install it from https://rustup.rs");
  process.exit(1);
}

// 1. node binary
const binDir = path.join(root, "src-tauri", "binaries");
fs.mkdirSync(binDir, { recursive: true });
const nodeDest = path.join(binDir, `node-${triple}${win ? ".exe" : ""}`);
if (!fs.existsSync(nodeDest) || fs.statSync(nodeDest).size !== fs.statSync(process.execPath).size) {
  fs.copyFileSync(process.execPath, nodeDest);
  if (!win) fs.chmodSync(nodeDest, 0o755);
  console.log(`node -> ${path.relative(root, nodeDest)}`);
}

// 2. sidecar sources + production dependencies
const src = path.join(root, "sidecar");
const dist = path.join(root, "src-tauri", "sidecar-dist");
fs.mkdirSync(dist, { recursive: true });
const files = fs.readdirSync(src).filter((f) => f.endsWith(".js") || f === "package.json" || f === "package-lock.json");
for (const f of files) fs.copyFileSync(path.join(src, f), path.join(dist, f));
const installed = path.join(dist, "node_modules", "fluent-ffmpeg");
if (!fs.existsSync(installed)) {
  console.log("installing sidecar dependencies (ffmpeg-static downloads an ffmpeg binary)...");
  const cmd = fs.existsSync(path.join(dist, "package-lock.json")) ? "npm ci --omit=dev" : "npm install --omit=dev";
  execSync(`${cmd} --no-audit --no-fund`, { cwd: dist, stdio: "inherit" });
}
console.log("sidecar ready");
