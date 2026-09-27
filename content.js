/*
 * RastAI — content script
 *
 * Three direction modes chosen from the popup:
 *   - "always" : any Persian character in the paragraph -> RTL
 *   - "smart"  : matrix-language decision (see engine.js)
 *   - "auto"   : never override direction; only isolate risky Latin runs
 *
 * DESIGN NOTE — why this file is careful about WHEN it touches the DOM
 * -------------------------------------------------------------------
 * ChatGPT and Claude render their answers with React. React keeps direct
 * references to the exact text nodes it created. If we replace one of
 * those text nodes (which is what <bdi> wrapping does) while the answer is
 * still streaming, React's next commit writes to a node that is no longer
 * in the document, or calls insertBefore() with a reference node we
 * detached. That throws, the markdown subtree dies, and the whole answer
 * collapses into one unparsed blob of raw markdown — the "متن می‌ریزه
 * پشت هم" bug that forced a page refresh.
 *
 * So the rules are:
 *   1. Direction marking (an attribute + two inline styles) is safe at any
 *      time — it never restructures children. It happens immediately.
 *   2. Any structural change (splitting a text node into <bdi> pieces)
 *      happens ONLY when the element has been textually quiet for
 *      STREAM_QUIET_MS *and* no answer is streaming anywhere on the page.
 *   3. <pre> and <code> subtrees are never restructured at all. Syntax
 *      highlighters own that DOM and rebuild it constantly.
 *
 * Every paragraph respects a user override: select any text inside a
 * paragraph, click the floating ⇄ button, and that paragraph alone flips.
 * Overrides are kept in storage.local, so they survive a refresh; the
 * popup can clear them.
 */

