// Service worker: gets a tab-audio stream id (no share prompt) and hands it to the offscreen recorder.
async function ensureOffscreen() {
  if (await chrome.offscreen.hasDocument()) return;
  await chrome.offscreen.createDocument({
    url: "offscreen.html",
    reasons: ["USER_MEDIA"],
    justification: "Record the active tab's audio for transcription.",
  });
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.target === "offscreen" || msg.target === "popup") return;   // not for us
  (async () => {
    try {
      if (msg.type === "start") {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab) return sendResponse({ ok: false, error: "no active tab" });
        const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
        await ensureOffscreen();
        await chrome.storage.local.set({ recording: true, status: "recording", result: null });
        chrome.runtime.sendMessage({ target: "offscreen", type: "offscreen-start", streamId, lang: msg.lang, target: msg.target });
        sendResponse({ ok: true });
      } else if (msg.type === "stop") {
        await chrome.storage.local.set({ recording: false, status: "transcribing" });
        chrome.runtime.sendMessage({ target: "offscreen", type: "offscreen-stop" });
        sendResponse({ ok: true });
      }
    } catch (e) {
      await chrome.storage.local.set({ recording: false, status: "error: " + e.message });
      sendResponse({ ok: false, error: e.message });
    }
  })();
  return true;   // async sendResponse
});
