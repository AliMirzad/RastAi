// A stand-in for the extension APIs, so the real popup.js and content.js
// can run inside a plain page. Everything is asynchronous, as it is in the
// browser, and every write fires storage.onChanged the way Chrome does.
(function () {
  const S = window.__stub = {
    sync: {}, local: {}, messages: [], onMessage: [], onChanged: [],
    url: "https://claude.ai/chat/test", manifest: null
  };
  const clone = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));

  function fire(changes, area) {
    if (!Object.keys(changes).length) return;
    setTimeout(() => S.onChanged.forEach((f) => f(changes, area)), 0);
  }

  function area(name) {
    return {
      get(def, cb) {
        const store = S[name];
        let out = {};
        if (def && typeof def === "object" && !Array.isArray(def)) {
          for (const k of Object.keys(def)) out[k] = k in store ? clone(store[k]) : def[k];
        } else if (typeof def === "string") {
          if (def in store) out[def] = clone(store[def]);
        } else {
          out = clone(store);
        }
        setTimeout(() => cb(out), 0);
      },
      set(obj, cb) {
        const changes = {};
        for (const k of Object.keys(obj)) {
          changes[k] = { oldValue: clone(S[name][k]), newValue: clone(obj[k]) };
          S[name][k] = clone(obj[k]);
        }
        fire(changes, name);
        setTimeout(() => cb && cb(), 0);
      },
      remove(keys, cb) {
        const changes = {};
        for (const k of [].concat(keys)) {
          if (!(k in S[name])) continue;
          changes[k] = { oldValue: clone(S[name][k]) };
          delete S[name][k];
        }
        fire(changes, name);
        setTimeout(() => cb && cb(), 0);
      }
    };
  }

  window.chrome = {
    runtime: {
      getURL: (p) => "../../" + p,
      getManifest: () => S.manifest,
      onMessage: { addListener: (f) => S.onMessage.push(f) }
    },
    storage: {
      sync: area("sync"),
      local: area("local"),
      onChanged: { addListener: (f) => S.onChanged.push(f) }
    },
    tabs: {
      query: (_q, cb) => setTimeout(() => cb([{ id: 1, url: S.url }]), 0),
      sendMessage: (_id, msg) => { S.messages.push(clone(msg)); return Promise.resolve(); }
    }
  };

  // What the popup would do: deliver a message to the page's listener.
  S.send = (msg) => S.onMessage.forEach((f) => f(msg, {}, () => {}));

  // ---- a tiny async test runner; results land in #out as JSON ----
  const results = [];
  S.wait = (ms) => new Promise((r) => setTimeout(r, ms));
  S.test = async (name, fn) => {
    try { await fn(); results.push({ name, ok: true }); }
    catch (e) { results.push({ name, ok: false, err: String(e && e.message || e) }); }
  };
  S.assert = (cond, msg) => { if (!cond) throw new Error(msg || "assertion failed"); };
  S.near = (a, b, msg) => {
    if (Math.abs(a - b) > 0.01) throw new Error((msg || "value") + ": expected " + b + ", got " + a);
  };
  S.finish = () => {
    const out = document.createElement("pre");
    out.id = "out";
    out.textContent = JSON.stringify(results);
    document.body.appendChild(out);
  };
  S.fail = (e) => {
    results.push({ name: "harness", ok: false, err: String(e && e.stack || e) });
    S.finish();
  };

  S.readFile = (rel) => {
    const x = new XMLHttpRequest();
    x.open("GET", rel, false);
    x.send();
    return x.responseText;
  };
  S.loadScript = (src) => new Promise((res, rej) => {
    const s = document.createElement("script");
    s.src = src; s.onload = res; s.onerror = () => rej(new Error("load " + src));
    document.head.appendChild(s);
  });
})();
