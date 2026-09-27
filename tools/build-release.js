#!/usr/bin/env node
/*
 * Build a clean release zip for the extension.
 *
 * Includes only runtime files (JS, HTML, CSS, fonts, icons, manifest).
 * Excludes tests, docs, dev fixtures, .git, node_modules, dist output.
 * The version is read from manifest.json so the artifact name and the
 * package version can never drift apart.
 */
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const root = path.resolve(__dirname, "..");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
const version = manifest.version;
if (!/^\d+\.\d+\.\d+$/.test(version)) {
  console.error("bad manifest version:", version);
  process.exit(2);
}

// The exact list of files that get shipped. Adding a runtime file
// means adding it here — implicit inclusion would let a test or
// scratch file leak into the release.
const files = [
  "manifest.json",
  "background.js",
  "content.js",
  "engine.js",
  "match.js",
  "sites.js",
  "popup.html",
  "popup.css",
  "popup.js",
  "fonts/Vazirmatn-Regular.woff2",
  "fonts/Vazirmatn-Medium.woff2",
  "fonts/Vazirmatn-Bold.woff2",
  "icons/icon16.png",
  "icons/icon32.png",
  "icons/icon48.png",
  "icons/icon128.png"
];

for (const f of files) {
  const p = path.join(root, f);
  if (!fs.existsSync(p)) { console.error("missing", f); process.exit(2); }
}

const outDir = path.join(root, "dist");
if (!fs.existsSync(outDir)) fs.mkdirSync(outDir);
const zipName = "RastAI-v" + version + ".zip";
const zipPath = path.join(outDir, zipName);
if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);

// PowerShell's Compress-Archive is available on every Windows 10+.
// Falls back to /usr/bin/zip on POSIX so the same script works locally
// and on CI.
// Compress-Archive flattens directories when given a file list. Stage
// into a temporary tree first so fonts/ and icons/ survive as
// sub-directories inside the zip.
const stage = path.join(outDir, "_stage_v" + version);
function rmrf(p) {
  if (!fs.existsSync(p)) return;
  const st = fs.statSync(p);
  if (st.isDirectory()) {
    for (const c of fs.readdirSync(p)) rmrf(path.join(p, c));
    fs.rmdirSync(p);
  } else fs.unlinkSync(p);
}
rmrf(stage);
fs.mkdirSync(stage, { recursive: true });
for (const rel of files) {
  const src = path.join(root, rel);
  const dst = path.join(stage, rel);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
}

const isWin = process.platform === "win32";
if (isWin) {
  // Compress-Archive zips the STAGE'S CONTENTS (via the trailing \*),
  // so the archive root is the top-level extension folder.
  const src = path.join(stage, "*").replace(/\\/g, "\\\\");
  const dst = zipPath.replace(/\\/g, "\\\\");
  const cmd = "Compress-Archive -Path '" + src + "' -DestinationPath '" + dst + "' -Force";
  execFileSync("powershell.exe", ["-NoProfile", "-Command", cmd], { stdio: "inherit" });
} else {
  execFileSync("zip", ["-r", zipPath, ...files], { cwd: stage, stdio: "inherit" });
}
rmrf(stage);

const stat = fs.statSync(zipPath);
console.log("built " + zipPath + "  (" + Math.round(stat.size / 1024) + " KB, " + files.length + " files)");
