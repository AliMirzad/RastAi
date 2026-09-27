#!/usr/bin/env node
/*
 * Drives tools/browser-tests.html through headless Chrome and reports the
 * result. Prefers CHROME env var; otherwise probes common install paths on
 * Windows, macOS, and Linux. Falls back to a helpful message so a
 * developer without Chrome can still open the .html file by hand.
 */
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const CANDIDATES = [
  process.env.CHROME,
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser"
].filter(Boolean);

function findChrome() {
  for (const p of CANDIDATES) if (fs.existsSync(p)) return p;
  return null;
}

const chrome = findChrome();
if (!chrome) {
  console.error("Chrome not found. Set the CHROME env var, or open");
  console.error("  tools/browser-tests.html");
  console.error("in any browser.");
  process.exit(2);
}

const suites = [
  { name: "regression harness", file: "browser-tests.html"   },
  { name: "bidi visual tests",  file: "bidi-tests.html"      },
  { name: "java generic tests", file: "generic-tests.html"   },
  { name: "typography + sites", file: "typography-tests.html"},
  { name: "table hardening",    file: "table-tests.html"     },
  { name: "popup layout",       file: "popup-layout-tests.html",
    flags: ["--allow-file-access-from-files", "--virtual-time-budget=8000"] }
];

let anyFail = false;
for (const s of suites) {
  const url = "file://" + path.resolve(__dirname, s.file).replace(/\\/g, "/");
  const args = ["--headless=new", "--disable-gpu"].concat(s.flags || []).concat(["--dump-dom", url]);
  let out;
  try { out = execFileSync(chrome, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }); }
  catch (e) { console.error(s.name + " chrome failed:", e.message); anyFail = true; continue; }
  const summary = /<div id="summary"[^>]*>([^<]+)<\/div>/.exec(out);
  const title = /<title>([^<]+)<\/title>/.exec(out);
  console.log(s.name.padEnd(24) + " " + (title ? title[1] : "?") +
              (summary ? "  — " + summary[1] : ""));
  if (title && /FAIL/.test(title[1])) anyFail = true;
}
process.exit(anyFail ? 1 : 0);
