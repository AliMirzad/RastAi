#!/usr/bin/env node
// UI tests for the popup and the page-side font size / override handling.
// They need real CSS layout (zoom, :not() matching), so they run the real
// popup.js and content.js in headless Chrome against a stubbed extension
// API. No dependencies: only a local Chrome or Chromium.
//
//   node tools/ui.test.js
//   CHROME_PATH=/path/to/chrome node tools/ui.test.js
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { pathToFileURL } = require("url");

function findChrome() {
  const c = [
    process.env.CHROME_PATH,
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"
  ];
  return c.find((p) => p && fs.existsSync(p));
}

const chrome = findChrome();
if (!chrome) {
  console.error("ui tests: no Chrome/Chromium found — set CHROME_PATH");
  process.exit(2);
}

const dir = path.join(__dirname, "ui");
const pages = ["content.html", "popup.html?case=fresh", "popup.html?case=saved"];

let pass = 0, fail = 0;
for (const page of pages) {
  const [file, query] = page.split("?");
  const url = pathToFileURL(path.join(dir, file)).href + (query ? "?" + query : "");
  let dom = "";
  try {
    dom = execFileSync(chrome, [
      "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
      "--allow-file-access-from-files", "--virtual-time-budget=20000",
      "--user-data-dir=" + path.join(require("os").tmpdir(), "rastai-rtl-ui-test"),
      "--dump-dom", url
    ], { encoding: "utf8", timeout: 60000, stdio: ["ignore", "pipe", "ignore"] });
  } catch (e) { dom = String((e && e.stdout) || ""); }

  const m = dom.match(/<pre id="out">([\s\S]*?)<\/pre>/);
  console.log(page);
  if (!m) { console.log("  FAIL  page produced no results"); fail++; continue; }
  const txt = m[1].replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
  for (const r of JSON.parse(txt)) {
    if (r.ok) { pass++; console.log("  ok    " + r.name); }
    else { fail++; console.log("  FAIL  " + r.name + "\n        " + r.err); }
  }
}

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
