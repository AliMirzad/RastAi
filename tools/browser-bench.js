#!/usr/bin/env node
/* Real-time Chromium renderer benchmark. No dependencies or timer overrides.
 * Requires Node 22+ (built-in fetch/WebSocket), matching the project's CI.
 * Usage: node tools/browser-bench.js [--baseline path/to/content.js] [--runs 3]
 *        [--size 600] [--json]
 * Set CHROME_PATH (or CHROME) to choose Chrome/Chromium/Brave.
 */
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { spawn } = require("node:child_process");
const { once } = require("node:events");

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const candidates = [
  process.env.CHROME_PATH, process.env.CHROME,
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"
].filter(Boolean);

function options() {
  const result = { runs: 3, size: 600, json: false, baseline: null };
  const args = process.argv.slice(2);
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (flag === "--json") result.json = true;
    else if (flag === "--baseline") {
      if (!args[index + 1]) throw new Error("--baseline requires a content.js path");
      result.baseline = path.resolve(args[++index]);
    } else if (flag === "--runs" || flag === "--size") {
      const value = Number(args[++index]);
      const maximum = flag === "--runs" ? 20 : 5000;
      if (!Number.isInteger(value) || value < 1 || value > maximum) {
        throw new Error(flag + " must be an integer between 1 and " + maximum);
      }
      result[flag.slice(2)] = value;
    } else throw new Error("Unknown option: " + flag);
  }
  return result;
}

class CDP {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 0;
    this.pending = new Map();
    socket.addEventListener("message", event => {
      const message = JSON.parse(event.data);
      if (!message.id) return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
    });
    socket.addEventListener("close", () => {
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error("Chromium debugging connection closed"));
      }
      this.pending.clear();
    });
  }
  static async connect(url) {
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.close();
        reject(new Error("Chromium connection timeout"));
      }, 10000);
      socket.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
      socket.addEventListener("error", () => {
        clearTimeout(timer);
        reject(new Error("Could not connect to Chromium"));
      }, { once: true });
    });
    return new CDP(socket);
  }
  send(method, params = {}) {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("CDP timeout: " + method));
      }, 30000);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate(expression) {
    const result = await this.send("Runtime.evaluate", {
      expression, awaitPromise: true, returnByValue: true
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    }
    return result.result.value;
  }
  close() { this.socket.close(); }
}

async function debuggingPort(profile, browser) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (browser.exitCode !== null) throw new Error("Chromium exited before debugging was ready");
    try {
      const port = Number(fs.readFileSync(path.join(profile, "DevToolsActivePort"), "utf8").split("\n")[0]);
      if (port) return port;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    await wait(100);
  }
  throw new Error("Chromium debugging startup timeout");
}

async function metrics(cdp) {
  const result = await cdp.send("Performance.getMetrics");
  return Object.fromEntries(result.metrics.map(metric => [metric.name, metric.value]));
}

async function measure(cdp, name, expression, enabled) {
  await cdp.evaluate("Bench.reset()");
  const before = await metrics(cdp);
  const detail = await cdp.evaluate(expression);
  const after = await metrics(cdp);
  if (enabled && (!detail.marked || !detail.isolated)) {
    throw new Error(name + ": missing completed direction/isolation work");
  }
  if (enabled && (!detail.nativePunctuation || !detail.punctuationCorrect)) {
    throw new Error(name + ": native-BDI punctuation regressed");
  }
  if (!enabled && (detail.marked || detail.isolated || detail.nativePunctuation)) {
    throw new Error(name + ": OFF renderer unexpectedly modified the fixture");
  }
  const delta = key => (after[key] - before[key]) * 1000;
  return {
    name, wallMs: delta("Timestamp"), cpuMs: delta("TaskDuration"),
    scriptMs: delta("ScriptDuration"), layoutMs: delta("LayoutDuration"),
    styleMs: delta("RecalcStyleDuration"), ...detail
  };
}

async function trial(port, variant, source, engine, config) {
  const endpoint = "http://127.0.0.1:" + port;
  const response = await fetch(endpoint + "/json/new?about:blank", { method: "PUT" });
  if (!response.ok) throw new Error("Could not create temporary benchmark page");
  const target = await response.json();
  const cdp = await CDP.connect(target.webSocketDebuggerUrl);
  try {
    await cdp.send("Page.enable");
    await cdp.send("Performance.enable", { timeDomain: "threadTicks" });
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: 1280, height: 800, deviceScaleFactor: 1, mobile: false
    });
    await cdp.send("Page.navigate", {
      url: pathToFileURL(path.join(__dirname, "browser-bench.html")).href
    });
    for (let index = 0; index < 100; index++) {
      if (await cdp.evaluate("typeof Bench !== 'undefined'")) break;
      if (index === 99) throw new Error("Benchmark fixture failed to load");
      await wait(50);
    }
    const enabled = variant !== "off";
    await cdp.evaluate("Bench.prepare(" + enabled + ", " + config.size + ")");
    await cdp.evaluate(engine);
    const rows = [];
    // The initial fixture exists before content.js starts, as on a restored
    // conversation. Script startup and all deferred processing are measured.
    rows.push(await measure(cdp, "initial conversation", source + "\n;Bench.settle()", enabled));
    // Startup safety sweeps may run at 4 and 9 seconds. Let all of them finish
    // before sampling settled idle/scroll instead of attributing startup to it.
    await cdp.evaluate("Bench.wait(10000).then(() => Bench.settle())");
    rows.push(await measure(cdp, "settled idle (2s)", "Bench.wait(2000).then(() => Bench.snapshot())", enabled));
    rows.push(await measure(cdp, "scroll (1.5s)", "Bench.scroll().then(() => Bench.snapshot())", enabled));
    rows.push(await measure(cdp, "unrelated DOM updates", "Bench.unrelatedUpdates().then(() => Bench.settle())", enabled));
    rows.push(await measure(cdp, "conversation rerender", "Bench.rerender(" + config.size + "); Bench.settle()", enabled));
    rows.push(await measure(cdp, "streaming (48 chunks)", "Bench.streaming().then(() => Bench.settle())", enabled));
    return rows;
  } finally {
    cdp.close();
    await fetch(endpoint + "/json/close/" + target.id).catch(() => {});
  }
}

