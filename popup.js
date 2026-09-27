// Firefox exposes promise-returning APIs on `browser`; its `chrome` alias
// is callback-only. Wrapping the two calls that need a result keeps one
// popup.js working on both without a build step.
const api = typeof browser !== "undefined" ? browser : chrome;

function pget(defaults) {
  return new Promise((r) => api.storage.sync.get(defaults, r));
}
function pset(obj) {
  return new Promise((r) => api.storage.sync.set(obj, r));
}
function pquery(q) {
  return new Promise((r) => api.tabs.query(q, r));
}

const KEY_MODE = "rtlMode";       // "always" | "smart" | "auto"
const KEY_FONT = "fontEnabled";   // boolean
const KEY_DEBUG = "debugMode";    // boolean — developer diagnostics
const KEY_LH = "lineSpacing";     // "compact" | "normal" | "comfortable" — legacy boolean values migrated
const KEY_SITES = "siteOff";      // { host: true } means switched off there
const KEY_OLD_RTL = "rtlEnabled"; // legacy boolean, migrated on load
const KEY_SCALE = "fontScale";    // percent, one of SCALES
const KEY_OVERRIDES = "overrides"; // storage.local: manual flips, hash -> dir

const SCALES = [90, 100, 110, 120, 130];

// Version label and its link come from the manifest, so they can never
// drift out of sync with a release.
const mf = api.runtime.getManifest();
const verEl = document.getElementById("ver");
if (verEl) {
  verEl.textContent = "v" + mf.version;
  if (mf.homepage_url) verEl.href = mf.homepage_url;
  else verEl.removeAttribute("href");
}

const fontEl = document.getElementById("toggle-font");
const modeRadios = document.querySelectorAll('input[name="rtl-mode"]');
const debugEl = document.getElementById("toggle-debug");
const lhSegEl = document.getElementById("lh-seg");
const lhBtns = lhSegEl ? Array.from(lhSegEl.querySelectorAll("button[data-lh]")) : [];
const presetSegEl = document.getElementById("preset-seg");
const presetBtns = presetSegEl ? Array.from(presetSegEl.querySelectorAll("button[data-preset]")) : [];
const siteEl = document.getElementById("toggle-site");
const hostEl = document.getElementById("site-host");
const noteEl = document.getElementById("site-note");

const rowEl = document.getElementById("site-row");
const scaleEl = document.getElementById("scale");
const scaleDownEl = document.getElementById("scale-down");
const scaleUpEl = document.getElementById("scale-up");
const scaleValEl = document.getElementById("scale-val");
const resetEl = document.getElementById("reset");
const resetTextEl = document.getElementById("reset-text");
const resetBtnEl = document.getElementById("reset-btn");

// The tab this popup was opened over. Both facts about it matter: which
// host it is, and whether the extension runs there at all — the second
// comes from the manifest's own match list, so the popup can never
// disagree with what is actually injected.
async function currentTab() {
  try {
    const tabs = await pquery({ active: true, currentWindow: true });
    const url = (tabs && tabs[0] && tabs[0].url) || "";
    const patterns = api.runtime.getManifest().content_scripts[0].matches;
    return {
      url: url,
      host: url ? new URL(url).hostname.replace(/^www\./, "") : "",
      supported: RastAIMatch.matchesAny(url, patterns)
    };
  } catch (_) { return { url: "", host: "", supported: false }; }
}

let host = "";
let supported = false;

api.storage.sync.get(
  { [KEY_MODE]: null, [KEY_FONT]: false, [KEY_DEBUG]: false,
    [KEY_LH]: false, [KEY_SITES]: {}, [KEY_OLD_RTL]: true,
    [KEY_SCALE]: 100 },
  async (res) => {
    const tab = await currentTab();
    host = tab.host;
    supported = tab.supported;
    const offMap = res[KEY_SITES] || {};
    const on = supported && offMap[host] !== true;
    hostEl.textContent = host || "این صفحه";
    siteEl.checked = on;
    siteEl.disabled = !supported;
    setSiteNote(on);
    let mode = res[KEY_MODE];
    if (!mode) {
      mode = res[KEY_OLD_RTL] === false ? "auto" : "smart";
      await pset({ [KEY_MODE]: mode });
    }
    for (const r of modeRadios) r.checked = (r.value === mode);
    fontEl.checked = res[KEY_FONT] === true;
    debugEl.setAttribute("aria-pressed", res[KEY_DEBUG] === true ? "true" : "false");
    showLh(normLh(res[KEY_LH]));
    showScale(SCALES.includes(res[KEY_SCALE]) ? res[KEY_SCALE] : 100);
  }
);

