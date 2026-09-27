/*
 * RastAI — background
 *
 * One job: relay the keyboard shortcut to the page. Chrome only delivers
 * chrome.commands to an extension context, not to a content script, so
 * this exists to forward it — and going through the commands API rather
 * than listening for a keystroke in the page means the shortcut shows up
 * in chrome://extensions/shortcuts where the user can change it, and
 * never fights a shortcut the site itself uses.
 *
 * Event-driven: it is asleep except for the instant a shortcut fires.
 */

const api = typeof browser !== "undefined" ? browser : chrome;

api.commands.onCommand.addListener(function (command) {
  if (command !== "flip-paragraph") return;
  api.tabs.query({ active: true, currentWindow: true }, function (tabs) {
    if (!tabs || !tabs.length || !tabs[0].id) return;
    try {
      const p = api.tabs.sendMessage(tabs[0].id, { type: "rastai-toggle", flip: true });
      if (p && p.catch) p.catch(function () {});   // no content script there
    } catch (_) {}
  });
});
