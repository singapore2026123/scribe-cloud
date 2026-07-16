# Scribe CareTalk — Chrome/Edge extension

A **voice-dialogue care-record** side panel (CWマスタ準拠: 食事・水分補給・排泄・バイタル). A caregiver
speaks; the panel fills a structured record, asks only for missing required items, and saves it.

**Multilingual input:** pick the spoken language in the header.
- 🎙 **日本語** → browser speech recognition (instant).
- ☁ **英・中・馬・泰・緬** → **Scribe Cloud** transcribes and **translates to Japanese**, which then drives the
  Japanese dialogue engine. So a Burmese/Tamil/Malay caregiver dictates in their own language and the record
  comes out structured in Japanese. Routing: `my` → HF Space (SeamlessM4T), others → Cloudflare Worker (Whisper).

**用語集 glossary built in:** the 675-term care glossary is bundled — Japanese homophone mis-conversions
(自備院効果→耳鼻咽喉科, 転眼→点眼 …) are corrected before extraction, and the Worker's ASR biasing prompt is
generated from the same terms.

## Install (load unpacked)
1. Open **chrome://extensions** (or **edge://extensions**).
2. Turn on **Developer mode** (top-right).
3. Click **Load unpacked** → select this `extension` folder.
4. Pin the **Scribe CareTalk** icon; click it to open the side panel.

## Use
1. Click the toolbar icon → the **care-record side panel** opens.
2. Pick the **spoken language** (header dropdown). Default 日本語.
3. Tap 🎤 and say it all at once, e.g. 「田中さんの昼食、主食8割、副食全量、お茶150cc」. ☁ languages auto-stop
   on a pause, then transcribe + translate.
4. The panel confirms missing required items, takes extras (場所・介助・状態コメント), and **saves** on 「なし」/「登録」.
5. Optional **⚙AI** (Gemini key) further normalizes utterances; off by default (rule engine works without it).

## Files
- `manifest.json` — MV3; opens `sidepanel.html` as the side panel; `host_permissions` for the Worker, HF Space,
  and (optional) Gemini.
- `background.js` — opens the side panel on icon click (`openPanelOnActionClick`).
- `sidepanel.html` + `sidepanel.js` — the CareTalk app (script externalized; MV3 forbids inline `<script>`).
- `offscreen.html` / `offscreen.js` — **unused** (leftovers from the retired tab-audio capture; safe to delete).

## Notes / caveats
- **Mic:** the side panel calls `getUserMedia` directly; Chrome prompts for microphone permission on first use.
- **Japanese browser STT** relies on `webkitSpeechRecognition`; if it is unavailable in the extension context,
  type Japanese or use a ☁ language (Scribe path). ☁ languages never need browser STT.
- **Endpoints** are set at the top of `sidepanel.js` (`SCRIBE_CF`, `SCRIBE_SPACE`); update if the Worker/Space move.
