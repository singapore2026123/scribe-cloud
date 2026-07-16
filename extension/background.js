// Scribe CareTalk — clicking the toolbar icon opens the care-record dialogue side panel.
// (The old tab-audio capture flow — offscreen.js / tabCapture — is retired for this build; the
//  CareTalk panel captures the microphone directly and calls Scribe Cloud /transcribe.)
chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
});
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
