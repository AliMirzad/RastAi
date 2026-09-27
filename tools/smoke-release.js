#!/usr/bin/env node
/*
 * Smoke test the built release zip.
 *
 * Extracts dist/RastAI-v<version>.zip to a temp directory, then
 * verifies:
 *   - Manifest parses as JSON.
 *   - Manifest version matches the source manifest.
 *   - Every file referenced in the manifest exists at the expected
 *     path inside the archive.
 *   - Every <link> and <script> in popup.html resolves to a file
 *     inside the archive (relative paths only).
 *   - Every url() in popup.css resolves to a file that exists.
 *   - No unexpected top-level entries slipped in (test files, .git,
 *     node_modules, etc).
 */
const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFileSync } = require("child_process");

const root = path.resolve(__dirname, "..");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
const version = manifest.version;

const zipPath = path.join(root, "dist", "RastAI-v" + version + ".zip");
if (!fs.existsSync(zipPath)) {
  console.error("no zip at " + zipPath + "; run node tools/build-release.js first");
  process.exit(2);
}

const stage = fs.mkdtempSync(path.join(os.tmpdir(), "rastai-rtl-smoke-"));
console.log("extracting to " + stage);

const isWin = process.platform === "win32";
try {
  if (isWin) {
    const cmd = "Expand-Archive -Path '" + zipPath.replace(/\\/g, "\\\\") +
                "' -DestinationPath '" + stage.replace(/\\/g, "\\\\") + "' -Force";
    execFileSync("powershell.exe", ["-NoProfile", "-Command", cmd], { stdio: "inherit" });
  } else {
    execFileSync("unzip", ["-o", zipPath, "-d", stage], { stdio: "inherit" });
  }
} catch (e) {
  console.error("extract failed:", e.message);
  process.exit(2);
}

let failed = 0;
function assert(label, cond, detail) {
  console.log(cond ? "ok    " + label : "FAIL  " + label + (detail ? "  " + detail : ""));
  if (!cond) failed++;
}
function exists(rel) { return fs.existsSync(path.join(stage, rel)); }

// 1. Manifest parses
let extractedManifest;
try {
  extractedManifest = JSON.parse(fs.readFileSync(path.join(stage, "manifest.json"), "utf8"));
} catch (e) {
  console.error("manifest parse failed:", e.message);
  process.exit(2);
}
assert("extracted manifest version matches source", extractedManifest.version === version,
  "extracted=" + extractedManifest.version);
assert("extracted manifest_version is 3", extractedManifest.manifest_version === 3);

// 2. Every referenced runtime file exists
const refs = [];
for (const cs of extractedManifest.content_scripts || []) {
  for (const j of cs.js || []) refs.push(j);
}
if (extractedManifest.action && extractedManifest.action.default_popup) {
  refs.push(extractedManifest.action.default_popup);
}
if (extractedManifest.background) {
  if (extractedManifest.background.service_worker) refs.push(extractedManifest.background.service_worker);
  for (const s of extractedManifest.background.scripts || []) refs.push(s);
}
for (const k of Object.keys(extractedManifest.icons || {})) refs.push(extractedManifest.icons[k]);
for (const w of extractedManifest.web_accessible_resources || []) {
  for (const r of w.resources || []) {
    // Resolve wildcards: fonts/*.woff2
    if (/\*/.test(r)) {
      const dir = path.dirname(r);
      const abs = path.join(stage, dir);
      if (fs.existsSync(abs)) {
        for (const f of fs.readdirSync(abs)) {
          if (f.endsWith(".woff2")) refs.push(path.join(dir, f).replace(/\\/g, "/"));
        }
      }
    } else refs.push(r);
  }
}
for (const rel of Array.from(new Set(refs))) {
  assert("runtime file exists: " + rel, exists(rel));
}

// 3. popup.html resolves its <link> and <script> to real files
const popup = fs.readFileSync(path.join(stage, "popup.html"), "utf8");
const linkRe = /<link\s[^>]*href=["']([^"']+)["']/g;
const scriptRe = /<script\s[^>]*src=["']([^"']+)["']/g;
let m;
while ((m = linkRe.exec(popup))) {
  if (/^https?:/.test(m[1])) continue;
  assert("popup.html link resolves: " + m[1], exists(m[1]));
}
while ((m = scriptRe.exec(popup))) {
  if (/^https?:/.test(m[1])) continue;
  assert("popup.html script resolves: " + m[1], exists(m[1]));
}

// 4. popup.css url() references
if (exists("popup.css")) {
  const css = fs.readFileSync(path.join(stage, "popup.css"), "utf8");
  const urlRe = /url\(["']?([^"')]+)["']?\)/g;
  while ((m = urlRe.exec(css))) {
    if (/^data:|^https?:/.test(m[1])) continue;
    assert("popup.css url() resolves: " + m[1], exists(m[1]));
  }
}

// 5. No forbidden top-level entries
const forbidden = [".git", "node_modules", "tools", "docs", "README.md", "test", "tests"];
const top = fs.readdirSync(stage);
for (const f of forbidden) {
  assert("release does not contain " + f, !top.includes(f),
    "found " + f + " in " + top.join(", "));
}

// 6. All content-script JS parses (real JS parse via `new Function`).
// The scripts reference browser globals (chrome, document, ...) but
// wrapping them in a Function constructor only tests parse validity —
// nothing executes. A syntax error would throw here.
for (const cs of extractedManifest.content_scripts || []) {
  for (const j of cs.js || []) {
    const src = fs.readFileSync(path.join(stage, j), "utf8");
    assert(j + " is non-empty", src.length > 100, "size=" + src.length);
    let parseErr = null;
    try { new Function(src); } catch (e) { parseErr = e.message; }
    assert(j + " parses as valid JS", parseErr === null, parseErr);
  }
}
// popup.js and background.js get the same check.
for (const j of ["popup.js", "background.js"]) {
  if (!exists(j)) continue;
  const src = fs.readFileSync(path.join(stage, j), "utf8");
  let parseErr = null;
  try { new Function(src); } catch (e) { parseErr = e.message; }
  assert(j + " parses as valid JS", parseErr === null, parseErr);
}

// Cleanup
function rmrf(p) {
  if (!fs.existsSync(p)) return;
  const st = fs.statSync(p);
  if (st.isDirectory()) {
    for (const c of fs.readdirSync(p)) rmrf(path.join(p, c));
    fs.rmdirSync(p);
  } else fs.unlinkSync(p);
}
rmrf(stage);

console.log("\n" + (failed ? "FAIL " + failed + " smoke assertions" : "OK — release zip smoke test passed"));
process.exit(failed ? 1 : 0);
