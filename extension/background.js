// Clicking the toolbar icon: open the side panel AND remember THIS tab as the capture target
// (the click grants activeTab on it, which tabCapture needs). Capture stays bound to it even if you switch tabs.
let captureTabId = null;
chrome.action.onClicked.addListener(async (tab) => {
  captureTabId = (tab && tab.id) || null;
  try { await chrome.sidePanel.open({ tabId: tab.id }); } catch (e) {}
});

async function ensureOffscreen() {
  if (await chrome.offscreen.hasDocument()) return;
  await chrome.offscreen.createDocument({
    url: "offscreen.html",
    reasons: ["USER_MEDIA"],
    justification: "Capture the active tab's audio for live transcription.",
  });
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.target === "offscreen" || msg.target === "panel") return;   // not for us
  (async () => {
    try {
      if (msg.type === "start") {
        let tabId = captureTabId;
        if (tabId == null) { const [t] = await chrome.tabs.query({ active: true, currentWindow: true }); tabId = t && t.id; }
        if (tabId == null) return sendResponse({ ok: false, error: "no tab — click the Scribe icon on the page first" });
        const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
        await ensureOffscreen();
        chrome.runtime.sendMessage({ target: "offscreen", type: "offscreen-start", streamId, lang: msg.lang, target: msg.target });
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
