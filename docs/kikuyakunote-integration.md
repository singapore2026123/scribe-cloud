# KikuyakuNote + Scribe Cloud Integration Guide

## Overview

Scribe Cloud exposes `/stt-compat` — a WebSocket endpoint that speaks KikuyakuNote's `/stt` protocol. KikuyakuNote can route Burmese/Tamil/Chinese audio to Scribe Cloud instead of Google Cloud Speech, getting domain-specific care ASR + snap-verified translations.

## What Scribe Cloud provides (already implemented)

### Endpoint: `wss://<scribe-cloud-host>/stt-compat`

**Query params:**
- `sourceLanguageCode` — `my` (Burmese), `ta` (Tamil), `zh` (Chinese)
- `targetLanguageCode` — `ja`, `en`, etc.

**Protocol (identical to KikuyakuNote /stt):**

```
Client                          Server
  |--- [connect] ------------------>|
  |<-- {type:"setupComplete"} ------|
  |--- binary PCM16LE 16kHz ------->|  (continuous audio chunks)
  |<-- {type:"transcript",          |
  |     source:"...",               |  (interim, isFinal:false)
  |     translation:"",            |
  |     isFinal:false, seq:1} -----|
  |--- binary PCM16LE 16kHz ------->|
  |<-- {type:"transcript",          |
  |     source:"...",               |  (final, with translation)
  |     translation:"...",         |
  |     isFinal:true, seq:2} ------|
  |--- "end" or {type:"end"} ------>|
  |<-- {type:"speech_end"} ---------|
```

**ASR pipeline per language:**
| Source | Primary ASR | Snap | Translation cascade |
|--------|------------|------|---------------------|
| my (Burmese) | MMS int8 + kenlm beam | Yes (care_phrases.json) | Gemini -> OpenAI -> Google Translate |
| ta (Tamil) | Dolphin-small | No | Google Translate |
| zh (Chinese) | Dolphin-small | No | Google Translate |

**Snap features (Burmese only):**
- 3-tier matching: CER -> TF-IDF -> LaBSE
- Confusable-pair disambiguation (prevents clinical mis-snaps)
- Confidence threshold (skips snap on unreliable ASR)
- Density guard (skips snap on sparse transcripts from long speech)

## What KikuyakuNote needs to change

### 1. Add Scribe Cloud URL to config

In `services/token-service/index.js`, add an env var for the Scribe Cloud endpoint:

```js
const SCRIBE_CLOUD_URL = process.env.SCRIBE_CLOUD_URL || 'wss://singapore2026123-scribe-burmese-asr.hf.space';
```

### 2. Add `engine=scribe` routing in WebSocket handler

In `handleSttSocket` (or as a new handler), when `engine=scribe`:
- Open a WebSocket to `SCRIBE_CLOUD_URL/stt-compat?sourceLanguageCode=X&targetLanguageCode=Y`
- Pipe client binary frames directly to Scribe Cloud
- Pipe Scribe Cloud JSON responses back to client
- No protocol translation needed — same message shapes

### 3. Register in LANGUAGE_PROVIDER_CODES

```js
const LANGUAGE_PROVIDER_CODES = {
  ja:  { gemini: 'ja',  openai: 'ja',  scribe: null },
  en:  { gemini: 'en',  openai: 'en',  scribe: null },
  zh:  { gemini: 'zh',  openai: 'zh',  scribe: 'zh' },
  my:  { gemini: 'my',  openai: null,  scribe: 'my' },  // Scribe is best for Burmese
  hi:  { gemini: 'hi',  openai: 'hi',  scribe: null },
  tl:  { gemini: 'tl',  openai: 'tl',  scribe: null },
  ta:  { gemini: null,  openai: null,  scribe: 'ta' },  // new: Tamil via Scribe
  yue: { gemini: 'yue', openai: 'yue', scribe: null }
};
```

### 4. Add engine option to frontend

In `meeting.html`, add Scribe Cloud as an engine choice:

```html
<option value="stt-scribe">Scribe Cloud (Care ASR)</option>
```

In `app.js` `connectLive()`, route `engineMode === 'stt-scribe'` to `connectSttPipeline()` with `engine=scribe` query param.

### 5. Auto-routing (optional)

For Burmese (`my`) source language, automatically prefer Scribe Cloud over Gemini Live when available, since Scribe Cloud has:
- Better Burmese ASR accuracy (MMS 74% vs generic)
- Care-domain snap matching (80% exact on blind tests)
- No per-session API cost for snapped phrases

## Architecture after integration

```
KikuyakuNote (browser)
  |
  | PCM16 16kHz binary WebSocket
  |
KikuyakuNote token-service
  |
  |--- engine=gemini ---> Gemini Live Translate (ja/en/zh/hi/tl/yue)
  |--- engine=openai ---> OpenAI Realtime (ja/en/zh/hi/tl/yue)
  |--- engine=scribe ---> Scribe Cloud /stt-compat (my/ta/zh)
  |                          |
  |                          |--- MMS ASR (Burmese, care-tuned)
  |                          |--- Dolphin ASR (Tamil, Chinese)
  |                          |--- Snap matching (care_phrases.json)
  |                          |--- Gemini/OpenAI/GT translation cascade
  |
  |--- engine=stt -----> Google Cloud Speech (ja/en/zh only)
```
