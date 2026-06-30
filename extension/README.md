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
2. Click the **Scribe** toolbar icon → a **side panel** opens (stays open while you watch the tab).
3. Choose **Spoken language** + **Translate to** → **Start** (no share dialog).
4. Lines of transcription + translation stream in **every ~8 s** as the tab plays.
5. **Stop** when done; **Copy** grabs the originals.

Notes:
- **Near-real-time, ~8 s chunks** (not word-by-word). Good for JA/ZH/MS/EN.
- **Burmese lags** — the Space takes ~14 s/clip, so it trails behind live audio (it's the free trade-off).
- The tab stays audible while capturing; chunk boundaries may clip a word.

## How it connects
`tabCapture → record → WAV → POST`:
- `my` → `https://singapore2026123-scribe-burmese-asr.hf.space/transcribe`
- others → `https://kanamic-scribe.netlify.app/api/transcribe`

Update those URLs in `offscreen.js` if the Space / site changes.
