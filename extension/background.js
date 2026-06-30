// Side panel config on worker start: register path + make icon clicks reach onClicked.
chrome.sidePanel.setOptions({ path: "sidepanel.html", enabled: true }).catch(() => {});
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => {});

// (Re)create the offscreen doc with the job baked into its URL — no messaging/storage race.
async function startOffscreen(streamId, lang, target) {
  if (await chrome.offscreen.hasDocument()) await chrome.offscreen.closeDocument();
  const u = "offscreen.html?streamId=" + encodeURIComponent(streamId) +
            "&lang=" + encodeURIComponent(lang) + "&target=" + encodeURIComponent(target);
  await chrome.offscreen.createDocument({
    url: u,
    reasons: ["USER_MEDIA"],
    justification: "Capture the active tab's audio for live transcription.",
  });
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
        await startOffscreen(streamId, msg.lang, msg.target);
        sendResponse({ ok: true });
      } else if (msg.type === "stop") {
        chrome.runtime.sendMessage({ target: "offscreen", type: "offscreen-stop" }).catch(() => {});
        await chrome.storage.session.set({ streamId: "" });
        sendResponse({ ok: true });
      }
    } catch (e) { sendResponse({ ok: false, error: e.message }); }
  })();
  return true;
});
