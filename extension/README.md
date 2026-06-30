# Scribe Tab Audio — Chrome/Edge extension

Captures the **active tab's audio with NO screen-share prompt** (`chrome.tabCapture`), then transcribes +
translates via Scribe: **Burmese → your HF Space (SeamlessM4T)**, other languages → Netlify/Gemini.

## Install (load unpacked)
1. Open **chrome://extensions** (or **edge://extensions**).
2. Turn on **Developer mode** (top-right).
3. Click **Load unpacked** → select this `extension` folder.
4. (Optional) pin the **Scribe Tab Audio** icon to the toolbar.

## Use
1. Open the tab that's playing audio (a video, a call, etc.).
2. Click the **Scribe Tab Audio** icon → choose **Spoken language** + **Translate to**.
3. **Start** → it begins capturing that tab (no share dialog). You can switch to the tab and let it play.
4. Click the icon again → **Stop** → the transcript + translation appear (and persist if you reopen the popup).

Notes:
- The tab stays audible while capturing.
- First Burmese transcription wakes the Space (~30 s, one-time); then ~14 s.
- Recording continues even if the popup closes; reopen it and press **Stop**.

## How it connects
`tabCapture → record → WAV → POST`:
- `my` → `https://singapore2026123-scribe-burmese-asr.hf.space/transcribe`
- others → `https://kanamic-scribe.netlify.app/api/transcribe`

Update those URLs in `offscreen.js` if the Space / site changes.
