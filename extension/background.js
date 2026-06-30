// Side panel config on worker start: register path + make icon clicks reach onClicked.
chrome.sidePanel.setOptions({ path: "sidepanel.html", enabled: true }).catch(() => {});
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => {});

async function ensureOffscreen() {
  if (await chrome.offscreen.hasDocument()) return true;
  await chrome.offscreen.createDocument({
    url: "offscreen.html",
    reasons: ["USER_MEDIA"],
    justification: "Capture the active tab's audio for live transcription.",
  });
  return false;
}

// Icon click = the valid tabCapture invocation. Open the panel synchronously (preserve gesture),
// then grab the tab stream id and stash it.
chrome.action.onClicked.addListener((tab) => {
  console.log("[Scribe] onClicked", tab && tab.url);
  chrome.sidePanel.open({ tabId: tab.id }).catch((e) => console.log("[Scribe] open error", e));
  (async () => {
    try {
      if (tab && tab.url && /^https?:/i.test(tab.url)) {
        const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
        await chrome.storage.session.set({ streamId, capError: "", status: "✓ Tab ready: " + (tab.title || "tab").slice(0, 40) + " — pick language & Start" });
      } else {
        await chrome.storage.session.set({ streamId: "", capError: "Open a normal web page (not chrome://) and click the Scribe icon there.", status: "✗ Not a web page — open e.g. YouTube and click the Scribe icon there." });
      }
    } catch (e) {
      await chrome.storage.session.set({ streamId: "", capError: e.message, status: "✗ capture setup error: " + e.message });
    }
  })();
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.target === "offscreen" || msg.target === "panel") return;
  (async () => {
    try {
      if (msg.type === "start") {
        const { streamId, capError } = await chrome.storage.session.get(["streamId", "capError"]);
        if (!streamId) return sendResponse({ ok: false, error: capError || "Click the Scribe icon on the tab you want first." });
        // Hand the job off via storage (survives the worker sleeping + the offscreen still loading), then poke the offscreen.
        await chrome.storage.session.set({ job: { streamId, lang: msg.lang, target: msg.target, ts: Date.now() } });
        await ensureOffscreen();
        chrome.runtime.sendMessage({ target: "offscreen", type: "offscreen-go" }).catch(() => {});
        sendResponse({ ok: true });
      } else if (msg.type === "stop") {
        chrome.runtime.sendMessage({ target: "offscreen", type: "offscreen-stop" });
        await chrome.storage.session.set({ streamId: "", job: null });
        sendResponse({ ok: true });
      }
    } catch (e) { sendResponse({ ok: false, error: e.message }); }
  })();
  return true;
});
