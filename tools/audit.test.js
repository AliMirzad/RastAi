#!/usr/bin/env node
/*
 * Release audit — pins invariants that must hold across manifest, sites.js
 * and the injected extension resources. Run before every release.
 *
 * Checks:
 *   1. Every host in sites.js STATUS is covered by a manifest
 *      content_scripts match pattern (and vice versa).
 *   2. web_accessible_resources.matches list covers the same hosts
 *      as content_scripts.matches.
 *   3. No unexpected permissions were added — the extension needs
 *      exactly `storage` and `activeTab`.
 *   4. No host_permissions are declared (all site targeting is
 *      already in content_scripts).
 *   5. Popup, engine and content scripts referenced by manifest all
 *      exist on disk.
 */
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
const sites = require(path.join(root, "sites.js"));

let failed = 0;
function eq(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(ok ? "ok    " + label : "FAIL  " + label + "  want=" + JSON.stringify(want) + " got=" + JSON.stringify(got));
  if (!ok) failed++;
}
function assert(label, cond, detail) {
  console.log(cond ? "ok    " + label : "FAIL  " + label + (detail ? "  " + detail : ""));
  if (!cond) failed++;
}

// 1. sites.js STATUS vs manifest matches
const cs = manifest.content_scripts && manifest.content_scripts[0];
assert("manifest has content_scripts[0]", !!cs);
const patterns = (cs && cs.matches) || [];
function hostsFromPatterns(list) {
  return list.map((p) => {
    const m = /^https?:\/\/([^/]+)\//.exec(p);
    return m ? m[1].replace(/^\*\./, "").replace(/^www\./, "") : null;
  }).filter(Boolean);
}
const manifestHosts = new Set(hostsFromPatterns(patterns));
const siteHosts = new Set(Object.keys(sites.STATUS));

for (const h of siteHosts) {
  assert("sites.js host " + JSON.stringify(h) + " is covered by manifest",
    manifestHosts.has(h), "missing from " + Array.from(manifestHosts).join(","));
}
for (const h of manifestHosts) {
  assert("manifest host " + JSON.stringify(h) + " is classified in sites.js",
    siteHosts.has(h), "not in " + Array.from(siteHosts).join(","));
}

// 2. web_accessible_resources hosts vs content_scripts hosts
const war = manifest.web_accessible_resources && manifest.web_accessible_resources[0];
assert("manifest has web_accessible_resources[0]", !!war);
const warHosts = new Set(hostsFromPatterns((war && war.matches) || []));
for (const h of manifestHosts) {
  assert("web_accessible_resources covers " + JSON.stringify(h),
    warHosts.has(h), "not in WAR matches");
}

// 3. Permissions audit
eq("permissions are exactly ['storage', 'activeTab']",
   (manifest.permissions || []).slice().sort(),
   ["activeTab", "storage"]);
assert("no host_permissions declared",
   !manifest.host_permissions || manifest.host_permissions.length === 0,
   "host_permissions=" + JSON.stringify(manifest.host_permissions));
assert("no optional_permissions declared",
   !manifest.optional_permissions || manifest.optional_permissions.length === 0);

// 4. Referenced files exist
const refs = [];
if (cs && cs.js) refs.push(...cs.js);
if (manifest.action && manifest.action.default_popup) refs.push(manifest.action.default_popup);
if (manifest.background) {
  if (manifest.background.service_worker) refs.push(manifest.background.service_worker);
  if (manifest.background.scripts) refs.push(...manifest.background.scripts);
}
for (const key of Object.keys(manifest.icons || {})) refs.push(manifest.icons[key]);
if (manifest.action && manifest.action.default_icon) {
  for (const k of Object.keys(manifest.action.default_icon)) refs.push(manifest.action.default_icon[k]);
}
for (const f of Array.from(new Set(refs))) {
  assert("referenced file exists: " + f,
    fs.existsSync(path.join(root, f)),
    "missing on disk");
}

// 5. Version well-formed
assert("version is semver-like",
  /^\d+\.\d+\.\d+$/.test(manifest.version || ""),
  "version=" + manifest.version);

// 6. No forbidden fields
for (const k of ["update_url", "developer", "storage.managed_schema"]) {
  assert("no " + k + " declared",
    manifest[k] === undefined);
}

// 7. Manifest V3 background must use service_worker only. Chrome MV3
// rejects a background block that also has "scripts" (that key is
// MV2-only). Firefox 121+ supports service_worker in MV3 so a single
// key covers both browsers.
assert("manifest_version is 3", manifest.manifest_version === 3);
if (manifest.background) {
  assert("background.service_worker is set",
    typeof manifest.background.service_worker === "string",
    "background=" + JSON.stringify(manifest.background));
  assert("background.scripts is NOT set (MV2-only, Chrome MV3 rejects it)",
    manifest.background.scripts === undefined,
    "background.scripts=" + JSON.stringify(manifest.background.scripts));
  assert("background.page is NOT set (MV2-only)",
    manifest.background.page === undefined);
  assert("background.persistent is NOT set (MV2-only)",
    manifest.background.persistent === undefined);
}

console.log("\n" + (failed ? "FAIL " + failed + " audit assertions" : "OK — all audit assertions passed"));
process.exit(failed ? 1 : 0);
