#!/usr/bin/env node
// Checks the popup's "is this a supported site?" logic against the real
// manifest, so adding or mistyping a site shows up here.
const fs = require("fs");
const path = require("path");
const M = require(path.join(__dirname, "..", "match.js"));
const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "manifest.json"), "utf8"));
const patterns = manifest.content_scripts[0].matches;

const cases = [
  ["https://chatgpt.com/", true],
  ["https://chatgpt.com/c/abc-123", true],
  ["https://claude.ai/chat/xyz", true],
  ["https://chat.deepseek.com/a/chat/s/1", true],
  ["https://gemini.google.com/app", true],
  ["https://grok.com/chat", true],
  ["https://perplexity.ai/search?q=x", true],
  ["https://www.perplexity.ai/search", true],
  ["https://uxpilot.ai/", true],
  ["https://www.uxpilot.ai/dashboard", true],
  // must NOT match
  ["https://example.com/", false],
  ["https://google.com/search?q=chatgpt.com", false],
  ["https://x.com/i/grok", false],
  ["https://notchatgpt.com/", false],
  ["https://chatgpt.com.evil.test/", false],
  ["http://chatgpt.com/", false],          // http, not https
  ["https://sub.chatgpt.com/", false],     // no wildcard subdomain declared
  ["chrome-extension://abcdef/popup.html", false],
  ["about:blank", false],
  ["", false],
];

let bad = 0;
for (const [url, want] of cases) {
  const got = M.matchesAny(url, patterns);
  if (got !== want) { bad++; console.log("FAIL want " + want + " got " + got + "  " + url); }
}
console.log(bad ? bad + " failures" : cases.length + " url cases, all correct");
console.log("patterns: " + patterns.length);
process.exit(bad ? 1 : 0);