(function () {
  "use strict";

  const KEY_MODE = "rtlMode";
  const KEY_FONT = "fontEnabled";
  const KEY_DEBUG = "debugMode";
  const KEY_LH = "lineSpacing";
  const KEY_SITES = "siteOff";   // { "claude.ai": true } means OFF there
  const KEY_OVERRIDES = "overrides";   // storage.local: hash -> "rtl" | "ltr"
  const KEY_OLD_RTL = "rtlEnabled";
  const KEY_SCALE = "fontScale";       // percent: 90 | 100 | 110 | 120 | 130

  const CLASS_RTL = "rastai-rtl-on";
  const CLASS_FONT = "rastai-font-on";
  const MARK = "data-rastai-rtl";
  const ISO_ATTR = "data-rastai-iso";
  const BTN_ID = "rastai-flip-btn";
  const CLASS_INPUT = "rastai-input-on";
  const CLASS_DEBUG = "rastai-debug-on";
  const CLASS_LH = "rastai-lh-on";                // legacy — still applies "comfortable" values
  const LH_MODES = ["compact", "normal", "comfortable"];
  const LH_ATTR = "data-rastai-lh";               // set on <html> to "compact" | "normal" | "comfortable"
  const CLASS_SCALE = "rastai-scale-on";
  const SCALE_VAR = "--rastai-scale";
  const SCALES = [90, 100, 110, 120, 130];
  const RULE_ATTR = "data-rastai-rule";
  // Diagnostic source: short label the debug badge renders next to the
  // paragraph. "R3", "R6", "Manual", "Always". Set only in debug mode
  // and cleared with the rest of the diagnostic attributes on teardown.
  const SRC_ATTR = "data-rastai-src";
  const PANEL_ID = "rastai-debug-panel";
  const DIR_ATTR = "data-rastai-dir";   // marks a dir="auto" WE added

  // `code:not(pre code)` keeps every <code> inside a code block out of the
  // query entirely: those must follow their <pre>'s direction, so matching
  // them only to reject them later was wasted work on every sweep.
  const SEL =
    "p,li,ul,ol,table,h1,h2,h3,h4,h5,h6,blockquote,td,th,dt,dd," +
    "figcaption,summary,pre,code:not(pre code)";

  const INPUT_SKIP =
    'textarea, [contenteditable="true"], [contenteditable=""], ' +
    '[contenteditable="plaintext-only"]';

  // Blocks inside an editable box that each act as their own paragraph.
  const EDIT_BLOCKS = new Set([
    "P", "DIV", "LI", "H1", "H2", "H3", "H4", "H5", "H6", "BLOCKQUOTE", "PRE"
  ]);
  const EDIT_BLOCK_SEL = "p,div,li,h1,h2,h3,h4,h5,h6,blockquote,pre";

  // Subtrees we never restructure. Highlighters rebuild these constantly
  // and their layout depends on exact text-node boundaries.
  const WRAP_SKIP = "pre, code, " + INPUT_SKIP;

  // Site markers that mean "an answer is being generated right now".
  // Deliberately loose: these are a fast hint, not the only guard. If a
  // site renames every one of them the mutation-activity meter below still
  // catches the stream, so nothing here is load-bearing — which is why the
  // one substring-matching selector ([class*="streaming"]) was dropped:
  // it scanned every class attribute in the document twice a second to
  // re-derive something the meter already knows.
  const STREAM_MARKERS =
    '[data-is-streaming="true"], [data-streaming="true"], ' +
    '[data-message-streaming="true"], ' +
    'button[data-testid*="stop"], button[aria-label*="Stop"], ' +
    'button[aria-label*="stop"]';

  // ---- tuning knobs -------------------------------------------------
  const STREAM_QUIET_MS = 450;  // element must be textually still this long
  const FRAME_BUDGET_MS = 8;    // work budget for one drain slice
  const MIN_BATCH = 24;         // always process at least this many nodes
  const STREAM_CACHE_MS = 150;  // how long the streaming probe is cached
  const HOT_MIN_MS = 120;       // min gap between visits to one element
  const FREEZE_LEN = 240;       // chars after which a direction is settled

  let mode = "smart";

  // Bumped whenever the mode changes. Baked into every cache key so a mode
  // switch invalidates all per-element bookkeeping at once.
  let epoch = 0;

  // Manual overrides, keyed by a hash of the paragraph text. Persisted in
  // storage.local (see saveOverrides).
  const overrides = new Map();

  // Per-element bookkeeping. One object per element rather than five
  // WeakMap lookups per visit, and all signatures are plain numbers so a
  // visit allocates nothing.
  //   ep    epoch this state belongs to (mode switches invalidate)
  //   sig   signature of the text last seen
  //   hot   timestamp the text last changed
  //   dir   signature the direction was decided at
  //   wrap  signature the bdi pass ran at
  //   visit timestamp of the last visit (throttles streaming re-entry)
  //   done  1 once fully processed; cleared by any mutation
  //   skip  cached "inside an input" / "is a <pre><code>" verdicts
  const stateMap = new WeakMap();

  function stateOf(el) {
    let st = stateMap.get(el);
    if (st === undefined) {
      st = { ep: epoch, sig: -1, hot: 0, dir: -1, wrap: -1, visit: -1e9,
             done: 0, skip: -1, preCode: -1, mark: undefined, len: 0 };
      stateMap.set(el, st);
    } else if (st.ep !== epoch) {
      st.ep = epoch; st.dir = -1; st.wrap = -1; st.done = 0;
    }
    return st;
  }

  function markDirty(el) {
    const st = stateMap.get(el);
    if (st !== undefined) st.done = 0;
  }

  const SCALE_ROOT =
    "[" + MARK + "]:not(pre):not(code):not([" + MARK + "] *)" +
    ":not(nav *):not(aside *):not(header *):not(form *)" +
    ":not([role=\"navigation\"] *):not([role=\"banner\"] *)" +
    ":not([role=\"complementary\"] *)";

  const FONT_REG  = chrome.runtime.getURL("fonts/Vazirmatn-Regular.woff2");
  const FONT_MED  = chrome.runtime.getURL("fonts/Vazirmatn-Medium.woff2");
  const FONT_BOLD = chrome.runtime.getURL("fonts/Vazirmatn-Bold.woff2");

  const CSS =
    "@font-face{font-family:'Vazirmatn';font-style:normal;font-weight:400;" +
    "font-display:swap;src:url(\"" + FONT_REG + "\") format(\"woff2\");}\n" +
    "@font-face{font-family:'Vazirmatn';font-style:normal;font-weight:500;" +
    "font-display:swap;src:url(\"" + FONT_MED + "\") format(\"woff2\");}\n" +
    "@font-face{font-family:'Vazirmatn';font-style:normal;font-weight:700;" +
    "font-display:swap;src:url(\"" + FONT_BOLD + "\") format(\"woff2\");}\n" +

    // Site quirk: ChatGPT's new layout puts a focusable <main> around
    // the chat with a `MainContentSurface`/`MainContentLeftBorder` class
    // pair. On the first arrow key press the browser puts focus there
    // and draws its 3px outline as a frame around the whole chat, and
    // because <main> is not the scroll container, arrow keys stop
    // scrolling. Hide the focus outline; the focusin handler below then
    // blurs it so the arrow falls through to normal page scrolling.
    // Class-substring selector so a hash update on ChatGPT's side does
    // not undo the fix.
    "main[class*=\"MainContentSurface\"]:focus," +
    "main[class*=\"MainContentSurface\"]:focus-visible{outline:0!important;}\n" +

    "html." + CLASS_RTL + " [" + MARK + "=\"rtl\"]:not(table){" +
    "direction:rtl!important;text-align:right!important;" +
    "unicode-bidi:isolate!important;}\n" +

    "html." + CLASS_RTL + " [" + MARK + "=\"ltr\"]:not(table){" +
    "direction:ltr!important;text-align:left!important;" +
    "unicode-bidi:isolate!important;}\n" +

    // A table takes direction ONLY. `direction` on the table element is
    // what orders its columns — without it a Persian table keeps its
    // columns running left to right while every cell inside is
    // right-aligned. text-align is deliberately left off: each cell
    // decides its own, and an inherited one would drag unmarked cells
    // (numbers, dates) along with it.
    "html." + CLASS_RTL + " table[" + MARK + "=\"rtl\"]{direction:rtl!important;}\n" +
    "html." + CLASS_RTL + " table[" + MARK + "=\"ltr\"]{direction:ltr!important;}\n" +

    "html." + CLASS_RTL + " ul[" + MARK + "=\"rtl\"]," +
    "html." + CLASS_RTL + " ol[" + MARK + "=\"rtl\"]{" +
    "padding-right:1.75em!important;padding-left:0!important;" +
    "margin-right:0!important;}\n" +

    // Small typography polish for marked RTL content. Only line-height
    // and margins are touched — sizes, colours, and font-weights are
    // whatever the site chose. Everything else is left to the site's
    // stylesheet so we do not fight it.
    // Headings: Persian h1..h6 like a bit more room above than below,
    // matched by a slightly looser line-height so ascenders and
    // descenders don't crowd. Applies only when the user hasn't picked
    // an explicit line-spacing — compact/comfortable are the user's
    // choice and win over the polish default.
    "html." + CLASS_RTL + ":not([" + LH_ATTR + "]) [" + MARK + "=\"rtl\"] :is(h1,h2,h3,h4,h5,h6):not(pre):not(code)," +
    "html." + CLASS_RTL + ":not([" + LH_ATTR + "]) :is(h1,h2,h3,h4,h5,h6)[" + MARK + "=\"rtl\"]:not(pre):not(code){" +
    "line-height:1.45!important;}\n" +
    // Nested lists indent from the RIGHT in RTL. The browser default
    // uses padding-left, which mirrors to the wrong side for us.
    "html." + CLASS_RTL + " [" + MARK + "=\"rtl\"] :is(ul,ol) :is(ul,ol){" +
    "padding-right:1.5em!important;padding-left:0!important;}\n" +
    // Blockquotes: keep the accent bar on the START edge in RTL. Some
    // sites hard-code border-left; a start-relative rule wins on marked
    // content without touching the site's colours or font.
    "html." + CLASS_RTL + " blockquote[" + MARK + "=\"rtl\"]," +
    "html." + CLASS_RTL + " [" + MARK + "=\"rtl\"] blockquote{" +
    "border-inline-start-style:solid!important;" +
    "border-inline-start-width:3px!important;" +
    "border-left:0!important;" +
    "padding-inline-start:12px!important;padding-inline-end:0!important;" +
    "margin-inline-start:0!important;margin-inline-end:0!important;}\n" +
    // Table cells: three problems the user reported on ChatGPT tables.
    //   1. Adjacent cells visually merge — a Persian cell's text sits
    //      right up against the neighbouring English cell's text, so
    //      "Compile Time" | "کامپایلر …" reads as one run of chars.
    //      Fix: inline padding on every cell in a marked RTL table.
    //   2. An English cell inside an RTL table inherits direction:rtl
    //      from the table, so its text-align defaults to right — the
    //      cell reads like a Persian cell that happens to hold Latin
    //      letters, which crowds the boundary above.
    //      Fix: cells the engine didn't mark (English-only content,
    //      where directionOf returned null) get direction:ltr AND an
    //      isolation so their BiDi neutrals don't leak.
    //   3. A cell's text-align defaults were inconsistent between
    //      Persian and English cells; text-align:start with the cell's
    //      own direction gives the same anchoring for both.
    "html." + CLASS_RTL + " table[" + MARK + "=\"rtl\"] :is(th,td){" +
    "padding-inline:12px!important;padding-block:6px!important;" +
    "text-align:start!important;}\n" +
    "html." + CLASS_RTL + " table[" + MARK + "=\"rtl\"] :is(th,td):not([" + MARK + "]){" +
    "direction:ltr!important;unicode-bidi:isolate!important;}\n" +

    // Inline code (NOT the <code> inside a <pre>) that sits inside a marked
    // container without its own mark: force LTR so technical identifiers
    // read correctly inside a Persian sentence.
    "html." + CLASS_RTL + " [" + MARK + "=\"rtl\"] code:not(pre code):not([" + MARK + "])," +
    "html." + CLASS_RTL + " [" + MARK + "=\"ltr\"] code:not(pre code):not([" + MARK + "]){" +
    "direction:ltr!important;text-align:left!important;" +
    "unicode-bidi:isolate!important;}\n" +

    "html." + CLASS_RTL + " bdi[" + ISO_ATTR + "=\"1\"]{" +
    "direction:ltr!important;unicode-bidi:isolate!important;" +
    "display:inline;font:inherit;color:inherit;" +
    "background:transparent;padding:0;margin:0;border:0;}\n" +

    // Arrow-only bdi: rendered as an inline-block, glyph mirrored with
    // transform:scaleX(-1). Browsers do not apply Unicode Bidi_Mirrored
    // to arrow codepoints, so we do it visually. Only fires inside an
    // RTL-marked paragraph — LTR paragraphs leave the arrow as-is.
    "html." + CLASS_RTL + " [" + MARK + "=\"rtl\"] bdi[" + ISO_ATTR + "=\"arrow\"]{" +
    "display:inline-block!important;transform:scaleX(-1)!important;" +
    "direction:ltr!important;unicode-bidi:isolate!important;" +
    "font:inherit;color:inherit;background:transparent;" +
    "padding:0;margin:0;border:0;}\n" +
    // In an LTR paragraph we still want to strip the default <bdi>
    // behavior but NOT mirror.
    "html." + CLASS_RTL + " [" + MARK + "=\"ltr\"] bdi[" + ISO_ATTR + "=\"arrow\"]{" +
    "display:inline;font:inherit;color:inherit;" +
    "background:transparent;padding:0;margin:0;border:0;}\n" +

    // A <textarea> has no DOM inside it to mark up, but plaintext gives
    // each of its lines the direction of that line's first strong
    // character — which is exactly what a word processor does, and it
    // costs no JavaScript and no work per keystroke.
    "html." + CLASS_INPUT + " textarea{" +
    "unicode-bidi:plaintext!important;text-align:start!important;}\n" +

    "html." + CLASS_FONT + " [" + MARK + "=\"rtl\"]{" +
    "font-family:'Vazirmatn',Tahoma,sans-serif!important;}\n" +

    "html." + CLASS_FONT + " [" + MARK + "] pre," +
    "html." + CLASS_FONT + " [" + MARK + "] code," +
    "html." + CLASS_FONT + " pre[" + MARK + "]," +
    "html." + CLASS_FONT + " code[" + MARK + "]{" +
    "font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace!important;}\n" +

    // The flip button sits on top of someone else's page, so it stays
    // small and quiet: one flat accent colour, a hairline ring to hold it
    // off any background, and a short scale-in so it does not pop.
    "@keyframes rastai-btn-in{from{opacity:0;transform:scale(.82);}" +
    "to{opacity:1;transform:scale(1);}}\n" +

    // Persian needs a little more room between lines than Latin does at
    // the same size. Code keeps its own spacing: loosening a code block
    // makes it harder to read, not easier. Three named modes: the legacy
    // boolean toggle mapped to comfortable (true) or normal (false), so
    // v1.39 users see no change; a new compact mode tightens the line
    // for readers who prefer denser text.
    "html[" + LH_ATTR + "=\"comfortable\"] [" + MARK + "=\"rtl\"]:not(pre):not(code)," +
    "html." + CLASS_LH + " [" + MARK + "=\"rtl\"]:not(pre):not(code){" +
    "line-height:1.95!important;}\n" +
    "html[" + LH_ATTR + "=\"compact\"] [" + MARK + "=\"rtl\"]:not(pre):not(code){" +
    "line-height:1.55!important;}\n" +

    // Text size. Only the OUTERMOST marked paragraph is scaled, so a <p>
    // inside a marked <li> inside a marked <ul> is not scaled three times.
    // zoom rather than font-size: font-size:1.1em on an <h2> would resolve
    // against its parent and shrink the heading to body size, while zoom
    // scales whatever size the site gave it. The site's own chrome
    // (sidebar, header, the prompt form) is excluded even where a
    // paragraph in it was marked, and a code block inside a scaled
    // paragraph is zoomed back by the inverse, so code keeps its size.
    // The scale itself is one custom property on <html>: changing it
    // restyles through the cascade, with nothing written per paragraph.
    "html." + CLASS_SCALE + " " + SCALE_ROOT + "{" +
    "zoom:var(" + SCALE_VAR + ")!important;}\n" +
    "html." + CLASS_SCALE + " " + SCALE_ROOT + " pre{" +
    "zoom:calc(1 / var(" + SCALE_VAR + "))!important;}\n" +

    // Diagnostics. Outlines do not affect layout, so turning this on never
    // moves anything on the page. A small badge is rendered via the
    // paragraph's ::before pseudo-element, so no extra DOM node is
    // inserted (which would fight React re-renders on chat sites).
    "html." + CLASS_DEBUG + " [" + RULE_ATTR + "]{outline:1px dashed rgba(148,163,184,.55)!important;" +
    "outline-offset:1px!important;}\n" +
    "html." + CLASS_DEBUG + " [" + MARK + "=\"rtl\"][" + RULE_ATTR + "]{" +
    "outline:1px solid rgba(16,185,129,.75)!important;}\n" +
    "html." + CLASS_DEBUG + " [" + MARK + "=\"ltr\"][" + RULE_ATTR + "]{" +
    "outline:1px solid rgba(245,158,11,.8)!important;}\n" +
    "html." + CLASS_DEBUG + " [" + SRC_ATTR + "]{position:relative!important;}\n" +
    "html." + CLASS_DEBUG + " [" + SRC_ATTR + "]::before{" +
    "content:attr(" + SRC_ATTR + ")!important;position:absolute!important;" +
    "top:-9px!important;inset-inline-end:6px!important;z-index:2147483645!important;" +
    "padding:1px 6px!important;border-radius:4px!important;pointer-events:none!important;" +
    "font:600 9px/1.4 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace!important;" +
    "letter-spacing:.02em!important;direction:ltr!important;unicode-bidi:isolate!important;" +
    "background:rgba(15,17,21,.92)!important;color:#e7e9ee!important;" +
    "border:1px solid rgba(148,163,184,.35)!important;}\n" +
    "html." + CLASS_DEBUG + " [" + MARK + "=\"rtl\"][" + SRC_ATTR + "]::before{" +
    "border-color:rgba(16,185,129,.75)!important;color:#a7f3d0!important;}\n" +
    "html." + CLASS_DEBUG + " [" + MARK + "=\"ltr\"][" + SRC_ATTR + "]::before{" +
    "border-color:rgba(245,158,11,.8)!important;color:#fde68a!important;}\n" +
    "html." + CLASS_DEBUG + " [" + SRC_ATTR + "=\"Manual\"]::before{" +
    "border-color:rgba(139,92,246,.8)!important;color:#ddd6fe!important;}\n" +

    "#" + PANEL_ID + "{position:fixed!important;z-index:2147483646!important;" +
    "bottom:12px!important;left:12px!important;width:216px!important;" +
    "background:#0f1115!important;color:#e7e9ee!important;" +
    "border:1px solid rgba(255,255,255,.12)!important;border-radius:10px!important;" +
    "padding:9px 10px!important;direction:rtl!important;text-align:right!important;" +
    "font:12px/1.55 Tahoma,sans-serif!important;" +
    "box-shadow:0 6px 24px rgba(0,0,0,.45)!important;}\n" +
    "#" + PANEL_ID + " b{display:block!important;font-size:11px!important;" +
    "color:#8b919e!important;font-weight:500!important;margin-bottom:5px!important;}\n" +
    "#" + PANEL_ID + " i{display:flex!important;justify-content:space-between!important;" +
    "gap:8px!important;white-space:nowrap!important;" +
    "font-style:normal!important;font-size:11px!important;color:#c2c8d2!important;}\n" +
    "#" + PANEL_ID + " span{color:#8b919e!important;font-variant-numeric:tabular-nums!important;}\n" +
    "#" + PANEL_ID + " u{color:#646b78!important;text-decoration:none!important;}\n" +
    "#" + PANEL_ID + " button{margin-top:7px!important;width:100%!important;" +
    "background:#10b981!important;color:#04291d!important;border:0!important;" +
    "border-radius:7px!important;padding:6px!important;cursor:pointer!important;" +
    "font:600 11px/1 Tahoma,sans-serif!important;}\n" +

    "#" + BTN_ID + "{" +
    "position:fixed!important;z-index:2147483647!important;" +
    "width:30px!important;height:30px!important;" +
    "padding:0!important;margin:0!important;" +
    "border:1px solid rgba(255,255,255,0.22)!important;" +
    "border-radius:9px!important;" +
    "background:#10b981!important;" +
    "color:#04241a!important;line-height:1!important;" +
    "cursor:pointer!important;user-select:none!important;" +
    "box-shadow:0 2px 6px rgba(0,0,0,0.22)," +
    "0 0 0 3px rgba(16,185,129,0.14)!important;" +
    "display:none!important;opacity:1!important;pointer-events:auto!important;" +
    "box-sizing:border-box!important;text-align:center!important;" +
    "align-items:center!important;justify-content:center!important;" +
    "text-decoration:none!important;overflow:hidden!important;" +
    "outline:none!important;font:0/0 a!important;" +
    "transition:background .15s,box-shadow .15s,transform .12s!important;}\n" +

    "#" + BTN_ID + ".on{display:flex!important;" +
    "animation:rastai-btn-in .14s cubic-bezier(.4,0,.2,1)!important;}\n" +

    "#" + BTN_ID + ":hover{background:#0ea975!important;" +
    "box-shadow:0 3px 10px rgba(0,0,0,0.26)," +
    "0 0 0 4px rgba(16,185,129,0.2)!important;}\n" +

    "#" + BTN_ID + ":active{background:#0b8f63!important;" +
    "transform:scale(.94)!important;}\n" +

    "#" + BTN_ID + " svg{display:block!important;pointer-events:none!important;" +
    "width:15px!important;height:15px!important;}";

  let styleEl = null;
  let observer = null;
  let observing = false;

  const queue = [];
  const queued = new Set();
  let scheduled = false;

  const now =
    (window.performance && performance.now)
      ? function () { return performance.now(); }
      : function () { return Date.now(); };

  const rIC =
    window.requestIdleCallback ||
    function (cb) {
      return setTimeout(function () {
        cb({ timeRemaining: function () { return 5; }, didTimeout: true });
      }, 16);
    };

  function ensureStyle() {
    if (styleEl && styleEl.isConnected) {
      if (document.head && styleEl.parentNode !== document.head) {
        document.head.appendChild(styleEl);
      }
      return;
    }
    styleEl = document.createElement("style");
    styleEl.id = "rastai-rtl-style";
    styleEl.textContent = CSS;
    (document.head || document.documentElement).appendChild(styleEl);
    if (!document.head) {
      const mo = new MutationObserver(function () {
        if (document.head && styleEl.parentNode !== document.head) {
          document.head.appendChild(styleEl);
          mo.disconnect();
        }
      });
      mo.observe(document.documentElement, { childList: true });
    }
  }

  // ------------------------- text analysis -------------------------

  const ARROWS = "\\u2190-\\u21FF\\u27F0-\\u27FF\\u2900-\\u297F";

  // A Latin run kept together in ONE <bdi>: letters, digits, identifier
  // punctuation, code punctuation, all four bracket pairs, @ and \ (for
  // emails and Windows paths), '$' and '_' (valid Java/JavaScript
  // identifier characters, and legal starts too), spaces (so
  // "active != null" stays one L block) and arrows. The run may start
  // with a bracket, dash, slash, @, $ or _ — otherwise it starts on a
  // letter or digit (so "127.0.0.1:8080" and "--force" match). It must
  // end on an alphanumeric, '_', '$', a closing bracket, or a '>' so
  // trailing whitespace and Persian punctuation don't sneak in. The
  // second alternative catches standalone arrow sequences like
  // "چپ ← راست".
  //
  // Before v1.38 the regex required [A-Za-z] at the start and ended on
  // [A-Za-z0-9\]})] — that dropped digit-led "127.0.0.1:8080", the
  // leading "--" of "--force", the closing ">" of "List<String>", and
  // split "user@example.com" and "C:\\Temp" mid-run. v1.38.1 adds '$'
  // and '_' after generic-syntax tests showed "$scope" and "_init()"
  // losing their identifier lead — the same visual-reorder shape as
  // "Java<Integer>" wearing a stripped prefix.
  const LATIN_RUN = new RegExp(
    "[\\[({]?[\\-/@$_]*[A-Za-z0-9_$](?:[A-Za-z0-9._,;:=!<>+*/%&|?~^#\\[\\](){}@\\\\$_ " + ARROWS + "\\-]*" +
    "[A-Za-z0-9_$\\]})>])?|[" + ARROWS + "]+",
    "g"
  );

  // Only runs containing one of these actually need an isolate. A plain
  // word or a multi-word phrase made of letters, digits, dots and hyphens
  // is already ordered correctly by the browser's own bidi algorithm
  // (rule N1), so wrapping it is pure DOM churn with no visual benefit —
  // and DOM churn is what breaks the site's renderer. Angle brackets
  // count because <> is a BiDi bracket pair (N0) that gets flipped in
  // RTL context; @ and \\ and / count because they are neutrals that
  // BiDi treats as ambiguous inside a Persian frame.
  const NEEDS_ISO = new RegExp("[\\[\\](){}<>=!+*/%&|?~^#;:,@\\\\/" + ARROWS + "]");

  const HAS_WRAPPABLE = new RegExp("[A-Za-z" + ARROWS + "]");
  // A run without any of these is arrow/punctuation only — the browser
  // handles those in an RTL context correctly on its own and any
  // <bdi dir="ltr"> we add would freeze the glyph the wrong way.
  const HAS_LATIN = /[A-Za-z0-9_$]/;
  const OLD_ISOLATE_CHARS = /[⁦-⁩]/g;

  // Text that does NOT count toward the language decision. An identifier
  // inside `backticks` is a foreign object embedded in the sentence, not
  // the language the sentence is written in — the same way a phone number
  // in an English paragraph doesn't make that paragraph "numeric". URLs
  // are the same kind of object.
  const PROSE_SKIP = "code, pre, kbd, samp, var, math, svg";
  const URL_RE = /\b(?:https?:\/\/|www\.)\S+/g;

  // The sentence as a reader sees it, minus embedded code and URLs. The
  // fast path (no code descendants) costs one querySelector.
  function proseOf(el, full) {
    let text = full;
    if (el.querySelector && el.querySelector(PROSE_SKIP)) {
      let walker;
      try {
        walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null);
      } catch (_) { return full.replace(URL_RE, " "); }
      const parts = [];
      let n, memoPar = null, memoSkip = false;
      while ((n = walker.nextNode())) {
        const par = n.parentElement;
        if (!par) continue;
        // Consecutive text nodes almost always share a parent, so one
        // memo slot removes nearly every closest() walk here.
        if (par !== memoPar) {
          memoPar = par;
          memoSkip = !!(par.closest && par.closest(PROSE_SKIP));
        }
        if (memoSkip) continue;
        parts.push(n.data);
      }
      text = parts.join(" ");
      // A paragraph that is nothing but code has no prose to judge; fall
      // back to the full text so it is not silently left unmarked.
      if (!text.trim()) text = full;
    }
    return text.replace(URL_RE, " ");
  }

  // A list element's textContent is the concatenation of every item, so
  // scanning it in full means each <li> is scanned again for its <ul>,
  // and again for any enclosing <li> — quadratic on a long answer. A list
  // takes the direction of its items, so the first item decides it.
  function sampleText(el) {
    const tag = el.tagName;
    if (tag === "UL" || tag === "OL") {
      // The first ITEM, not the first child: a list can open with a header
      // or a wrapper, and taking that instead sent the whole list's text
      // through as the sample — which is how a sidebar of fifty
      // conversation titles arrived as one paragraph.
      let first = null;
      try { first = el.querySelector(":scope > li"); } catch (_) {}
      if (!first) first = el.firstElementChild;
      if (first) return first.textContent || "";
    }
    return el.textContent || "";
  }

  // ------------------------- signatures -------------------------

  function fnv(text, cap) {
    let h = 0x811c9dc5;
    const n = Math.min(text.length, cap);
    for (let i = 0; i < n; i++) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(36);
  }

  // Override keys hash only the first 200 chars so a streaming paragraph
  // that grows doesn't lose the flip the user applied to it.
  function hashText(text) { return fnv(text, 200); }

  // Change detector for an element's text. Hashing a whole 4000-character
  // answer on every token was the single most expensive thing this script
  // did; length plus the first and last 128 characters moves on any edit
  // that matters (a stream only ever grows) at a fixed ~256 operations,
  // and it returns a number, so comparing costs nothing either.
  const SIG_SAMPLE = 128;

  function computeSig(text) {
    const n = text.length;
    let h = (0x811c9dc5 ^ n) >>> 0;
    const head = n < SIG_SAMPLE ? n : SIG_SAMPLE;
    for (let i = 0; i < head; i++) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    let tail = n - SIG_SAMPLE;
    if (tail < head) tail = head;
    for (let i = tail; i < n; i++) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
  }

  function getOverride(text) {
    if (!text) return null;
    // Fast path: hashing a paragraph's text costs a full FNV-1a pass
    // over up to 200 chars. For a user with no manual overrides — the
    // common case — every paragraph pays that cost for a lookup that
    // is always a miss. Skip the hash entirely when the map is empty.
    if (overrides.size === 0) return null;
    return overrides.get(hashText(text)) || null;
  }

  // A Map keeps insertion order, so dropping the oldest key is enough to
  // keep this from growing one entry per manual flip forever. The cap
  // matters more now that these outlive the tab.
  const MAX_OVERRIDES = 500;
  let saveTimer = 0;

  function saveOverrides() {
    // Debounced: a user correcting a few paragraphs in a row should cost
    // one write, not one per flip.
    if (saveTimer) return;
    saveTimer = setTimeout(function () {
      saveTimer = 0;
      const obj = {};
      overrides.forEach(function (v, k) { obj[k] = v; });
      try { chrome.storage.local.set({ [KEY_OVERRIDES]: obj }); } catch (_) {}
    }, 400);
  }

  function setOverride(text, dir) {
    const key = hashText(text);
    if (!overrides.has(key) && overrides.size >= MAX_OVERRIDES) {
      overrides.delete(overrides.keys().next().value);
    }
    overrides.set(key, dir);
    saveOverrides();
  }

  // Remove one paragraph's override so the engine decides for it again.
  // Returns true if an override actually existed for this text.
  function removeOverride(text) {
    if (!text) return false;
    const key = hashText(text);
    if (!overrides.has(key)) return false;
    overrides.delete(key);
    saveOverrides();
    return true;
  }

  // The popup cleared every override (possibly from another tab). Drop
  // ours too — otherwise the next flip here would write them all back —
  // and let every paragraph take its direction from the engine again.
  // Bumping the epoch is what a mode switch does: each cached decision is
  // invalidated and the next sweep recomputes it.
  function clearOverrides() {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = 0; }
    if (!overrides.size) return;
    overrides.clear();
    if (!running) return;
    epoch++;
    rescan();
  }

  function loadOverrides(cb) {
    try {
      chrome.storage.local.get({ [KEY_OVERRIDES]: {} }, function (res) {
        const obj = (res && res[KEY_OVERRIDES]) || {};
        const keys = Object.keys(obj);
        // Oldest first, so the cap drops the oldest if the stored set is
        // somehow larger than the cap.
        for (let i = Math.max(0, keys.length - MAX_OVERRIDES); i < keys.length; i++) {
          overrides.set(keys[i], obj[keys[i]]);
        }
        cb();
      });
    } catch (_) { cb(); }
  }

  // ------------------------- streaming probe -------------------------

  let streamCacheAt = -1e9;
  let streamCacheVal = false;
  let streamSince = 0;

  // True while the site says an answer is being generated. Cached briefly
  // because this runs on every queued element.
  //
  // Deliberately a whole-page signal rather than a per-element one. A
  // reasoning answer pauses for many seconds between bursts ("Worked for
  // 20s"), which the per-element quiet timer alone would read as
  // "settled" — and restructuring a paragraph that is about to receive
  // more tokens is exactly what breaks the renderer.
  //
  // STALL GUARD: if a site ever ships markup that keeps one of these
  // selectors permanently matched, the bdi pass must not be disabled
  // forever, so the signal expires after five minutes.
  // Site-agnostic backstop: a page that is rewriting its own DOM many
  // times a second is producing something. One entry per observer batch
  // (roughly one per frame), so streaming scores far above the threshold
  // while a ticking clock or a spinner scores well below it.
  const MUT_RING = 64;
  const mutTimes = new Float64Array(MUT_RING);
  let mutHead = 0;      // next slot to write
  let mutCount = 0;     // how many slots are valid
  const BUSY_WINDOW_MS = 1200;
  const BUSY_BATCHES = 8;

  let domVersion = 0;

  function noteMutationBatch(t) {
    domVersion++;
    mutTimes[mutHead] = t;
    mutHead = (mutHead + 1) % MUT_RING;
    if (mutCount < MUT_RING) mutCount++;
  }

  // Has anything at all changed on the page very recently? Used to decide
  // whether an element we are seeing for the first time might still be
  // growing, or is part of an already-rendered conversation.
  function recentMutation(t) {
    if (mutCount === 0) return false;
    return t - mutTimes[(mutHead + MUT_RING - 1) % MUT_RING] < 800;
  }

  function isPageBusy(t) {
    let n = 0;
    for (let k = 1; k <= mutCount; k++) {
      if (t - mutTimes[(mutHead + MUT_RING - k) % MUT_RING] > BUSY_WINDOW_MS) break;
      if (++n >= BUSY_BATCHES) return true;
    }
    return false;
  }

  function isPageStreaming(t) {
    if (t - streamCacheAt < STREAM_CACHE_MS) return streamCacheVal;
    streamCacheAt = t;
    if (isPageBusy(t)) { streamCacheVal = true; return true; }
    let v = false;
    try {
      const hits = document.querySelectorAll(STREAM_MARKERS);
      for (let i = 0; i < hits.length; i++) {
        const n = hits[i];
        // A stop button that is still in the DOM but not rendered (some
        // sites keep it around hidden) does not mean anything is
        // streaming. Data attributes are trusted as-is.
        if (n.hasAttribute("data-is-streaming") ||
            n.hasAttribute("data-message-streaming") ||
            n.getClientRects().length) { v = true; break; }
      }
    } catch (_) { v = false; }
    if (!v) streamSince = 0;
    else {
      if (streamSince === 0) streamSince = t;
      if (t - streamSince > 300000) v = false;   // stuck selector, ignore it
    }
    streamCacheVal = v;
    return v;
  }


  // ------------------------- applying -------------------------

  function applyMarkTo(el, target) {
    const current = el.getAttribute(MARK);
    if (target === null) {
      if (current) {
        el.removeAttribute(MARK);
        el.style.removeProperty("direction");
        el.style.removeProperty("text-align");
      }
      return;
    }
    if (current !== target) {
      // Attribute is changing — we know the inline style must be
      // (re)applied too, so skip the defensive style read entirely
      // and go straight to the writes. On a fresh page with 300
      // paragraphs this drops 600 inline-style reads.
      el.setAttribute(MARK, target);
      el.style.setProperty("direction", target, "important");
      if (el.tagName !== "TABLE") {
        el.style.setProperty("text-align", target === "rtl" ? "right" : "left", "important");
      }
      return;
    }
    // Attribute already equals target. Belt and suspenders: verify the
    // inline !important direction is still ours (a site's own script
    // may have clobbered it). Only then are the reads worth doing.
    if (el.style.getPropertyValue("direction") !== target ||
        el.style.getPropertyPriority("direction") !== "important") {
      el.style.setProperty("direction", target, "important");
      if (el.tagName !== "TABLE") {
        el.style.setProperty("text-align", target === "rtl" ? "right" : "left", "important");
      }
    }
  }

  /*
   * The prompt box.
   *
   * Content inside an editable area is never touched — wrapping the user's
   * own text would corrupt what they are about to send. Direction is a
   * different matter: typing Persian into a left-to-right box puts the
   * final «؟» or «.» on the wrong side of the line, which is the most
   * frequent annoyance these sites have for a Persian writer.
   *
   * dir="auto" on each paragraph is the whole fix. The browser then applies
   * the first-strong rule per paragraph, live, with no listener and no
   * work per keystroke. Setting it on the editable ROOT instead does not
   * work: the root resolves once for all of its content, so one Persian
   * line drags every English line in the box around with it.
   *
   * Every attribute we add is tagged so it can be taken back off cleanly.
   */
  function setAutoDir(el) {
    if (!el || el.getAttribute("dir") === "auto") return;
    if (el.hasAttribute("dir")) return;          // the site set its own
    try {
      el.setAttribute("dir", "auto");
      el.setAttribute(DIR_ATTR, "1");
    } catch (_) {}
  }

  function applyInputDir(el) {
    if (mode === "auto") return;
    if (EDIT_BLOCKS.has(el.tagName)) setAutoDir(el);
  }

  function sweepEditables() {
    if (mode === "auto") return;
    let boxes;
    try { boxes = document.querySelectorAll(INPUT_SKIP); } catch (_) { return; }
    for (let i = 0; i < boxes.length; i++) {
      const box = boxes[i];
      if (box.tagName === "TEXTAREA") continue;  // the stylesheet covers those
      let blocks = null;
      try { blocks = box.querySelectorAll(EDIT_BLOCK_SEL); } catch (_) {}
      if (blocks && blocks.length) {
        for (let j = 0; j < blocks.length; j++) setAutoDir(blocks[j]);
      } else {
        setAutoDir(box);                         // plain text, no blocks
      }
    }
  }

  function clearInputDirs() {
    let list;
    try { list = document.querySelectorAll("[" + DIR_ATTR + "]"); } catch (_) { return; }
    for (let i = 0; i < list.length; i++) {
      list[i].removeAttribute("dir");
      list[i].removeAttribute(DIR_ATTR);
    }
  }

  function isCodey(el) {
    const t = el.tagName;
    return t === "PRE" || t === "CODE";
  }

  // Direction only — never restructures children, so this is safe to run
  // on a paragraph that is still streaming.
  function applyDirection(el, text) {
    const ov = getOverride(text);
    if (ov) {
      applyMarkTo(el, ov);
      if (debug) {
        try { el.setAttribute(SRC_ATTR, "Manual"); el.removeAttribute(RULE_ATTR); } catch (_) {}
      }
      return ov;
    }

    let dir;
    if (mode === "auto") {
      dir = null;
    } else if (isCodey(el)) {
      dir = RastAIEngine.codeDirection(text);
      if (debug && dir) {
        try { el.setAttribute(SRC_ATTR, "Code"); el.removeAttribute(RULE_ATTR); } catch (_) {}
      }
    } else if (mode === "always") {
      dir = RastAIEngine.hasAnyPersian(text) ? "rtl" : null;
      if (debug && dir) {
        try { el.setAttribute(SRC_ATTR, "Always"); el.removeAttribute(RULE_ATTR); } catch (_) {}
      }
    } else {
      const verdict = RastAIEngine.directionOf(proseOf(el, text));
      dir = verdict.dir;
      if (debug) {
        try {
          el.setAttribute(RULE_ATTR, String(verdict.rule));
          el.setAttribute(SRC_ATTR, "R" + verdict.rule);
        } catch (_) {}
      }
    }

    applyMarkTo(el, dir);
    return dir;
  }

  // ------------------------- bdi wrapping -------------------------

  function splitAndWrap(textNode, text) {
    if (!text) return false;
    if (!HAS_WRAPPABLE.test(text)) return false;

    LATIN_RUN.lastIndex = 0;
    const pieces = [];
    let lastIndex = 0;
    let m;
    let anyIso = false;
    while ((m = LATIN_RUN.exec(text))) {
      const run = m[0];
      const iso = NEEDS_ISO.test(run);
      if (!iso) { continue; }                      // browser handles it fine
      // Arrow-only runs (→ between Persian words, "بگیر → بررسی") are
      // flow arrows. Browsers do NOT actually mirror U+2192 in RTL
      // context — the Unicode Bidi_Mirrored property is honored only
      // for brackets by most engines. So we tag arrow-only runs and
      // the injected CSS flips them visually with transform:scaleX(-1)
      // inside an RTL paragraph. Text content stays untouched (copy
      // still yields "→"), only the rendered glyph is mirrored.
      if (!HAS_LATIN.test(run)) {
        if (m.index > lastIndex) {
          pieces.push({ text: text.slice(lastIndex, m.index), iso: false });
        }
        pieces.push({ text: run, iso: true, arrow: true });
        anyIso = true;
        lastIndex = LATIN_RUN.lastIndex;
        continue;
      }
      if (m.index > lastIndex) {
        pieces.push({ text: text.slice(lastIndex, m.index), iso: false });
      }
      pieces.push({ text: run, iso: true });
      anyIso = true;
      lastIndex = LATIN_RUN.lastIndex;
    }
    if (!anyIso) return false;
    if (lastIndex < text.length) {
      pieces.push({ text: text.slice(lastIndex), iso: false });
    }

    const parent = textNode.parentNode;
    if (!parent || !parent.isConnected) return false;

    const frag = document.createDocumentFragment();
    for (let i = 0; i < pieces.length; i++) {
      const p = pieces[i];
      if (!p.text) continue;
      if (p.iso) {
        const b = document.createElement("bdi");
        b.setAttribute(ISO_ATTR, p.arrow ? "arrow" : "1");
        b.textContent = p.text;
        frag.appendChild(b);
      } else {
        frag.appendChild(document.createTextNode(p.text));
      }
    }
    // Re-check right before the swap: an async render may have moved the
    // node out from under us between the walk and here.
    if (textNode.parentNode !== parent) return false;
    try {
      parent.replaceChild(frag, textNode);
    } catch (_) {
      return false;
    }
    return true;
  }

  function wrapLatinInBdi(root) {
    // Never restructure code. Highlighters own that DOM.
    if (isCodey(root) || (root.closest && root.closest(WRAP_SKIP))) return;
    // A list or table holds no prose of its own; its items and cells are
    // visited separately.
    const rt = root.tagName;
    if (rt === "UL" || rt === "OL" || rt === "TABLE") return;

    let walker;
    try {
      walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
    } catch (_) { return; }

    const targets = [];
    let node, memoPar = null, memoSkip = false;
    while ((node = walker.nextNode())) {
      const parent = node.parentElement;
      if (!parent) continue;
      if (parent !== memoPar) {
        memoPar = parent;
        // Skip code, and skip anything that belongs to a nested element
        // which will be walked on its own visit — otherwise a <li> inside
        // a <ul> inside a <li> is walked three times.
        memoSkip = !!(parent.closest &&
          (parent.closest(WRAP_SKIP) || parent.closest(SEL) !== root));
      }
      if (memoSkip) continue;
      if (parent.tagName === "BDI" && parent.hasAttribute(ISO_ATTR)) continue;
      const data = node.data;
      if (!data) continue;
      OLD_ISOLATE_CHARS.lastIndex = 0;
      const hasOld = OLD_ISOLATE_CHARS.test(data);
      OLD_ISOLATE_CHARS.lastIndex = 0;
      if (!hasOld && !HAS_WRAPPABLE.test(data)) continue;
      targets.push({ node: node, hasOld: hasOld });
    }

    const wrapping = root.getAttribute(MARK) !== "ltr";

    for (let i = 0; i < targets.length; i++) {
      const node = targets[i].node;
      const hasOld = targets[i].hasOld;
      if (!node.isConnected) continue;
      let text = node.data;
      if (hasOld) text = text.replace(OLD_ISOLATE_CHARS, "");
      // In an LTR paragraph Latin needs no isolate — only strip legacy
      // control characters and leave the DOM alone.
      if (wrapping && splitAndWrap(node, text)) continue;
      if (hasOld) { try { node.data = text; } catch (_) {} }
    }
  }

  // ------------------------- scheduling -------------------------

  const revisit = new Set();
  let revisitTimer = 0;

  function armRevisit() {
    if (revisitTimer) return;
    revisitTimer = setTimeout(flushRevisit, STREAM_QUIET_MS + 60);
  }

  // A deferred element can only become eligible once the page stops
  // producing — that is the same condition for all of them. So while a
  // stream is running there is no point walking the deferred set at all;
  // re-arm and check again later. Without this, every paragraph on screen
  // was re-examined twice a second for the whole length of an answer.
  function flushRevisit() {
    revisitTimer = 0;
    if (revisit.size === 0) return;
    if (isPageStreaming(now())) { armRevisit(); return; }
    const list = [];
    revisit.forEach(function (n) { list.push(n); });
    revisit.clear();
    for (let i = 0; i < list.length; i++) {
      if (list[i].isConnected) enqueue(list[i]);
    }
  }

  // Deferred elements are only released when a stream ends. If that signal
  // ever sticks, this Set would grow without bound and hold detached
  // elements alive, so it gets a ceiling — anything past it is picked up by
  // the next sweep instead.
  const MAX_REVISIT = 4000;

  function scheduleRevisit(el) {
    if (revisit.size < MAX_REVISIT) revisit.add(el);
    armRevisit();
  }

  function markOne(el, t) {
    if (!el.isConnected) return;
    const st = stateOf(el);

    // Already finished at this epoch and nothing has mutated it since.
    // This is what makes the repeated safety-net sweeps over a long
    // conversation cost one WeakMap lookup per element instead of a
    // textContent read and a language scan.
    if (st.done === 1) return;

    if (st.skip === -1) {
      st.skip = (el.closest && el.closest(INPUT_SKIP)) ? 1 : 0;
    }
    if (st.skip === 1) {
      // Inside the prompt box: never touch the content, only the
      // direction of this one paragraph.
      applyInputDir(el);
      st.done = 1;
      return;
    }

    // A <code> inside a <pre> must follow the <pre>'s direction, never
    // carry one of its own, or flipping a code block leaves its contents
    // pointing the other way.
    if (st.preCode === -1) {
      st.preCode = (el.tagName === "CODE" && el.closest("pre")) ? 1 : 0;
    }
    if (st.preCode === 1) { st.done = 1; return; }

    // While an answer is streaming, a paragraph that already carries a
    // direction and has enough text for that decision to be stable needs
    // no further looks until the stream ends. This is the cheapest exit
    // in the file and the most valuable: it skips reading textContent,
    // which is the one genuinely expensive thing markOne does, on every
    // frame of every answer. A paragraph still waiting for its first
    // Persian character (mark === null) keeps being evaluated, so nothing
    // sits un-flipped while it is being written.
    if (st.mark && st.len >= FREEZE_LEN && isPageStreaming(t)) {
      scheduleRevisit(el);
      return;
    }

    // While tokens are arriving the observer fires roughly once a frame.
    // Re-reading and re-scanning the paragraph sixty times a second buys
    // nothing — the direction is already applied and structural work is
    // deferred regardless — so collapse those visits.
    if (t - st.visit < HOT_MIN_MS) { scheduleRevisit(el); return; }
    st.visit = t;

    const text = sampleText(el);
    st.len = text.length;
    const sig = computeSig(text);
    if (st.sig !== sig) {
      // First sight is not evidence of change. An element we have never
      // seen on a page where nothing has mutated recently belongs to an
      // already-rendered conversation, so it is settled and can be
      // finished in this one visit instead of being deferred and walked
      // again. If anything IS moving, treat it as still growing.
      st.hot = (st.sig === -1 && !recentMutation(t)) ? 0 : t;
      st.sig = sig;
    }

    if (st.dir !== sig) { st.dir = sig; st.mark = applyDirection(el, text); }

    // Structural work waits for calm. This is the fix for the collapsing
    // answer: while tokens are still arriving we touch nothing but the
    // element's own attribute and inline style.
    if (t - st.hot < STREAM_QUIET_MS || isPageStreaming(t)) {
      scheduleRevisit(el);
      return;
    }
    if (st.wrap !== sig) { st.wrap = sig; wrapLatinInBdi(el); }
    st.done = 1;
  }

  function processNode(root, t) {
    if (!root || root.nodeType !== 1) return;
    // Release the flat-queue reference BEFORE the isConnected check. A node
    // that was detached between being queued and being drained used to
    // return early and stay in the Set forever, and because the Set holds a
    // strong reference that pinned the whole detached subtree — so every
    // conversation switch stranded its paragraphs for the life of the tab.
    const wasFlat = flat.delete(root);
    if (!root.isConnected) return;
    if (wasFlat) { markOne(root, t); return; }
    if (root.matches && root.matches(SEL)) markOne(root, t);
    const list = root.querySelectorAll ? root.querySelectorAll(SEL) : null;
    if (!list || !list.length) return;
    // A big subtree is broken into individually queued elements so one
    // drain slice can never monopolise the main thread.
    if (list.length > 60) {
      for (let i = 0; i < list.length; i++) {
        const st = stateMap.get(list[i]);
        if (st !== undefined && st.done === 1 && st.ep === epoch) continue;
        enqueue(list[i], true);
      }
      return;
    }
    for (let i = 0; i < list.length; i++) markOne(list[i], t);
  }

  /*
   * The old drain() was:
   *     while (queue.length && deadline.timeRemaining() > 1) { ... }
   * When requestIdleCallback fires because its 500ms timeout expired,
   * timeRemaining() is 0, so that loop body never ran — it just
   * rescheduled itself forever. On a busy page (ChatGPT's own boot) the
   * browser never hands out idle time, so nothing was ever processed, and
   * the extension looked dead until you switched modes and the queue was
   * re-primed on a now-idle page. That is the "smart mode doesn't work
   * until you toggle it" bug.
   *
   * Now: a wall-clock budget, plus a guaranteed minimum batch so there is
   * always forward progress no matter how busy the page is.
   */
  function drain(deadline) {
    scheduled = false;
    const start = now();
    const hasDeadline = deadline && typeof deadline.timeRemaining === "function";
    let processed = 0;
    // One clock read per slice, not per element: a slice is at most
    // FRAME_BUDGET_MS long, which is well inside the tolerance of every
    // timestamp comparison downstream.
    while (queue.length) {
      if (processed >= MIN_BATCH) {
        if (now() - start > FRAME_BUDGET_MS) break;
        if (hasDeadline && !deadline.didTimeout && deadline.timeRemaining() <= 1) break;
      }
      const n = queue.shift();
      queued.delete(n);
      processNode(n, start);
      processed++;
    }
    if (queue.length) schedule();
  }

  function schedule() {
    if (scheduled) return;
    scheduled = true;
    rIC(drain, { timeout: 300 });
  }

  // Elements queued by a subtree expansion: their descendants were queued
  // by the same expansion, so processNode must not query them again.
  const flat = new Set();

  function enqueue(node, alreadyExpanded) {
    if (!node) return;
    if (queued.has(node)) {
      if (!alreadyExpanded) flat.delete(node);
      return;
    }
    queued.add(node);
    if (alreadyExpanded) flat.add(node);
    queue.push(node);
    schedule();
  }

  // One selector walk answers both questions at once: if our own <bdi> is
  // nearer than the paragraph, the mutation came from us and is ignored.
  const HOST_SEL = SEL + ",bdi[" + ISO_ATTR + "]";

  // During a stream the same element mutates dozens of times a second, so
  // a single memo slot removes almost every one of these selector walks.
  let hostMemoEl = null;
  let hostMemoRes = null;

  function enqueueHost(node, streaming) {
    if (!node) return;
    const el = node.nodeType === 1 ? node : node.parentElement;
    if (!el || !el.closest) return;
    if (el.id === BTN_ID) return;
    let host;
    if (el === hostMemoEl) {
      host = hostMemoRes;
    } else {
      host = el.closest(HOST_SEL);
      if (host && host.tagName === "BDI") host = null;
      hostMemoEl = el;
      hostMemoRes = host;
    }
    if (!host) return;
    const st = stateMap.get(host);
    if (st !== undefined) st.done = 0;
    // A paragraph that is frozen for the duration of the stream would
    // only be queued, scheduled, drained and then skipped. Going straight
    // on the deferred list instead removes the entire round trip — which,
    // once the freeze above is in place, is all that was left of the
    // per-frame cost of an answer being written.
    if (streaming === true && st !== undefined && st.mark && st.len >= FREEZE_LEN) {
      revisit.add(host);
      armRevisit();
      return;
    }
    // Self only: anything that changed inside it raised its own record.
    enqueue(host, true);
  }

  /*
   * The old onMutations relied on observer.takeRecords() inside the wrap
   * pass to swallow the records our own DOM surgery generated. That threw
   * away every OTHER pending record too — including real streaming updates
   * from the page — so paragraphs silently stopped being processed.
   *
   * Now nothing is discarded. Self-inflicted records are harmless because
   * markOne() compares a text signature first: our bdi surgery does not
   * change textContent, so a re-entry costs one hash and exits.
   */
  function onMutations(muts) {
    const t = now();
    noteMutationBatch(t);
    const streaming = isPageStreaming(t);
    for (let i = 0; i < muts.length; i++) {
      const m = muts[i];
      if (m.type === "childList") {
        const added = m.addedNodes;
        for (let j = 0; j < added.length; j++) {
          const n = added[j];
          if (n.nodeType === 1) {
            if (n.id === BTN_ID) continue;
            if (n.tagName === "BDI" && n.hasAttribute(ISO_ATTR)) continue;
            enqueue(n);
          }
        }
        // The host paragraph itself changed shape, so its direction has
        // to be reconsidered even when the added node is an element.
        enqueueHost(m.target, streaming);
      } else if (m.type === "characterData") {
        enqueueHost(m.target, streaming);
      }
    }
  }

  function startObserver() {
    if (observing || !document.body) return;
    observing = true;
    observer = new MutationObserver(onMutations);
    observer.observe(document.body, {
      childList: true, subtree: true, characterData: true
    });
    enqueue(document.body);
  }

  function waitForBody(fn) {
    if (document.body) return fn();
    const mo = new MutationObserver(function () {
      if (document.body) { mo.disconnect(); fn(); }
    });
    mo.observe(document.documentElement, { childList: true });
  }

  // Safety-net sweeps are frequent (startup, tab return, route change,
  // stream end) and each one is a whole-document query. If the observer
  // has seen no mutation since the last sweep there is, by construction,
  // nothing new to find, so the sweep is skipped outright.
  let sweptVersion = -1;
  let sweptEpoch = -1;

  function rescan() {
    if (!running || !document.body) return;
    if (domVersion === sweptVersion && epoch === sweptEpoch) return;
    sweptVersion = domVersion;
    sweptEpoch = epoch;
    hostMemoEl = null;      // never hold a detached element across a sweep
    hostMemoRes = null;
    sweepEditables();
    enqueue(document.body);
  }

  // Safety net for slow / late-hydrating app shells: a handful of sweeps
  // over the first few seconds, so a paragraph that existed before the
  // observer was wired up is never missed.
  let primed = false;

  function primeSweeps() {
    const delays = [0, 400, 1500, 4000, 9000];
    for (let i = 0; i < delays.length; i++) setTimeout(rescan, delays[i]);
  }

  function applyMode(m) {
    mode = m || "smart";
    if (!running) return;
    epoch++;                       // invalidates every cached decision
    ensureStyle();
    document.documentElement.classList.add(CLASS_RTL);
    document.documentElement.classList.toggle(CLASS_INPUT, mode !== "auto");
    if (mode === "auto") clearInputDirs();
    else sweepEditables();
    if (document.body) { startObserver(); rescan(); }
    else waitForBody(function () { startObserver(); primeSweeps(); });
    // The startup sweeps exist to catch content that was on the page before
    // the observer was wired up. A later mode switch has an observer
    // already running, so one rescan is all it needs.
    if (!primed) { primed = true; primeSweeps(); }
  }

  function applyFont(on) {
    fontOn = !!on;
    if (!running) return;
    ensureStyle();
    document.documentElement.classList.toggle(CLASS_FONT, fontOn);
  }

  // ------------------------- diagnostics -------------------------
  //
  // Off by default and gated everywhere, so it costs one boolean check when
  // it is not in use. Its real job is not the outlines — it is the export:
  // a corpus harvested from a conversation you actually had beats any set
  // of examples written from imagination, and it is the only way to tell
  // whether a change to the rules made things better or merely different.

  const RULE_FA = {
    1: "بدون فارسی — دست‌نخورده",
    2: "بدون لاتین",
    3: "شروع با فارسی",
    4: "کلمات فارسی بیشتر",
    5: "فارسی بین لاتین",
    6: "لاتین‌محور — چپ‌چین"
  };

  let debug = false;
  let fontOn = false;
  let lhOn = false;
  let lhMode = "normal";
  let scale = 100;
  let running = false;      // is the extension actually doing anything here
  let panel = null;
  let panelTimer = 0;

  function collectDecisions() {
    const out = [];
    const seen = new Set();
    let list;
    try { list = document.querySelectorAll("[" + RULE_ATTR + "]"); } catch (_) { return out; }
    for (let i = 0; i < list.length; i++) {
      const el = list[i];
      // Page furniture is decided and marked like anything else, but it is
      // not conversation text, so it does not belong in a corpus of
      // conversation text.
      if (el.closest && el.closest("nav, aside, header, footer")) continue;
      // A table's own text is its cells run together with no spaces; the
      // cells are exported individually and are the useful rows.
      if (el.tagName === "TABLE") continue;
      // sampleText, not textContent: a list is decided on its first item,
      // so exporting the whole list's text produced rows whose recorded
      // rule did not match the text beside it — the export was lying
      // about what the engine had actually been given.
      const prose = proseOf(el, sampleText(el)).replace(/\s+/g, " ").trim();
      if (prose.length < 2) continue;
      // Nested blocks export the same sentence more than once; the corpus
      // should weigh a case once, not once per wrapper around it.
      if (seen.has(prose)) continue;
      seen.add(prose);
      out.push({
        prose: prose,
        expect: el.getAttribute(MARK),          // what the engine chose
        note: "harvested, rule " + el.getAttribute(RULE_ATTR)
      });
    }
    return out;
  }

  function copyCorpus() {
    const rows = collectDecisions();
    const json = JSON.stringify(rows, null, 1);
    try {
      const ta = document.createElement("textarea");
      ta.value = json;
      ta.style.cssText = "position:fixed;opacity:0;pointer-events:none;";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
      return rows.length;
    } catch (_) { return -1; }
  }

  // The panel is built once and only its counts are rewritten. Rebuilding
  // the whole thing on every tick replaced the button element too, which
  // wiped the "copied" feedback a moment after it appeared.
  let panelHead = null, panelRows = null, panelBtn = null, panelSig = "";

  function buildPanel() {
    panel = document.createElement("div");
    panel.id = PANEL_ID;
    panelHead = document.createElement("b");
    panelRows = document.createElement("div");
    panelBtn = document.createElement("button");
    panelBtn.type = "button";
    panelBtn.textContent = "کپی JSON";
    panel.appendChild(panelHead);
    panel.appendChild(panelRows);
    panel.appendChild(panelBtn);
    panelBtn.addEventListener("click", function () {
      const n = copyCorpus();
      panelBtn.textContent = n < 0 ? "کپی نشد" : ("کپی شد: " + n + " پاراگراف");
      setTimeout(function () {
        if (panelBtn) panelBtn.textContent = "کپی JSON";
      }, 2000);
    }, true);
    document.body.appendChild(panel);
  }

  function renderPanel() {
    if (!debug) return;
    if (!panel || !panel.isConnected) {
      if (!document.body) return;
      buildPanel();
    }
    const counts = {};
    let list;
    try { list = document.querySelectorAll("[" + RULE_ATTR + "]"); } catch (_) { return; }
    for (let i = 0; i < list.length; i++) {
      const r = list[i].getAttribute(RULE_ATTR);
      counts[r] = (counts[r] || 0) + 1;
    }
    const keys = Object.keys(counts).sort();
    const sig = list.length + "|" + keys.map(function (k) { return k + ":" + counts[k]; }).join(",");
    if (sig === panelSig) return;             // nothing moved; leave the DOM alone
    panelSig = sig;
    panelHead.textContent = "حالت تشخیص — " + list.length + " پاراگراف";
    panelRows.textContent = "";
    for (let i = 0; i < keys.length; i++) {
      const row = document.createElement("i");
      const name = document.createElement("u");
      name.textContent = RULE_FA[keys[i]] || RastAIEngine.RULE_NAMES[keys[i]] || "";
      const num = document.createElement("span");
      num.textContent = keys[i] + " · " + counts[keys[i]];
      row.appendChild(name);
      row.appendChild(num);
      panelRows.appendChild(row);
    }
  }

  function applyDebug(on) {
    const want = !!on;
    if (want && !running) return;   // nothing to diagnose while switched off
    if (want === debug) return;
    debug = want;
    ensureStyle();
    document.documentElement.classList.toggle(CLASS_DEBUG, debug);
    if (debug) {
      epoch++;                       // force every element to be re-decided
      rescan();
      if (!panelTimer) panelTimer = setInterval(renderPanel, 900);
      renderPanel();
    } else {
      if (panelTimer) { clearInterval(panelTimer); panelTimer = 0; }
      if (panel && panel.isConnected) panel.remove();
      panel = null; panelHead = null; panelRows = null; panelBtn = null;
      panelSig = "";
      let list;
      try { list = document.querySelectorAll("[" + RULE_ATTR + "]"); } catch (_) { list = []; }
      for (let i = 0; i < list.length; i++) list[i].removeAttribute(RULE_ATTR);
      let slist;
      try { slist = document.querySelectorAll("[" + SRC_ATTR + "]"); } catch (_) { slist = []; }
      for (let i = 0; i < slist.length; i++) slist[i].removeAttribute(SRC_ATTR);
    }
  }

  // ------------------------- on / off -------------------------
  //
  // Turning this off has to mean OFF, not "mode = never". Leaving the
  // <bdi> wrappers behind would not be off at all: a bare <bdi> carries
  // unicode-bidi:isolate in the browser's own stylesheet, so the page
  // would still render differently from a page that never had the
  // extension on it. So everything we added comes back out — marks,
  // inline styles, dir attributes, the wrappers, the stylesheet, the
  // observer — and the page is left as we found it.

  function hostKey() {
    try { return location.hostname.replace(/^www\./, ""); } catch (_) { return ""; }
  }

  function unwrapAll() {
    let list;
    try { list = document.querySelectorAll("bdi[" + ISO_ATTR + "]"); } catch (_) { return; }
    for (let i = 0; i < list.length; i++) {
      const b = list[i];
      const par = b.parentNode;
      if (!par) continue;
      try {
        par.replaceChild(document.createTextNode(b.textContent || ""), b);
        par.normalize();          // re-join the text we split apart
      } catch (_) {}
    }
  }

  function teardown() {
    if (!running) return;
    running = false;

    if (observer) { try { observer.disconnect(); } catch (_) {} observer = null; }
    observing = false;
    queue.length = 0;
    queued.clear();
    flat.clear();
    revisit.clear();
    if (revisitTimer) { clearTimeout(revisitTimer); revisitTimer = 0; }
    scheduled = false;
    hostMemoEl = null;
    hostMemoRes = null;

    applyDebug(false);
    clearInputDirs();
    hideFlipBtn();
    if (flipBtn && flipBtn.isConnected) flipBtn.remove();
    flipBtn = null;

    let list;
    try { list = document.querySelectorAll("[" + MARK + "]"); } catch (_) { list = []; }
    for (let i = 0; i < list.length; i++) {
      const el = list[i];
      el.removeAttribute(MARK);
      el.removeAttribute(RULE_ATTR);
      el.removeAttribute(SRC_ATTR);
      el.style.removeProperty("direction");
      el.style.removeProperty("text-align");
    }
    unwrapAll();

    const c = document.documentElement.classList;
    c.remove(CLASS_RTL); c.remove(CLASS_FONT);
    c.remove(CLASS_INPUT); c.remove(CLASS_LH); c.remove(CLASS_DEBUG);
    c.remove(CLASS_SCALE);
    document.documentElement.style.removeProperty(SCALE_VAR);
    document.documentElement.removeAttribute(LH_ATTR);
    if (styleEl && styleEl.isConnected) styleEl.remove();
    styleEl = null;
  }

  function startup() {
    if (running) return;
    running = true;
    applyMode(mode);
    applyFont(fontOn);
    applyLineHeight(lhMode);
    applyScale(scale);
  }

  function applySite(offMap) {
    const off = !!(offMap && offMap[hostKey()] === true);
    if (off) teardown();
    else startup();
  }

  // v1.40 accepts either a boolean (the legacy KEY_LH shape: false = normal,
  // true = comfortable) or one of "compact" | "normal" | "comfortable".
  // Anything else, including undefined, snaps to "normal".
  function normLh(v) {
    if (v === true) return "comfortable";
    if (v === false || v == null) return "normal";
    return LH_MODES.indexOf(v) < 0 ? "normal" : v;
  }
  function applyLineHeight(v) {
    lhMode = normLh(v);
    lhOn = lhMode === "comfortable";              // preserved for KEY_LH boolean writers
    if (!running) return;
    ensureStyle();
    document.documentElement.classList.toggle(CLASS_LH, lhOn);
    if (lhMode === "normal") document.documentElement.removeAttribute(LH_ATTR);
    else document.documentElement.setAttribute(LH_ATTR, lhMode);
  }

  function normScale(v) {
    const n = Number(v);
    return SCALES.indexOf(n) === -1 ? 100 : n;
  }

  function applyScale(v) {
    scale = normScale(v);
    if (!running) return;
    const root = document.documentElement;
    if (scale === 100) {
      root.classList.remove(CLASS_SCALE);
      root.style.removeProperty(SCALE_VAR);
      return;
    }
    ensureStyle();
    root.style.setProperty(SCALE_VAR, String(scale / 100));
    root.classList.add(CLASS_SCALE);
  }

  // ------- Selection-based flip button (per-paragraph manual override) -------

  let flipBtn = null;
  let btnTarget = null;
  let selectionScheduled = false;
  let mousedownTarget = null;

  function ensureFlipBtn() {
    if (flipBtn && flipBtn.isConnected) return;
    flipBtn = document.createElement("button");
    flipBtn.id = BTN_ID;
    flipBtn.title = "تغییر جهت پاراگراف";
    flipBtn.setAttribute("aria-label", "تغییر جهت پاراگراف");
    flipBtn.innerHTML =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" ' +
      'fill="none" stroke="currentColor" stroke-width="2.2" ' +
      'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<path d="M20 7H8"/><path d="m12 3-4 4 4 4"/>' +
      '<path d="M4 17h12"/><path d="m12 13 4 4-4 4"/></svg>';
    // Grab the target at mousedown, BEFORE any selectionchange from the
    // click can null out btnTarget by hiding the button.
    flipBtn.addEventListener("mousedown", function (e) {
      mousedownTarget = btnTarget;
      e.preventDefault();
      e.stopPropagation();
    }, true);
    flipBtn.addEventListener("click", onFlipClick, true);
    document.body.appendChild(flipBtn);
  }

  function hideFlipBtn() {
    if (flipBtn) flipBtn.classList.remove("on");
    btnTarget = null;
  }

  function positionAtSelection(rect, targetEl) {
    ensureFlipBtn();
    const btnW = 34, btnH = 34;
    const pRect = targetEl.getBoundingClientRect();
    let left = pRect.right + 8;
    if (left + btnW > window.innerWidth - 4) left = window.innerWidth - btnW - 4;
    let top = rect.top + rect.height / 2 - btnH / 2;
    top = Math.max(4, Math.min(window.innerHeight - btnH - 4, top));
    flipBtn.style.setProperty("top", top + "px", "important");
    flipBtn.style.setProperty("left", left + "px", "important");
    flipBtn.classList.add("on");
    btnTarget = targetEl;
  }

  // The paragraph the caret or selection is sitting in — the same target
  // the ⇄ button uses, so the shortcut and the button always agree.
  function selectionTarget() {
    const sel = document.getSelection && document.getSelection();
    if (!sel || sel.rangeCount === 0) return null;
    let node = sel.getRangeAt(0).startContainer;
    if (node && node.nodeType === 3) node = node.parentElement;
    if (!node || !node.closest) return null;
    let target = node.closest(SEL);
    if (!target || target.closest(INPUT_SKIP)) return null;
    if (target.tagName === "CODE") {
      const pre = target.closest("pre");
      if (pre) target = pre;
    }
    return target;
  }

  // Two-state cycle: no override → override, then override → engine.
  // First press flips whatever the engine picked (saved as an override).
  // Second press on the same paragraph removes the override and lets
  // the engine decide again — no third state, no toggling back and
  // forth between two overrides. If the user really wants the opposite
  // of the engine again, a third press flips fresh from engine truth.
  function flipTarget(target) {
    if (!target || !target.isConnected) return;
    const text = target.textContent;
    const hadOverride = !!getOverride(text);
    const st = stateOf(target);
    if (hadOverride) {
      removeOverride(text);
      // Force a full re-evaluation: engine will pick the paragraph's
      // natural direction and the bdi pass will run against it.
      st.sig = -1;
      st.dir = -1;
      st.wrap = -1;
      st.done = 0;
      void target.offsetWidth;
      enqueue(target);
      return;
    }
    const current = target.getAttribute(MARK) === "rtl" ? "rtl" : "ltr";
    const flipped = current === "rtl" ? "ltr" : "rtl";
    setOverride(text, flipped);
    applyMarkTo(target, flipped);
    st.sig = computeSig(text);
    st.dir = st.sig;
    st.wrap = -1;
    st.done = 0;
    void target.offsetWidth;
    guardFlip(target, flipped);
    enqueue(target);
  }

  function onFlipClick(e) {
    e.stopPropagation();
    e.preventDefault();
    const target = mousedownTarget || btnTarget;
    mousedownTarget = null;
    flipTarget(target);
    hideFlipBtn();
    try { document.getSelection().removeAllRanges(); } catch (_) {}
  }

  function flipFromShortcut() {
    if (!running) return;
    flipTarget(selectionTarget());
    hideFlipBtn();
  }

  // If a framework re-render undoes our attribute/inline style right after
  // the click, re-apply on the next frame. Only runs while actually needed.
  function guardFlip(el, dir, retriesLeft) {
    if (typeof retriesLeft !== "number") retriesLeft = 6;
    if (!el.isConnected || retriesLeft <= 0) return;
    requestAnimationFrame(function () {
      if (!el.isConnected) return;
      const needAttr = el.getAttribute(MARK) !== dir;
      const needStyle =
        el.style.getPropertyValue("direction") !== dir ||
        el.style.getPropertyPriority("direction") !== "important";
      if (needAttr || needStyle) {
        applyMarkTo(el, dir);
        guardFlip(el, dir, retriesLeft - 1);
      }
    });
  }

  function handleSelection() {
    if (!running) return;
    const sel = document.getSelection && document.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) { hideFlipBtn(); return; }
    const range = sel.getRangeAt(0);
    let node = range.startContainer;
    if (node && node.nodeType === 3) node = node.parentElement;
    if (!node) { hideFlipBtn(); return; }
    let target = node.closest && node.closest(SEL);
    if (!target || target.closest(INPUT_SKIP)) { hideFlipBtn(); return; }
    // A <code> inside a <pre> means the user meant the whole code block.
    if (target.tagName === "CODE") {
      const pre = target.closest("pre");
      if (pre) target = pre;
    }
    const rect = range.getBoundingClientRect();
    if (!rect || (rect.width === 0 && rect.height === 0)) { hideFlipBtn(); return; }
    positionAtSelection(rect, target);
  }

  function onSelectionChange() {
    if (selectionScheduled) return;
    selectionScheduled = true;
    requestAnimationFrame(function () {
      selectionScheduled = false;
      handleSelection();
    });
  }

  // ------- Copy handler (strip legacy LRI/PDI markers) -------

  const ISO_STRIP_RE = /[⁦-⁩]/g;

  function onCopy(e) {
    if (!running) return;
    try {
      const sel = document.getSelection && document.getSelection();
      if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return;
      const text = sel.toString();
      ISO_STRIP_RE.lastIndex = 0;
      if (!ISO_STRIP_RE.test(text)) return;
      ISO_STRIP_RE.lastIndex = 0;
      if (!e.clipboardData) return;
      e.preventDefault();
      e.clipboardData.setData("text/plain", text.replace(ISO_STRIP_RE, ""));
      try {
        const c = document.createElement("div");
        for (let i = 0; i < sel.rangeCount; i++) {
          c.appendChild(sel.getRangeAt(i).cloneContents());
        }
        e.clipboardData.setData("text/html", c.innerHTML.replace(ISO_STRIP_RE, ""));
      } catch (_) {}
    } catch (_) {}
  }

  // ------- Wire everything up -------

  document.addEventListener("selectionchange", onSelectionChange, true);
  window.addEventListener("scroll", hideFlipBtn, true);
  document.addEventListener("copy", onCopy, true);

  // ChatGPT quirk (v1.42.2 CSS only): kill the focus outline on
  // <main class*="MainContentSurface"> so it no longer reads as a
  // black frame around the chat. An earlier attempt also blurred
  // that element on focusin so the arrow key would fall through to
  // page scroll, but blurring <main> during a click cancels the
  // browser's text selection (broken in v1.42.2, fixed in v1.42.3
  // by removing the blur). The frame is the main annoyance; if
  // arrow keys land on <main> and don't scroll, click elsewhere or
  // use PgUp/PgDn.

  // A tab that was hidden gets no idle callbacks, so re-prime on return.
  document.addEventListener("visibilitychange", function () {
    if (!document.hidden) rescan();
  });

  // These are single-page apps: switching conversations replaces the whole
  // message list without a navigation the content script can hook. A cheap
  // URL poll catches it. (history.pushState can't be patched from a
  // content script — that runs in an isolated world.)
  // One timer does both jobs: notice a conversation switch, and notice
  // that a stream has ended so the bdi pass deferred during it can run.
  let lastHref = location.href;
  let wasStreaming = false;
  setInterval(function () {
    if (!running || document.hidden) return;
    if (location.href !== lastHref) {
      lastHref = location.href;
      rescan();
      setTimeout(rescan, 500);
      setTimeout(rescan, 1500);
    }
    const s = isPageStreaming(now());
    if (wasStreaming && !s) { rescan(); setTimeout(rescan, 400); }
    wasStreaming = s;
  }, 500);

  loadOverrides(function () {
  chrome.storage.sync.get(
    { [KEY_MODE]: null, [KEY_FONT]: false, [KEY_DEBUG]: false,
      [KEY_LH]: false, [KEY_SITES]: {}, [KEY_OLD_RTL]: true,
      [KEY_SCALE]: 100 },
    function (res) {
      let m = res && res[KEY_MODE];
      if (!m) {
        m = (res && res[KEY_OLD_RTL] === false) ? "auto" : "smart";
        try { chrome.storage.sync.set({ [KEY_MODE]: m }); } catch (_) {}
      }
      mode = m;
      fontOn = !!(res && res[KEY_FONT] === true);
      lhMode = normLh(res && res[KEY_LH]);
      lhOn = lhMode === "comfortable";
      scale = normScale(res && res[KEY_SCALE]);
      const wantDebug = !!(res && res[KEY_DEBUG] === true);
      applySite(res && res[KEY_SITES]);
      if (wantDebug && running) applyDebug(true);
    }
  );
  });

  chrome.storage.onChanged.addListener(function (changes, area) {
    if (area === "local") {
      // Only an emptied set means anything here: this tab's own flips
      // write non-empty sets, and those are already in its map.
      const ch = changes[KEY_OVERRIDES];
      if (ch && (!ch.newValue || !Object.keys(ch.newValue).length)) clearOverrides();
      return;
    }
    if (area !== "sync") return;
    if (changes[KEY_SITES]) applySite(changes[KEY_SITES].newValue);
    if (changes[KEY_MODE]) {
      mode = changes[KEY_MODE].newValue || "smart";
      if (running) applyMode(mode);
    }
    if (changes[KEY_FONT]) applyFont(changes[KEY_FONT].newValue === true);
    if (changes[KEY_LH]) applyLineHeight(changes[KEY_LH].newValue);
    if (changes[KEY_DEBUG]) applyDebug(changes[KEY_DEBUG].newValue === true);
    if (changes[KEY_SCALE]) applyScale(changes[KEY_SCALE].newValue);
  });

  chrome.runtime.onMessage.addListener(function (msg, _sender, sendResponse) {
    if (!msg || msg.type !== "rastai-toggle") return;
    if ("siteOn" in msg) { if (msg.siteOn) startup(); else teardown(); }
    if ("mode" in msg) { mode = msg.mode; if (running) applyMode(mode); }
    if ("font" in msg) applyFont(msg.font);
    if ("lineSpacing" in msg) applyLineHeight(msg.lineSpacing);
    if ("debug" in msg) applyDebug(msg.debug);
    if ("fontScale" in msg) applyScale(msg.fontScale);
    if (msg.clearOverrides) clearOverrides();
    if (msg.flip) flipFromShortcut();
    if (sendResponse) sendResponse({ ok: true });
  });
})();
