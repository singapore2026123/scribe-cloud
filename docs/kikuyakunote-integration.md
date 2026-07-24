# Sakura: KikuyakuNote + Scribe Cloud Integration Guide

## Overview

Sakura merges KikuyakuNote (multilingual meeting/care-note UI) with Scribe Cloud (domain-specific Burmese/Tamil/Chinese ASR). The combined system gives care workers a production-ready voice-to-record interface with care-tuned speech recognition.

## What each side contributes

### From KikuyakuNote
- PWA frontend: meeting UI, talk mode, history, markdown export
- AudioWorklet mic capture + adaptive VAD
- Multi-engine WebSocket infrastructure (Gemini Live, OpenAI Realtime, Google STT)
- User management, glossary admin, i18n (ja/en/zh UI)
- Token-service backend (Node.js, Cloud Run-ready)

### From Scribe Cloud
- MMS Burmese ASR (74.4% char accuracy on KWSH care speech, int8 quantized)
- kenlm 5-gram character LM (1,823-line corpus, Witten-Bell smoothing)
- 3-tier care phrase snapping: CER -> TF-IDF -> LaBSE
- Confusable-pair disambiguation (prevents clinical あり/なし mis-snaps)
- False-snap prevention: ASR confidence threshold + transcript density guard
- Code-switching detection: auto-fallback to SeamlessM4T English on mixed speech
- Dolphin ASR for Tamil/Chinese
- Gemini -> OpenAI -> Google Translate cascade
- `/stt-compat` endpoint (speaks KikuyakuNote's /stt protocol)

## Integration endpoint

### `wss://<host>/stt-compat`

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

**Additional response fields:**
- `code_switched: true` — when English speech detected through Burmese ASR, auto-switched to SeamlessM4T English

### ASR pipeline per language

| Source | Primary ASR | LM | Snap | Code-switch | Translation |
|--------|------------|-----|------|-------------|-------------|
| my (Burmese) | MMS int8 | kenlm 5-gram (1823 lines) | 3-tier + confusable guard | SeamlessM4T English fallback | Gemini -> OpenAI -> GT |
| ta (Tamil) | Dolphin-small | — | — | — | Google Translate |
| zh (Chinese) | Dolphin-small | — | — | — | Google Translate |

### Snap safety features (Burmese)

| Guard | Trigger | Action |
|-------|---------|--------|
| Confidence threshold | ASR confidence < -1.0 | Skip snap entirely |
| Confidence tightening | ASR confidence < -0.5 | Tighten all tier thresholds |
| Density skip | Audio > 30s, < 0.5 chars/sec | Skip snap entirely |
| Density tightening | Audio > 30s, < 1.5 chars/sec | Tighten all tier thresholds |
| Confusable disambiguation | Best match has near-identical partner with different meaning | Refuse snap, fall through to Gemini |
| Streaming recommendation | Audio > 60s | Return `recommend_streaming: true` |

### Strict mode thresholds (vs normal)

| Tier | Normal (vocab/sentence) | Strict (vocab/sentence) |
|------|------------------------|------------------------|
| CER | 0.33 / 0.45 | 0.20 / 0.30 |
| TF-IDF | 0.72 / 0.58 | 0.82 / 0.70 |
| LaBSE | 0.82 / 0.72 | 0.90 / 0.82 |
| Length ratio | 0.6-1.7 / 0.4-2.5 | 0.7-1.5 / 0.5-2.0 |

## Changes needed in KikuyakuNote

### 1. Scribe Cloud URL config

```js
// services/token-service/index.js
const SCRIBE_CLOUD_URL = process.env.SCRIBE_CLOUD_URL || 'wss://singapore2026123-scribe-burmese-asr.hf.space';
```

### 2. Engine routing for `engine=scribe`

In `handleSttSocket` (or as a new handler), when `engine=scribe`:
- Open a WebSocket to `SCRIBE_CLOUD_URL/stt-compat?sourceLanguageCode=X&targetLanguageCode=Y`
- Pipe client binary frames directly to Scribe Cloud
- Pipe Scribe Cloud JSON responses back to client
- No protocol translation needed — same message shapes

### 3. Language provider codes

```js
const LANGUAGE_PROVIDER_CODES = {
  ja:  { gemini: 'ja',  openai: 'ja',  scribe: null },
  en:  { gemini: 'en',  openai: 'en',  scribe: null },
  zh:  { gemini: 'zh',  openai: 'zh',  scribe: 'zh' },
  my:  { gemini: 'my',  openai: null,  scribe: 'my' },
  hi:  { gemini: 'hi',  openai: 'hi',  scribe: null },
  tl:  { gemini: 'tl',  openai: 'tl',  scribe: null },
  ta:  { gemini: null,  openai: null,  scribe: 'ta' },
  yue: { gemini: 'yue', openai: 'yue', scribe: null }
};
```

### 4. Frontend engine option

```html
<!-- meeting.html -->
<option value="stt-scribe">Scribe Cloud (Care ASR)</option>
```

```js
// app.js connectLive()
if (state.config.engineMode === 'stt-scribe') {
  return connectSttPipeline({ engine: 'scribe' });
}
```

### 5. Auto-routing (recommended)

For Burmese (`my`) source language, auto-prefer Scribe Cloud:
- Better ASR accuracy (MMS 74% vs generic Gemini)
- Care-domain snap (80% exact on blind tests)
- No API cost for snapped phrases
- Clinical safety guards (confusable, confidence, density)

## Architecture

```
Sakura (browser PWA)
  |
  | PCM16 16kHz binary WebSocket
  |
Token Service (Node.js)
  |
  |--- engine=gemini ----> Gemini Live Translate (ja/en/zh/hi/tl/yue)
  |--- engine=openai ----> OpenAI Realtime Translate (ja/en/zh/hi/tl/yue)
  |--- engine=scribe ----> Scribe Cloud /stt-compat (my/ta/zh)
  |                          |
  |                          |--- MMS ASR (Burmese, care-tuned, int8)
  |                          |--- kenlm 5-gram char LM (1823 lines)
  |                          |--- Code-switch detect -> SeamlessM4T English
  |                          |--- 3-tier snap (CER/TF-IDF/LaBSE)
  |                          |--- Confusable-pair disambiguation
  |                          |--- Confidence + density guards
  |                          |--- Dolphin ASR (Tamil, Chinese)
  |                          |--- Gemini/OpenAI/GT translation cascade
  |
  |--- engine=stt -------> Google Cloud Speech (ja/en/zh only)
```

## Blind test results (Scribe Cloud, July 2026)

| Test set | Exact snap | Plausible Gemini | False snap | Unreliable |
|----------|-----------|-----------------|------------|------------|
| Miko recordings (4 blind) | 3/4 (75%) | 0/4 | 0/4 | 0/4 |
| Recordings 17-21 (5 blind) | 1/5 (20%) | 2/5 | 1/5 (now guarded) | 1/5 (English-mixed) |
| rec 63 (natural speech) | — | 1/1 plausible | — | — |

## Future improvements

| Item | Status | Impact |
|------|--------|--------|
| kenlm corpus expansion | Done (917 -> 1823 lines) | Better beam search decoding |
| Code-switching detection | Done | Handles English-mixed speech |
| False-snap guards | Done | Prevents rec-18-type false positives |
| Confusable disambiguation | Done | Clinical safety for similar phrases |
| MMS fine-tuning on KWSH | Pipeline ready, needs labeled data + GPU | Could push char accuracy from 74% to 85%+ |
| KikuyakuNote integration | `/stt-compat` ready | Drop-in engine for KikuyakuNote |
