/*
 * RastAI — match-pattern testing
 *
 * The popup needs to answer one question: does the extension run on the
 * page this popup was opened over? The honest source of that answer is the
 * manifest's own `matches` list, not a second list kept in sync by hand —
 * so this reads the manifest and tests against it. Add a site to the
 * manifest and the popup follows automatically.
 *
 * Pure functions, no DOM: the same file is loaded by the popup and by the
 * test runner in tools/.
 *
 * https://developer.chrome.com/docs/extensions/develop/concepts/match-patterns
 */

var RastAIMatch = (function () {
  "use strict";

  function esc(s) { return s.replace(/[.+^${}()|[\]\\]/g, "\\$&"); }

  // A Chrome match pattern is <scheme>://<host><path>, where the scheme may
  // be "*", the host may be "*" or start with "*.", and the path may
  // contain "*".
  function toRegExp(pattern) {
    if (pattern === "<all_urls>") return /^(?:https?|file|ftp):\/\/.*$/;
    const m = /^(\*|https?|file|ftp):\/\/([^/]*)(\/.*)$/.exec(pattern);
    if (!m) return null;

    const scheme = m[1] === "*" ? "https?" : esc(m[1]);

    let host;
    if (m[2] === "*") host = "[^/]+";
    else if (m[2].indexOf("*.") === 0) host = "(?:[^/]+\\.)?" + esc(m[2].slice(2));
    else host = esc(m[2]);

    const path = esc(m[3]).replace(/\*/g, ".*");

    try { return new RegExp("^" + scheme + "://" + host + path + "$"); }
    catch (_) { return null; }
  }

  function matches(url, pattern) {
    const re = toRegExp(pattern);
    return re ? re.test(url) : false;
  }

  function matchesAny(url, patterns) {
    if (!url || !patterns) return false;
    for (let i = 0; i < patterns.length; i++) {
      if (matches(url, patterns[i])) return true;
    }
    return false;
  }

  return { toRegExp: toRegExp, matches: matches, matchesAny: matchesAny };
})();

if (typeof module !== "undefined" && module.exports) module.exports = RastAIMatch;
