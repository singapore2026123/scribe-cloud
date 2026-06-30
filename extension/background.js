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

chrome.action.onClicked.addListener(async (tab) => {
  try { await chrome.sidePanel.open({ tabId: tab.id }); } catch (e) {}
  try {
    if (tab && tab.url && /^https?:/i.test(tab.url)) {
      const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });   // valid invocation here
      await chrome.storage.session.set({ streamId, capError: "", capTitle: tab.title || "" });
    } else {
      await chrome.storage.session.set({ streamId: "", capError: "Open a normal web page (not a chrome:// page), then click the Scribe icon there." });
    }
  } catch (e) {
    await chrome.storage.session.set({ streamId: "", capError: e.message });
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
