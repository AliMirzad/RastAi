#!/usr/bin/env node
/*
 * Accuracy runner for the direction engine.
 *
 *   node tools/accuracy.js                 report accuracy on the corpus
 *   node tools/accuracy.js --verbose       list every case, not just failures
 *   node tools/accuracy.js --code          run codeDirection() instead
 *   node tools/accuracy.js --json          machine-readable summary
 *   node tools/accuracy.js extra.json      also run a harvested/holdout corpus
 *
 * Reports total/passed/failed, RTL and LTR precision & recall, accuracy by
 * category, per-rule firing, and a detailed failure list with the signals
 * the engine actually saw (Persian/Latin word counts, first-strong direction,
 * category and source).
 *
 * A harvested corpus comes from the extension's diagnostics mode: turn it
 * on, open a real conversation, copy the JSON, correct any `expect` the
 * engine got wrong, and drop the file in here. That is how this set grows
 * with real text instead of invented examples.
 */
const fs = require("fs");
const path = require("path");
const E = require(path.join(__dirname, "..", "engine.js"));

const args = process.argv.slice(2);
const verbose = args.includes("--verbose");
const codeMode = args.includes("--code");
const jsonOut = args.includes("--json");
const files = args.filter((a) => !a.startsWith("--"));
if (!files.length) files.push(path.join(__dirname, "corpus.json"));

function textOf(c) { return c.prose !== undefined ? c.prose : (c.text || ""); }
function expectOf(c) { return c.expect !== undefined ? c.expect : (c.expected === undefined ? null : c.expected); }

let total = 0, correct = 0;
const byRule = {};
const byCat = {};
const failures = [];
const cm = { rtlOk: 0, rtlMiss: 0, ltrOk: 0, ltrMiss: 0, nullOk: 0, nullMiss: 0, falseRtl: 0, falseLtr: 0, falseNull: 0 };

for (const f of files) {
  const cases = JSON.parse(fs.readFileSync(f, "utf8"));
  for (const c of cases) {
    const text = textOf(c);
    const want = expectOf(c);
    let got, rule;
    if (codeMode) { got = E.codeDirection(text); rule = "code"; }
    else { const v = E.directionOf(text); got = v.dir; rule = v.rule; }

    total++;
    const ok = got === want;
    if (ok) correct++;
    else failures.push({ c, text, want, got, rule, file: path.basename(f) });

    // confusion tallies
    if (want === "rtl") { ok ? cm.rtlOk++ : cm.rtlMiss++; }
    else if (want === "ltr") { ok ? cm.ltrOk++ : cm.ltrMiss++; }
    else { ok ? cm.nullOk++ : cm.nullMiss++; }
    if (!ok) {
      if (got === "rtl") cm.falseRtl++;
      else if (got === "ltr") cm.falseLtr++;
      else cm.falseNull++;
    }

    const rk = String(rule);
    const r = byRule[rk] || (byRule[rk] = { n: 0, ok: 0 });
    r.n++; if (ok) r.ok++;

    const cat = c.category || "uncategorized";
    const b = byCat[cat] || (byCat[cat] = { n: 0, ok: 0 });
    b.n++; if (ok) b.ok++;

    if (verbose) {
      console.log(
        (ok ? "  ok  " : "  FAIL") +
        String(got).padEnd(6) + " r" + rule + "  [" + cat + "]  " +
        (text.length > 46 ? text.slice(0, 46) + "…" : text)
      );
    }
  }
}

const pct = total ? (correct / total * 100) : 0;

function safeDiv(a, b) { return b === 0 ? null : a / b; }
// RTL predicted: rtlOk + falseRtl.  LTR predicted: ltrOk + falseLtr.
const rtlPredicted = cm.rtlOk + cm.falseRtl;
const ltrPredicted = cm.ltrOk + cm.falseLtr;
const rtlActual = cm.rtlOk + cm.rtlMiss;
const ltrActual = cm.ltrOk + cm.ltrMiss;
const rtlPrec = safeDiv(cm.rtlOk, rtlPredicted);
const rtlRec  = safeDiv(cm.rtlOk, rtlActual);
const ltrPrec = safeDiv(cm.ltrOk, ltrPredicted);
const ltrRec  = safeDiv(cm.ltrOk, ltrActual);

if (jsonOut) {
  console.log(JSON.stringify({
    total, correct, failures: failures.length, accuracy: pct,
    rtl: { precision: rtlPrec, recall: rtlRec, actual: rtlActual, predicted: rtlPredicted },
    ltr: { precision: ltrPrec, recall: ltrRec, actual: ltrActual, predicted: ltrPredicted },
    byCategory: byCat, byRule: byRule
  }, null, 2));
  process.exit(failures.length ? 1 : 0);
}

console.log("\ncases " + total + "   passed " + correct + "   failed " + failures.length +
            "   accuracy " + pct.toFixed(1) + "%\n");

function pctOrDash(v) { return v === null ? "  —  " : (v * 100).toFixed(1) + "%"; }
console.log("direction precision / recall:");
console.log("  RTL   precision " + pctOrDash(rtlPrec) + "   recall " + pctOrDash(rtlRec) +
            "   (actual " + rtlActual + ", predicted " + rtlPredicted + ")");
console.log("  LTR   precision " + pctOrDash(ltrPrec) + "   recall " + pctOrDash(ltrRec) +
            "   (actual " + ltrActual + ", predicted " + ltrPredicted + ")");
console.log("  null  correct   " + cm.nullOk + " / " + (cm.nullOk + cm.nullMiss));

console.log("\nper rule:");
for (const k of Object.keys(byRule).sort()) {
  const r = byRule[k];
  const name = E.RULE_NAMES[k] || (k === "code" ? "codeDirection()" : "");
  console.log("  rule " + String(k).padEnd(4) + " fired " + String(r.n).padStart(4) +
              "   correct " + String(r.ok).padStart(4) +
              "   " + name);
}

console.log("\nper category:");
const cats = Object.keys(byCat).sort();
for (const k of cats) {
  const b = byCat[k];
  const p = (b.ok / b.n * 100).toFixed(1);
  console.log("  " + k.padEnd(24) + " " + String(b.ok).padStart(3) + "/" +
              String(b.n).padStart(3) + "   " + p + "%");
}

if (failures.length) {
  console.log("\nfailures:");
  for (const f of failures) {
    const s = E.scanText(f.text);
    console.log("  want " + String(f.want).padEnd(5) +
                " got " + String(f.got).padEnd(5) +
                " via rule " + f.rule + "  [" + (f.c.category || "?") + "/" + (f.c.source || "?") + "]  " +
                (f.c.note ? "(" + f.c.note + ")" : ""));
    console.log("    text : " + (f.text.length > 100 ? f.text.slice(0, 100) + "…" : f.text));
    console.log("    scan : pWords=" + s.pWords + " lWords=" + s.lWords +
                " pChars=" + s.pChars + " lChars=" + s.lChars +
                " first=" + (s.first === 1 ? "P" : s.first === 2 ? "L" : "-") +
                " woven=" + s.woven);
  }
}
process.exit(failures.length ? 1 : 0);
