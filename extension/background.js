// tabCapture MUST be tied to the icon-click invocation. So we grab the stream id HERE (on click),
// stash it in session storage (survives the service worker going inactive), and consume it at Start.
let pendingStart = null;

function flushPending() {
  if (!pendingStart) return;
  const j = pendingStart; pendingStart = null;
  chrome.runtime.sendMessage({ target: "offscreen", type: "offscreen-start", streamId: j.streamId, lang: j.lang, target: j.target });
}

async function ensureOffscreen() {
  if (await chrome.offscreen.hasDocument()) return true;
  await chrome.offscreen.createDocument({
    url: "offscreen.html",
    reasons: ["USER_MEDIA"],
    justification: "Capture the active tab's audio for live transcription.",
  });
  return false;
}

// Make sure the icon click fires onClicked (we open the panel ourselves) rather than auto-opening it.
chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => {});
});

chrome.action.onClicked.addListener(async (tab) => {
  try {
    await chrome.sidePanel.setOptions({ tabId: tab.id, path: "sidepanel.html", enabled: true });
    await chrome.sidePanel.open({ tabId: tab.id });
  } catch (e) {}
  try {
    if (tab && tab.url && /^https?:/i.test(tab.url)) {
      const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });   // valid invocation here
      await chrome.storage.session.set({ streamId, capError: "", status: "✓ Tab ready: " + (tab.title || "tab").slice(0, 40) + " — pick language & Start" });
    } else {
      await chrome.storage.session.set({ streamId: "", capError: "Open a normal web page (not chrome://) and click the Scribe icon there.", status: "✗ Not a web page — open YouTube etc. and click the Scribe icon there." });
    }
  } catch (e) {
    await chrome.storage.session.set({ streamId: "", capError: e.message, status: "✗ capture setup error: " + e.message });
  }
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.target === "offscreen" || msg.target === "panel") return;
  if (msg.type === "offscreen-ready") { flushPending(); return; }
  (async () => {
    try {
      if (msg.type === "start") {
        const { streamId, capError } = await chrome.storage.session.get(["streamId", "capError"]);
        if (!streamId) return sendResponse({ ok: false, error: capError || "Click the Scribe icon on the tab you want first." });
        pendingStart = { streamId, lang: msg.lang, target: msg.target };
        const existed = await ensureOffscreen();
        if (existed) flushPending();
        sendResponse({ ok: true });
      } else if (msg.type === "stop") {
        chrome.runtime.sendMessage({ target: "offscreen", type: "offscreen-stop" });
        await chrome.storage.session.set({ streamId: "" });   // consumed; require a fresh icon-click next time
        sendResponse({ ok: true });
      }
    } catch (e) { sendResponse({ ok: false, error: e.message }); }
  })();
  return true;
});
