---
title: Scribe Burmese ASR
emoji: 🗣️
colorFrom: green
colorTo: blue
sdk: docker
app_port: 7860
pinned: false
---

# Scribe Burmese ASR (SeamlessM4T v2)

Free, unlimited Burmese speech-to-text + translation for Scribe Cloud — no API quota.

**Endpoint:** `POST /transcribe`
```json
{ "audio": "<base64 WAV>", "src": "my", "target": "en" }
```
returns
```json
{ "transcript": "<Burmese>", "translation": "<target language>" }
```

Runs `facebook/seamless-m4t-v2-large` on CPU (~10–15 s per clip). The same container also
deploys to Cloud Run / Fly.io / Render.

## Deploy to Hugging Face Spaces
1. Create a free account at huggingface.co.
2. **New → Space** → name `scribe-burmese-asr` → **Docker** (blank) → Create.
3. Upload these 4 files (`README.md`, `Dockerfile`, `app.py`, `requirements.txt`) — or `git push` them.
4. First build downloads the model (~9 GB, a few minutes). When the Space is "Running", its URL is
   `https://<you>-scribe-burmese-asr.hf.space`.
5. In **Netlify → Environment variables**, set `SCRIBE_ASR_URL` to that URL, then redeploy.
   Scribe routes Burmese transcription to this Space (no Gemini quota); falls back to Gemini if it's down.
