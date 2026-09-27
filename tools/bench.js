#!/usr/bin/env node
/*
 * Micro-benchmark for engine.js. Measures three shapes:
 *
 *   1. scanText+decide on a single mixed paragraph (repeated N times)
 *   2. 300 paragraph batch: the full corpus repeated to ~300 items
 *   3. streaming-like: growing prefixes of a mixed paragraph
 *
 * Prints ops/sec so before/after comparisons are one glance apart.
 */
const fs = require("fs");
const path = require("path");
const E = require(path.join(__dirname, "..", "engine.js"));

const corpus = JSON.parse(fs.readFileSync(path.join(__dirname, "corpus.json"), "utf8"));

function bench(label, fn, targetMs) {
  targetMs = targetMs || 500;
  // warmup
  for (let i = 0; i < 1000; i++) fn();
  const start = process.hrtime.bigint();
  let iters = 0;
  const deadline = start + BigInt(targetMs) * 1000000n;
  while (process.hrtime.bigint() < deadline) {
    for (let i = 0; i < 1000; i++) fn();
    iters += 1000;
  }
  const elapsed = Number(process.hrtime.bigint() - start) / 1e6;
  const opsPerSec = (iters / (elapsed / 1000));
  console.log("  " + label.padEnd(40) + " " +
              (opsPerSec).toFixed(0).padStart(10) + " ops/sec  (" +
              iters + " in " + elapsed.toFixed(0) + "ms)");
  return opsPerSec;
}

const sampleMixed = "متد isAnnotationPresent() در کلاس Object تعریف شده و در Runtime قابل خواندن است.";
const sampleLong = "Jakarta EE 11 الان شامل مجموعه بزرگی از specificationهاست و Web Profile خودش مخصوص web applications تعریف شده. Spring Boot 4.1.1 حداقل Java 17 می‌خواهد و روی Spring Framework 7 قرار دارد.";

console.log("engine micro-benchmarks");

bench("directionOf(mixed short)", () => E.directionOf(sampleMixed));
bench("directionOf(mixed long)", () => E.directionOf(sampleLong));
bench("scanText(mixed short)", () => E.scanText(sampleMixed));
bench("codeDirection(mixed short)", () => E.codeDirection(sampleMixed));

// 300-paragraph batch: repeat corpus to reach 300
const batch = [];
while (batch.length < 300) for (const c of corpus) batch.push(c.prose || "");
batch.length = 300;

bench("300-paragraph batch (directionOf)", () => {
  for (let i = 0; i < batch.length; i++) E.directionOf(batch[i]);
}, 500);

// Streaming-like: growing prefixes of sampleLong
const prefixes = [];
for (let n = 20; n <= sampleLong.length; n += 20) prefixes.push(sampleLong.slice(0, n));

bench("streaming " + prefixes.length + " prefixes", () => {
  for (let i = 0; i < prefixes.length; i++) E.directionOf(prefixes[i]);
}, 500);

// Isolation pass: the LATIN_RUN / NEEDS_ISO regexes from content.js
// benchmarked here so a regex change is measurable outside the browser.
// This is intentionally a copy of the shipping regexes, not an import.
const ARROWS = "\\u2190-\\u21FF\\u27F0-\\u27FF\\u2900-\\u297F";
const LATIN_RUN = new RegExp(
  "[\\[({]?[\\-/@]*[A-Za-z0-9](?:[A-Za-z0-9._,;:=!<>+*/%&|?~^#\\[\\](){}@\\\\ " + ARROWS + "\\-]*" +
  "[A-Za-z0-9\\]})>])?|[" + ARROWS + "]+", "g");
const NEEDS_ISO = new RegExp("[\\[\\](){}<>=!+*/%&|?~^#;:,@\\\\/" + ARROWS + "]");

const isoSamples = [
  "از Java, Spring استفاده می‌کنیم.",
  "نوع List<String>, Map<String, Integer> بررسی",
  "پورت 127.0.0.1:8080 را ببین",
  "فلگ‌های --force, --verbose بزن",
  "ایمیل user@example.com و admin@example.com",
  "مسیر C:\\Temp, D:\\Project",
  "مسیر /api/users را بگیر"
];

bench("isolation regex over 7 mixed samples", () => {
  for (let i = 0; i < isoSamples.length; i++) {
    LATIN_RUN.lastIndex = 0;
    let m; while ((m = LATIN_RUN.exec(isoSamples[i]))) NEEDS_ISO.test(m[0]);
  }
}, 500);

// Table-heavy: 300 short cells alternating Persian/mixed — mimics a
// long AI answer that contains a big table.
const cells = [];
while (cells.length < 300) {
  cells.push("علی", "Alice", "Java, Spring", "127.0.0.1:8080", "کاربر عادی");
}
cells.length = 300;
bench("table 300 cells (directionOf)", () => {
  for (let i = 0; i < cells.length; i++) E.directionOf(cells[i]);
}, 500);

// ------- content.js hot-path micro-benches -------
// These target the two v1.42 optimizations:
//   1. getOverride fast path when the override map is empty
//   2. applyMarkTo first-write path (no defensive style read)

// FNV-1a over first 200 chars (matches content.js's hashText).
function hashTextOld(text) {
  let h = 2166136261 | 0;
  const n = Math.min(200, text.length);
  for (let i = 0; i < n; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
// Two mock override maps: empty (common case) and a small populated one.
const emptyOverrides = new Map();
const populatedOverrides = new Map();
for (let i = 0; i < 20; i++) populatedOverrides.set(i * 1000 + 1, "ltr");

// Old getOverride (always hashes) vs new (empty-map skip).
function oldGetOverride(text, ovs) {
  if (!text) return null;
  return ovs.get(hashTextOld(text)) || null;
}
function newGetOverride(text, ovs) {
  if (!text) return null;
  if (ovs.size === 0) return null;
  return ovs.get(hashTextOld(text)) || null;
}

const sampleParas = batch.slice(0, 100);
bench("getOverride, empty map — OLD (always hashes)", () => {
  for (let i = 0; i < sampleParas.length; i++) oldGetOverride(sampleParas[i], emptyOverrides);
}, 500);
bench("getOverride, empty map — NEW (fast path)", () => {
  for (let i = 0; i < sampleParas.length; i++) newGetOverride(sampleParas[i], emptyOverrides);
}, 500);
bench("getOverride, populated map (unchanged)", () => {
  for (let i = 0; i < sampleParas.length; i++) newGetOverride(sampleParas[i], populatedOverrides);
}, 500);
