# Scribe Cloud

Multilingual care-record transcription & translation web app (Singapore healthcare PoC).
Languages: English, Japanese, Chinese, Malay, Tamil, Burmese.

**GitHub** (source) → **Cloudflare Worker** (web app + API + Workers AI) → **Supabase** (auth, Postgres)
→ **Hugging Face Space** (Dolphin ASR for Burmese/Tamil/Chinese). Translation via **Google Translate** (free)
with an LLM / m2m100 fallback. *(No Gemini, no Netlify — both removed.)*

## Architecture

- **`public/`** — static web app (`index.html`, `app.js`, `config.json`). Served by the Cloudflare Worker.
- **`worker.js`** — the Cloudflare Worker: serves the site **and** the API (Workers AI). Endpoints:
  - `POST /transcribe` — `{audio(base64 WAV), src, target}` → `{transcript, translation}`. Whisper (`@cf/openai/whisper-large-v3-turbo`) + glossary correction + hallucination filter + translation. Handles **EN / JA / MS** (the non-Dolphin languages).
  - `POST /translate` — `{text, sl, tl, llm}` → `{translation}`. Google Translate; the **LLM** (Llama) when `llm:true`; `@cf/meta/m2m100-1.2b` fallback.
  - `POST /notes` — `{transcript, target}` → `{notes}`. Meeting notes via `@cf/meta/llama-3.1-8b-instruct-fast` (headings in the target language).
  - `DELETE /account` — deletes the signed-in user + their data (needs the `SUPABASE_SERVICE_ROLE` Cloudflare secret).
- **`hf-space/`** — Hugging Face Space (FastAPI, `app.py`): **Dolphin** ASR (+ SeamlessM4T fallback) for **Burmese (my) / Tamil (ta) / Chinese (zh)**. Called directly from the browser. Includes an English-sentence filter for Tamil/Burmese and Burmese term-snapping.
- **`glossary/`** — per-language care/medical/everyday glossaries (CSV) + the 6-language care-terms table.
- **`supabase/schema.sql`** — tables (`documents`, `folders`) + row-level security (`auth.uid() = user_id`).
- **`wrangler.jsonc`** — Worker config (ASSETS + AI bindings; public Supabase URL/anon key as vars).

**Language routing:** Burmese / Tamil / Chinese → HF Space (Dolphin); English / Japanese / Malay + others → Cloudflare Worker (Whisper). Translation, notes, and account actions always go to the Worker.

## Stack

- **Cloudflare Worker + Workers AI** — `whisper-large-v3-turbo` (ASR), `llama-3.1-8b-instruct-fast` (notes + LLM translation), `m2m100-1.2b` (translation fallback). No separate API keys.
- **Google Translate** — free public endpoint, no key.
- **Hugging Face Space** — `dataoceanai-dolphin` + `facebook/seamless-m4t-v2-large`.
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
1. The Space runs `hf-space/`. **It is NOT linked to GitHub** — to update, upload `app.py` (and `Dockerfile` if deps change) manually.
2. Put the Space URL in `public/config.json` (`asrUrl`).

## Deploy
- **Push to `main` → Cloudflare auto-builds/deploys** the Worker + site.
- **Hugging Face Space** — manual upload of `hf-space/` files (not part of the GitHub auto-deploy).

## `public/config.json`
```json
{ "supabaseUrl": "…", "supabaseAnonKey": "…", "asrUrl": "https://…hf.space" }
```

## Status & roadmap
- Free-tier accuracy: **English/Japanese** are usable; **Chinese/Malay/Tamil/Burmese** need paid ASR for production.
- Production direction (paid): **Google Cloud STT (Chirp 2, streaming) + speech adaptation (glossaries) + LLM translation** — see the "Recommended Production Stack" doc.
- Goal: develop and merge into the kanamic cloud care-records service.
