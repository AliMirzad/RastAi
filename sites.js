/*
 * Site support classification. Single source of truth so popup, docs
 * and tests never disagree.
 *
 *   supported          verified in a real conversation by the author
 *   partially-tested   in the manifest match list but not yet
 *                      exercised end-to-end; may work, may glitch
 *
 * A host not in this table is unsupported (the manifest keeps it out
 * of the injection list anyway).
 */
(function () {
  "use strict";

  // Order deliberate: the first four are the ones the corpus and the
  // README's «harvested» cases were taken from. The rest match the
  // manifest but have not yet been exercised paragraph-by-paragraph.
  const STATUS = {
    "chatgpt.com":       "supported",
    "chat.openai.com":   "supported",
    "claude.ai":         "supported",
    "chat.deepseek.com": "supported",
    "gemini.google.com": "partially-tested",
    "grok.com":          "partially-tested",
    "perplexity.ai":     "partially-tested",
    "uxpilot.ai":        "partially-tested"
  };

  function normalize(host) {
    if (!host) return "";
    return String(host).toLowerCase().replace(/^www\./, "");
  }

  function statusFor(host) {
    const key = normalize(host);
    if (STATUS[key]) return STATUS[key];
    // Sub-domain: gemini.google.com is a full match, but tests.claude.ai
    // for example should still map to claude.ai's status.
    for (const k in STATUS) {
      if (key === k || key.endsWith("." + k)) return STATUS[k];
    }
    return "unsupported";
  }

  const api = { statusFor: statusFor, STATUS: STATUS };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (typeof window !== "undefined") window.RastAISites = api;
})();
