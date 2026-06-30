// Clicking the toolbar icon: open the side panel AND remember THIS tab as the capture target
// (the click grants activeTab on it, which tabCapture needs). Capture stays bound to it even if you switch tabs.
let captureTabId = null;
let pendingStart = null;   // start job waiting for the offscreen doc to load (avoids a message race)

chrome.action.onClicked.addListener(async (tab) => {
  captureTabId = (tab && tab.id) || null;
  try { await chrome.sidePanel.open({ tabId: tab.id }); } catch (e) {}
});

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

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.target === "offscreen" || msg.target === "panel") return;
  if (msg.type === "offscreen-ready") { flushPending(); return; }   // offscreen loaded -> send the queued job
  (async () => {
    try {
      if (msg.type === "start") {
        let tabId = captureTabId;
        if (tabId == null) { const [t] = await chrome.tabs.query({ active: true, currentWindow: true }); tabId = t && t.id; }
        if (tabId == null) return sendResponse({ ok: false, error: "no tab — click the Scribe icon on the page first" });
        const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
        pendingStart = { streamId, lang: msg.lang, target: msg.target };
        const existed = await ensureOffscreen();
        if (existed) flushPending();   // already loaded -> send now; else offscreen-ready will trigger it
        sendResponse({ ok: true });
      } else if (msg.type === "stop") {
        chrome.runtime.sendMessage({ target: "offscreen", type: "offscreen-stop" });
        sendResponse({ ok: true });
      }
    } catch (e) {
      sendResponse({ ok: false, error: e.message });
    }
  })();
  return true;
});
