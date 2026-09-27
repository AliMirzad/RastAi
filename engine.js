/*
 * RastAI — language decision engine
 *
 * Pure functions only: no DOM, no chrome APIs, no state. This file is a
 * separate content script so the same code that runs in the browser can be
 * loaded directly by the test runner in tools/, instead of being scraped
 * out of content.js with a regex. If it cannot be tested honestly, it
 * cannot be improved honestly.
 *
 * Everything here operates on PROSE — the sentence with inline code and
 * URLs already removed by the caller. See proseOf() in content.js.
 */

var RastAIEngine = (function () {
  "use strict";

  // Every RTL script this engine treats as "RTL prose": Hebrew, then the
  // Arabic family (Persian, Arabic, Urdu, Pashto, Kurdish), plus their
  // supplements and presentation-form blocks. The function is still named
  // isPersianCode for callers that predate Hebrew support; semantically it
  // is "is an RTL-script letter".
  const P_RANGES = [
    [0x0590, 0x05FF],                    // Hebrew
    [0x0600, 0x06FF],                    // Arabic
    [0x0750, 0x077F],                    // Arabic Supplement
    [0x08A0, 0x08FF],                    // Arabic Extended-A
    [0xFB1D, 0xFB4F],                    // Hebrew presentation forms
    [0xFB50, 0xFDFF],                    // Arabic Presentation Forms-A
    [0xFE70, 0xFEFF]                     // Arabic Presentation Forms-B
  ];

  function isPersianCode(c) {
    // Fast path: almost every character on these pages is ASCII (below
    // 0x0590) or in the Hebrew/Arabic blocks, so three compares settle it
    // before the range loop is ever entered.
    if (c < 0x0590) return false;
    if (c <= 0x05FF) return true;
    if (c < 0x0600) return false;
    if (c <= 0x06FF) return true;
    for (let i = 2; i < P_RANGES.length; i++) {
      if (c >= P_RANGES[i][0] && c <= P_RANGES[i][1]) return true;
    }
    return false;
  }

  // English function words are the tell that a Latin run is a SENTENCE, not
  // a name or a product list. «Spring Boot Java Maven چیست؟» has four Latin
  // words and zero function words; «The Persian word for runtime is زمان
  // اجرا» has four function words. Rule 6 needs both signals — the count
  // catches sentence-sized runs, the function words catch sentence-shaped
  // ones. See the comment above decide().
  const FN_WORDS = {
    the: 1, is: 1, are: 1, was: 1, were: 1, to: 1, of: 1, for: 1, with: 1,
    this: 1, that: 1, in: 1, on: 1, a: 1, an: 1, and: 1, or: 1, but: 1,
    be: 1, by: 1, at: 1, from: 1, it: 1, its: 1, as: 1, if: 1, not: 1,
    has: 1, have: 1, had: 1, will: 1, would: 1, can: 1, could: 1
  };

  function hasAnyPersian(text) {
    if (!text) return false;
    for (let i = 0; i < text.length; i++) {
      if (isPersianCode(text.charCodeAt(i))) return true;
    }
    return false;
  }

  /*
   * One pass collecting every signal the decision needs:
   *   pChars / lChars — strong character counts
   *   pWords / lWords — word counts (one long identifier counts once)
   *   first           — 1 if the first strong char is Persian, 2 if Latin
   *   woven           — Persian appears BETWEEN two Latin runs
   */
  // Function words are 1–5 letters, so we pack the current pure-Latin
  // word into a 32-bit integer (5 bits per letter, 6 letters max) instead
  // of building a string per character. The FN_WORD_KEYS set holds the
  // packed forms of every word in FN_WORDS. String concatenation in the
  // inner loop cost about half of scanText's throughput.
  function packLetter(c) {
    // returns 1..26 for a–z, 0 otherwise
    if (c >= 97 && c <= 122) return c - 96;
    if (c >= 65 && c <= 90)  return c - 64;
    return 0;
  }
  const FN_WORD_KEYS = (function () {
    const s = new Set();
    for (const w in FN_WORDS) {
      let k = 0;
      for (let i = 0; i < w.length; i++) k = (k << 5) | packLetter(w.charCodeAt(i));
      s.add(k);
    }
    return s;
  })();

  function scanText(text) {
    let pChars = 0, lChars = 0, pWords = 0, lWords = 0, lFunc = 0, first = 0;
    let wordP = false, wordL = false, inWord = false;
    let sawL = false, pAfterL = false, woven = false;
    let wKey = 0, wLen = 0, wPure = true;   // packed lowercase, len, pure Latin
    const len = text ? text.length : 0;
    for (let i = 0; i <= len; i++) {
      const c = i < len ? text.charCodeAt(i) : 32;
      const isSpace = c === 32 || c === 9 || c === 10 || c === 13 ||
        c === 0x00A0 || c === 0x2028 || c === 0x2029;
      if (isSpace) {
        if (inWord) {
          if (wordP) pWords++;
          else if (wordL) {
            lWords++;
            if (wPure && wLen >= 1 && wLen <= 5 && FN_WORD_KEYS.has(wKey)) lFunc++;
          }
        }
        inWord = false; wordP = false; wordL = false;
        wKey = 0; wLen = 0; wPure = true;
        continue;
      }
      inWord = true;
      if (isPersianCode(c)) {
        pChars++; wordP = true;
        if (first === 0) first = 1;
        if (sawL) pAfterL = true;
        wPure = false;
      } else if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122)) {
        lChars++; wordL = true;
        if (first === 0) first = 2;
        if (pAfterL) woven = true;
        sawL = true;
        if (wPure && wLen < 6) {
          wKey = (wKey << 5) | (c >= 65 && c <= 90 ? c - 64 : c - 96);
          wLen++;
        }
      } else {
        wPure = false;                   // digits, apostrophes, hyphens
      }
    }
    return { pChars: pChars, lChars: lChars, pWords: pWords, lWords: lWords,
             lFunc: lFunc, first: first, woven: woven };
  }

  /*
   * The decision: synchronous, deterministic, six rules.
   *
   * The question is never "which language has more of this paragraph". It
   * is "which language is the paragraph WRITTEN IN" — the matrix language.
   * Persian technical writing is Persian prose with English terms dropped
   * into it, and an English term is one token no matter how long it is.
   * Weighing characters made `isAnnotationPresent()` nineteen votes for
   * English against three for «متد», so «متد getClass()» came out right
   * and «متد isAnnotationPresent()» came out backwards — the same sentence
   * answered differently because of identifier length.
   *
   *   1. no Persian in the prose      -> leave the element alone
   *   2. no Latin in the prose        -> RTL
   *   3. the prose STARTS in Persian  -> RTL
   *      (the first-strong rule behind HTML's dir="auto": a sentence opens
   *      in its own language)
   *   4. Persian words >= Latin words -> RTL
   *      (words, not characters, so one long identifier counts once)
   *   5. Persian sits BETWEEN two Latin runs -> RTL
   *      A Persian word wedged between two Latin ones is not an object the
   *      sentence is talking about, it is the joint the sentence is built
   *      on — «و» there does the work "and" does in English. A language
   *      only supplies connectives to a sentence it owns. This is
   *      position, not vocabulary, so no word list is needed.
   *      HOWEVER: if the Latin frame is itself a sentence — long enough
   *      AND carrying its own function words — then the Persian in the
   *      middle is not the connective, it is the quoted object. «The
   *      default value is مقدار پیش‌فرض when no user provides one» and
   *      «Translation of «کتاب» is «book»» are English sentences quoting
   *      a Persian noun. Every corpus case where rule 5 CORRECTLY fires
   *      («Compile Time و Runtime», «Spring Boot، Hibernate و Maven»,
   *      «Naming، Functions، …») has zero Latin function words; every
   *      case where rule 5 wrongly fires carries at least one. So rule 5
   *      steps aside when it sees a sentence-shaped Latin frame and rule
   *      6 gets the decision.
   *   6. Latin-led, more Latin words, Persian only at the tail, AND the
   *      Latin part is long enough AND shaped like a sentence -> LTR
   *   7. otherwise                    -> RTL
   *
   * Rule 6 exists for one shape: an English SENTENCE that happens to end
   * with a Persian word, as in «The Persian word for runtime is زمان
   * اجرا», where the Persian really is the object being quoted.
   *
   * The old rule 6 fired on «Liara AI قابلیت‌ها», «native method چیست»,
   * «Edge Case مثل», «Java Core عمیق» — Persian headings whose first word
   * or two happen to be a technical term. Raising the threshold from
   * "more Latin words" to "four or more Latin words" swept those up, but
   * left «Spring Boot Java Maven چیست؟» and «Docker Compose Setup Guide
   * چیست» — Persian headings whose Latin part is a product list.
   *
   * A product list has no glue: no «the», «is», «of», «for», «with». A
   * sentence has at least one. So rule 6 now asks for BOTH signals — a
   * sentence-sized run AND at least one English function word. The two
   * pinned failure classes have exclusive shapes: every rule-6 passing
   * case in the corpus carries at least one function word, and every
   * Persian-heading-with-a-product-list case carries none.
   *
   * Returns the direction and the rule that produced it, so diagnostics
   * and the accuracy runner can report WHY, not just what.
   */
  // How many Latin words before the Latin part might count as a sentence.
  // See the note on rule 6 above.
  const SENTENCE_WORDS = 4;

  function decide(s) {
    if (s.pChars === 0) return { dir: null,  rule: 1 };
    if (s.lChars === 0) return { dir: "rtl", rule: 2 };
    if (s.first === 1)  return { dir: "rtl", rule: 3 };
    if (s.pWords >= s.lWords) return { dir: "rtl", rule: 4 };
    const latinIsSentence = s.lWords >= SENTENCE_WORDS && s.lFunc >= 1;
    if (s.woven && !latinIsSentence) return { dir: "rtl", rule: 5 };
    if (latinIsSentence) return { dir: "ltr", rule: 6 };
    return { dir: "rtl", rule: 7 };
  }

  const RULE_NAMES = {
    1: "no Persian — left alone",
    2: "no Latin — RTL",
    3: "starts in Persian — RTL",
    4: "Persian words >= Latin words — RTL",
    5: "Persian woven between Latin — RTL",
    6: "English sentence with a Persian tail — LTR",
    7: "Latin-led but only a term, not a sentence — RTL"
  };

  // Code blocks are structural: flipping one because it carries Persian
  // comments would wreck its layout, so Persian must strictly outnumber.
  function codeDirection(text) {
    const s = scanText(text);
    if (s.pChars === 0) return null;
    return s.pWords > s.lWords ? "rtl" : "ltr";
  }

  // Convenience for callers that just want an answer from a string.
  function directionOf(prose) {
    return decide(scanText(prose || ""));
  }

  return {
    isPersianCode: isPersianCode,
    hasAnyPersian: hasAnyPersian,
    scanText: scanText,
    decide: decide,
    directionOf: directionOf,
    codeDirection: codeDirection,
    RULE_NAMES: RULE_NAMES
  };
})();

if (typeof module !== "undefined" && module.exports) module.exports = RastAIEngine;