// Three-way classification: supported (verified end-to-end) /
// partially-tested (in manifest, not yet field-tested) /
// unsupported (not in manifest at all). Source of truth: sites.js.
const SITE_NOTE = {
  "supported":       { on: "در این سایت فعال است",
                       off: "در این سایت خاموش است" },
  "partially-tested":{ on: "در این سایت فعال است (در حال بررسی)",
                       off: "در این سایت خاموش است (در حال بررسی)" },
  "unsupported":     { on: "روی این سایت اجرا نمی‌شود",
                       off: "روی این سایت اجرا نمی‌شود" }
};
function siteStatus() {
  if (!supported) return "unsupported";
  return (typeof RastAISites !== "undefined") ? RastAISites.statusFor(host) : "supported";
}
function setSiteNote(on) {
  const status = siteStatus();
  rowEl.classList.toggle("unsupported", status === "unsupported");
  rowEl.classList.toggle("partial",     status === "partially-tested");
  rowEl.classList.toggle("off",         status !== "unsupported" && !on);
  const notes = SITE_NOTE[status] || SITE_NOTE["supported"];
  noteEl.textContent = on ? notes.on : notes.off;
}

async function pushToActiveTab(payload) {
  try {
    const tabs = await pquery({ active: true, currentWindow: true });
    for (const t of tabs) {
      if (!t.id) continue;
      try { const r = api.tabs.sendMessage(t.id, payload); if (r && r.catch) r.catch(() => {}); } catch (_) {}
    }
  } catch (_) { /* ignore */ }
}

for (const r of modeRadios) {
  r.addEventListener("change", async () => {
    if (!r.checked) return;
    await pset({ [KEY_MODE]: r.value });
    pushToActiveTab({ type: "rastai-toggle", mode: r.value });
  });
}

fontEl.addEventListener("change", async () => {
  const enabled = fontEl.checked;
  await pset({ [KEY_FONT]: enabled });
  pushToActiveTab({ type: "rastai-toggle", font: enabled });
});

debugEl.addEventListener("click", async () => {
  const on = debugEl.getAttribute("aria-pressed") !== "true";
  debugEl.setAttribute("aria-pressed", on ? "true" : "false");
  await pset({ [KEY_DEBUG]: on });
  pushToActiveTab({ type: "rastai-toggle", debug: on });
});

// Line spacing 3-way. The stored key is still KEY_LH so pre-v1.40
// users keep their choice; boolean values migrate to strings on read.
function normLh(v) {
  if (v === true) return "comfortable";
  if (v === false || v == null) return "normal";
  return (v === "compact" || v === "normal" || v === "comfortable") ? v : "normal";
}
let lhMode = "normal";
function showLh(v) {
  lhMode = v;
  for (const b of lhBtns) b.setAttribute("aria-checked", b.dataset.lh === v ? "true" : "false");
  syncPresetHighlight();
}
async function setLh(v, opts) {
  showLh(v);
  await pset({ [KEY_LH]: v });
  pushToActiveTab({ type: "rastai-toggle", lineSpacing: v });
  if (opts && opts.viaPreset) return;
  // Manual line-spacing change de-selects a preset (its two settings
  // are no longer both at preset values).
  syncPresetHighlight();
}
for (const b of lhBtns) {
  b.addEventListener("click", () => setLh(b.dataset.lh));
  b.addEventListener("keydown", (e) => {
    const d = { ArrowRight: 1, ArrowLeft: -1, ArrowUp: 1, ArrowDown: -1 }[e.key];
    if (!d) return;
    e.preventDefault();
    const i = lhBtns.indexOf(b);
    const j = (i + d + lhBtns.length) % lhBtns.length;
    lhBtns[j].focus();
    setLh(lhBtns[j].dataset.lh);
  });
}

