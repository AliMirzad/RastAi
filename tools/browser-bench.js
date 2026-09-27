#!/usr/bin/env node
/*
 * Drives tools/browser-bench.html through headless Chrome and prints
 * the runtime benchmark table.
 *
 * The bench sets window.__perfComplete = true when it finishes and
 * embeds the results as a <script type="application/json" id="bench-json">
 * blob. Chrome's --dump-dom captures the full DOM AFTER page load —
 * we combine it with a long virtual-time-budget so async setTimeout
 * chains inside the bench get to run.
 *
 * If the bench doesn't complete inside the budget we fail loud
 * instead of silently reporting stale numbers.
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
  console.error("Chrome not found. Set the CHROME env var.");
  process.exit(2);
}

const url = "file://" + path.resolve(__dirname, "browser-bench.html").replace(/\\/g, "/");
const args = [
  "--headless=new", "--disable-gpu",
  "--allow-file-access-from-files",
  // Long virtual time budget: the bench does 5+ scenarios × 3-5 runs,
  // each with settle-time. Real wall time is much shorter than this
  // because most of the schedule is setTimeout waiting.
  "--virtual-time-budget=240000",
  "--dump-dom",
  url
];

let out;
try {
  out = execFileSync(chrome, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 300000, maxBuffer: 32 * 1024 * 1024 });
} catch (e) {
  console.error("chrome failed:", e.message);
  process.exit(2);
}

const title = /<title>([^<]+)<\/title>/.exec(out);
if (!title || !/DONE/.test(title[1])) {
  console.error("bench did not complete (title=" + (title ? title[1] : "?") + ")");
  const table = /<pre[^>]*id="out"[^>]*>([\s\S]*?)<\/pre>/.exec(out);
  if (table) console.error("stage:\n" + table[1]);
  process.exit(1);
}

// Print the human-readable table.
const table = /<pre[^>]*id="out"[^>]*>([\s\S]*?)<\/pre>/.exec(out);
if (table) {
  console.log(table[1]
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">"));
}

// If --json was passed, emit the JSON blob too — useful for tooling.
if (process.argv.includes("--json")) {
  const j = /<script[^>]*id="bench-json"[^>]*>([\s\S]*?)<\/script>/.exec(out);
  if (j) console.log("\n" + j[1]);
}
