# Scribe Cloud

Multilingual care-record transcription & translation web app (Singapore healthcare PoC).
Languages: English, Japanese, Chinese, Malay, Tamil, Burmese.

**GitHub** (source) → **Cloudflare Worker** (web app + API + Workers AI) → **Supabase** (auth, Postgres)
→ **Hugging Face Space** (MMS primary for Burmese, Dolphin/SeamlessM4T fallback for Tamil/Chinese).
Translation via **Google Translate** (free), with **Gemini** → **OpenAI** → Google cascade for Burmese.

## Architecture

- **`public/`** — static web app (`index.html`, `app.js`, `caretalk.html`, `config.json`). Served by the Cloudflare Worker.
- **`worker.js`** — the Cloudflare Worker: serves the site **and** the API (Workers AI). Endpoints:
  - `POST /transcribe` — `{audio(base64 WAV), src, target}` → `{transcript, translation}`. Whisper (`@cf/openai/whisper-large-v3-turbo`) + glossary correction + hallucination filter + translation. Handles **EN / JA / MS** (the non-Space languages).
  - `POST /translate` — `{text, sl, tl, llm}` → `{translation}`. Google Translate; the **LLM** (Llama) when `llm:true`; `@cf/meta/m2m100-1.2b` fallback.
  - `POST /notes` — `{transcript, target}` → `{notes}`. Meeting notes via `@cf/meta/llama-3.1-8b-instruct-fast`.
  - `DELETE /account` — deletes the signed-in user + their data (needs the `SUPABASE_SERVICE_ROLE` Cloudflare secret).
- **`hf-space/`** — Hugging Face Space (FastAPI, `app.py`):
  - **MMS** (`facebook/mms-1b-all` + `mya` adapter) — primary Burmese ASR, int8 quantized (2.2x CPU speedup, lossless). Optional char n-gram LM with CTC beam search.
  - **Dolphin** / **SeamlessM4T** fallback for Tamil (ta) / Chinese (zh).
  - **Tiered closed-vocab snapping** for Burmese: garbled/paraphrased ASR → nearest known care phrase → verified translation. Three tiers: char-CER (exact/garbled) → char-ngram TF-IDF cosine (reordering) → LaBSE embeddings (semantic/paraphrase). 887 candidates from care_phrases.json (60 verified matrix sentences) + care_vocab.json (827 app-vocabulary terms, Zawgyi→Unicode converted).
  - **Translation cascade** for Burmese (when snapping misses): Gemini (`GEMINI_API_KEY`) → OpenAI (`OPENAI_API_KEY`) → Google Translate. Each tier is off until its key is set.
  - **Streaming** WebSocket `/stream`: real-time Burmese ASR with energy-VAD segmentation, partial + final messages.
  - `POST /transcribe` — batch ASR for all Space languages.
  - English-sentence filter for Tamil/Burmese and Burmese postprocessing (Unicode normalization, numeral conversion, glossary, spoken-symbol expansion).
- **`glossary/`** — per-language care/medical/everyday glossaries (CSV) + the 6-language care-terms table.
- **`tools/`** — Zawgyi→Unicode converter (Rabbit zg2uni rules), care-vocab extraction scripts.
- **`finetune/`** — MMS fine-tuning scaffold (dataset builder, trainer, evaluator).
- **`supabase/schema.sql`** — tables (`documents`, `folders`) + row-level security (`auth.uid() = user_id`).
- **`wrangler.jsonc`** — Worker config (ASSETS + AI bindings; public Supabase URL/anon key as vars).

**Language routing:** Burmese / Tamil / Chinese → HF Space; English / Japanese / Malay + others → Cloudflare Worker (Whisper). Translation, notes, and account actions always go to the Worker.

## Stack

- **Cloudflare Worker + Workers AI** — `whisper-large-v3-turbo` (ASR), `llama-3.1-8b-instruct-fast` (notes + LLM translation), `m2m100-1.2b` (translation fallback). No separate API keys.
- **Google Translate** — free public endpoint, no key.
- **Hugging Face Space** — `facebook/mms-1b-all` (Burmese primary, int8 quantized), `dataoceanai-dolphin` + `facebook/seamless-m4t-v2-large` (fallback). `scikit-learn` (TF-IDF snapping), `sentence-transformers` (LaBSE semantic snapping).
- **Gemini / OpenAI** — optional LLM translation for Burmese (reads through ASR noise). Requires API keys.
- **Supabase** — email/password auth + Postgres.

## Live

- Web app + API: `https://scribe-cloud.singapore2026123.workers.dev`
- ASR Space: `https://singapore2026123-scribe-burmese-asr.hf.space`

## Setup (one-time)

### 1. Supabase
1. Create a project, run `supabase/schema.sql` in the SQL Editor.
2. Copy the **Project URL** + **anon public** key into `public/config.json` (`supabaseUrl`, `supabaseAnonKey`).

### 2. Cloudflare Worker
1. Deploy the Worker from this repo (`wrangler.jsonc` defines it: `assets` = `public/`, `ai` binding). Connect the GitHub repo for auto-deploy, or `npx wrangler deploy`.
2. Set the secret (for `DELETE /account`): `npx wrangler secret put SUPABASE_SERVICE_ROLE` (paste the Supabase service_role key). `SUPABASE_URL` + `SUPABASE_ANON_KEY` are in `wrangler.jsonc` `vars`.

### 3. Hugging Face Space (Burmese/Tamil/Chinese ASR)
1. The Space runs `hf-space/`. **It is NOT linked to GitHub** — to update, upload files manually.
2. Put the Space URL in `public/config.json` (`asrUrl`).
3. Optional env vars (Space Settings → Variables and secrets):
   - `GEMINI_API_KEY` — enables Gemini translation for unmatched Burmese phrases.
   - `OPENAI_API_KEY` — enables OpenAI fallback (used when Gemini key is not set).
   - `SCRIBE_MY_SNAP` — `1` (default) enables tiered snapping; `0` disables.
   - `SCRIBE_MY_SEMANTIC` — `1` (default) enables LaBSE semantic tier; `0` disables (faster cold-start).
   - `SCRIBE_MY_QUANT` — `1` (default) enables int8 quantization for MMS.
   - `SCRIBE_MY_LM` — `1` enables char n-gram LM decoding (slow on CPU; off by default).

## Deploy
- **Push to `main` → Cloudflare auto-builds/deploys** the Worker + site.
- **Hugging Face Space** — manual upload of `hf-space/` files (not part of the GitHub auto-deploy).

## `public/config.json`
```json
{ "supabaseUrl": "…", "supabaseAnonKey": "…", "asrUrl": "https://…hf.space" }
```

## Status & roadmap
- MMS achieves 74.4% phrase accuracy / 51.4% word accuracy on Burmese (vs Dolphin 56.1/37.1). Tiered snapping + LLM translation covers the translation quality gap.
- Free-tier accuracy: **English/Japanese** are usable; **Chinese/Malay/Tamil** need paid ASR for production.
- Burmese fine-tuning scaffold ready; more speaker diversity needed (2-speaker experiment was flat).
- Production direction (paid): **Google Cloud STT (Chirp 2, streaming) + speech adaptation (glossaries) + LLM translation** — see the "Recommended Production Stack" doc.
- Goal: develop and merge into the kanamic cloud care-records service.