// Readability presets: shortcuts that write BOTH fontScale AND
// lineSpacing at once. No separate storage key — the preset that
// matches the current pair is highlighted.
const PRESETS = {
  compact:     { fontScale: 95,  lineSpacing: "compact" },
  normal:      { fontScale: 100, lineSpacing: "normal" },
  comfortable: { fontScale: 110, lineSpacing: "comfortable" }
};
function syncPresetHighlight() {
  const match = Object.keys(PRESETS).find((name) => {
    const p = PRESETS[name];
    return p.fontScale === scale && p.lineSpacing === lhMode;
  }) || null;
  for (const b of presetBtns) b.setAttribute("aria-checked", b.dataset.preset === match ? "true" : "false");
}
async function applyPreset(name) {
  const p = PRESETS[name];
  if (!p) return;
  showScale(p.fontScale);
  await pset({ [KEY_SCALE]: p.fontScale, [KEY_LH]: p.lineSpacing });
  pushToActiveTab({ type: "rastai-toggle", fontScale: p.fontScale, lineSpacing: p.lineSpacing });
  showLh(p.lineSpacing);
  syncPresetHighlight();
}
for (const b of presetBtns) {
  b.addEventListener("click", () => applyPreset(b.dataset.preset));
  b.addEventListener("keydown", (e) => {
    const d = { ArrowRight: 1, ArrowLeft: -1, ArrowUp: 1, ArrowDown: -1 }[e.key];
    if (!d) return;
    e.preventDefault();
    const i = presetBtns.indexOf(b);
    const j = (i + d + presetBtns.length) % presetBtns.length;
    presetBtns[j].focus();
    applyPreset(presetBtns[j].dataset.preset);
  });
}

siteEl.addEventListener("change", async () => {
  if (!supported || !host) return;
  const on = siteEl.checked;
  setSiteNote(on);
  // Read-modify-write: the map holds every site the user has switched off,
  // so it must not be replaced wholesale by this one tab's answer.
  const cur = await pget({ [KEY_SITES]: {} });
  const map = cur[KEY_SITES] || {};
  if (on) delete map[host];
  else map[host] = true;
  await pset({ [KEY_SITES]: map });
  pushToActiveTab({ type: "rastai-toggle", siteOn: on });
});

// ---------- text size ----------

let scale = 100;
const fa = (n) => n.toLocaleString("fa-IR");

function showScale(v) {
  scale = v;
  const i = SCALES.indexOf(v);
  scaleValEl.textContent = fa(v) + "٪";
  scaleEl.classList.toggle("changed", v !== 100);
  // aria-disabled rather than disabled: a disabled button drops keyboard
  // focus, so pressing + up to the top would throw the user out of the
  // control.
  scaleDownEl.setAttribute("aria-disabled", i <= 0 ? "true" : "false");
  scaleUpEl.setAttribute("aria-disabled", i >= SCALES.length - 1 ? "true" : "false");
  if (typeof syncPresetHighlight === "function") syncPresetHighlight();
}

async function stepScale(dir) {
  const i = SCALES.indexOf(scale) + dir;
  if (i < 0 || i >= SCALES.length) return;
  showScale(SCALES[i]);
  await pset({ [KEY_SCALE]: scale });
  pushToActiveTab({ type: "rastai-toggle", fontScale: scale });
  syncPresetHighlight();
}

scaleDownEl.addEventListener("click", () => stepScale(-1));
scaleUpEl.addEventListener("click", () => stepScale(1));
// Arrow keys anywhere in the control, as on a native number input.
scaleEl.addEventListener("keydown", (e) => {
  const d = { ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1 }[e.key];
  if (!d) return;
  e.preventDefault();
  stepScale(d);
});

// ---------- manual overrides ----------

function showOverrideCount(n) {
  resetEl.classList.remove("done");
  resetEl.hidden = !n;
  resetTextEl.textContent = "اصلاح‌های ذخیره‌شده: " + fa(n);
}

try {
  api.storage.local.get({ [KEY_OVERRIDES]: {} }, (res) => {
    showOverrideCount(Object.keys((res && res[KEY_OVERRIDES]) || {}).length);
  });
} catch (_) { /* no storage.local: leave the row hidden */ }

resetBtnEl.addEventListener("click", async () => {
  // Only the overrides key: every other setting lives in storage.sync and
  // is not touched. Open tabs see the removal through storage.onChanged
  // and re-evaluate; the message is for the tab in front of the user, so
  // it does not depend on event timing.
  await new Promise((r) => api.storage.local.remove(KEY_OVERRIDES, r));
  pushToActiveTab({ type: "rastai-toggle", clearOverrides: true });
  resetEl.classList.add("done");
  resetTextEl.textContent = "اصلاح‌ها پاک شد";
  // The button that had focus is gone; keep focus inside the callout
  // rather than dropping it on <body>.
  resetTextEl.setAttribute("tabindex", "-1");
  resetTextEl.focus();
});