function median(values) {
  const sorted = values.slice().sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function report(samples, metadata, json) {
  const scenarios = [...new Set(samples.map(sample => sample.name))];
  const variants = [...new Set(samples.map(sample => sample.variant))];
  const rows = [];
  for (const name of scenarios) {
    for (const variant of variants) {
      const runs = samples.filter(sample => sample.name === name && sample.variant === variant);
      const summary = { name, variant };
      for (const key of ["cpuMs", "scriptMs", "layoutMs", "styleMs", "wallMs"]) {
        summary[key] = median(runs.map(run => run[key]));
      }
      summary.cpuMinMs = Math.min(...runs.map(run => run.cpuMs));
      summary.cpuMaxMs = Math.max(...runs.map(run => run.cpuMs));
      rows.push(summary);
    }
  }
  console.log("Real-time renderer CPU (ms), median of " + metadata.runs + " runs; " + metadata.size + " paragraphs + headings/tables.");
  console.log("CPU excludes idle waiting; wall time intentionally includes deferred settling. Script/layout/style are separate counters, not additive.");
  console.log("scenario                     variant   CPU ms   min-max       script   layout   style    wall");
  for (const row of rows) {
    console.log(row.name.padEnd(28) + " " + row.variant.padEnd(8) + " " +
      row.cpuMs.toFixed(1).padStart(7) + " " +
      (row.cpuMinMs.toFixed(1) + "-" + row.cpuMaxMs.toFixed(1)).padStart(13) + " " +
      [row.scriptMs, row.layoutMs, row.styleMs, row.wallMs].map(value => value.toFixed(1).padStart(8)).join(" "));
  }
  if (json) console.log("\n" + JSON.stringify({ metadata, summary: rows, samples }, null, 2));
}

async function main() {
  if (Number(process.versions.node.split(".")[0]) < 22 || typeof WebSocket !== "function") {
    throw new Error("This real-time benchmark requires Node 22+ with built-in WebSocket");
  }
  const config = options();
  const chrome = candidates.find(candidate => fs.existsSync(candidate));
  if (!chrome) throw new Error("Chrome/Chromium/Brave not found. Set CHROME_PATH.");
  const current = fs.readFileSync(path.join(__dirname, "..", "content.js"), "utf8");
  const engine = fs.readFileSync(path.join(__dirname, "..", "engine.js"), "utf8");
  const sources = { off: current, current };
  if (config.baseline) sources.baseline = fs.readFileSync(config.baseline, "utf8");
  const tempRoot = fs.realpathSync(os.tmpdir());
  const profile = fs.mkdtempSync(path.join(tempRoot, "rastai-bench-"));
  // Only this unique temporary profile is ever removed; no saved browser
  // profile, existing browser window, or account is accessed.
  const browser = spawn(chrome, [
    "--headless=new", "--remote-debugging-port=0", "--remote-debugging-address=127.0.0.1",
    "--user-data-dir=" + profile, "--no-first-run", "--no-default-browser-check",
    "--disable-background-networking", "--disable-extensions",
    "--allow-file-access-from-files", "--window-size=1280,800", "about:blank"
  ], { stdio: ["ignore", "ignore", "ignore"], windowsHide: true });
  let launchError;
  browser.on("error", error => { launchError = error; });
  try {
    const port = await debuggingPort(profile, browser);
    if (launchError) throw launchError;
    const version = await (await fetch("http://127.0.0.1:" + port + "/json/version")).json();
    const samples = [];
    const variants = Object.keys(sources);
    for (let run = 0; run < config.runs; run++) {
      // Rotate order to limit warm-up/thermal bias; never benchmark in parallel.
      const order = variants.slice(run % variants.length).concat(variants.slice(0, run % variants.length));
      for (const variant of order) {
        console.log("Run " + (run + 1) + "/" + config.runs + ": " + variant);
        const results = await trial(port, variant, sources[variant], engine, config);
        samples.push(...results.map(result => ({ variant, run: run + 1, ...result })));
      }
    }
    report(samples, {
      browser: version.Browser, node: process.version, runs: config.runs, size: config.size,
      baseline: config.baseline, cpuCounter: "Performance.TaskDuration (threadTicks)",
      settle: "minimum 2500ms and 1200ms without any DOM mutation; hard timeout 20s"
    }, config.json);
  } finally {
    if (browser.exitCode === null) {
      const exited = once(browser, "exit").catch(() => {});
      browser.kill();
      await Promise.race([exited, wait(5000)]);
    }
    // Chromium may briefly retain profile handles after its parent exits.
    if (path.dirname(fs.realpathSync(profile)) !== tempRoot ||
        !path.basename(profile).startsWith("rastai-bench-")) {
      throw new Error("Refusing cleanup outside the exact temporary benchmark profile");
    }
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
