# Scribe Cloud

Cloud rebuild of Scribe — a multilingual care-record transcription/translation web app.
**GitHub** (source) → **Netlify** (web app + serverless API) → **Supabase** (auth, Postgres, storage),
with **Gemini** as the cloud transcription/translation/notes engine.

> Note: this cloud version uses **browser mic capture** + **cloud ASR**. It does *not* have the desktop
> app's system-audio loopback or offline local models (Dolphin/SeamlessM4T) — those can't run on Netlify.

## Architecture
- `public/` — static web app (UI + `app.js`). Served by Netlify.
- `netlify/functions/` — serverless API; the **Gemini key lives here only**, never in the browser.
  - `config` → returns public Supabase URL/anon key to the browser
  - `transcribe` → audio (base64 WAV) → Gemini → `{transcript, translation}` (Burmese + record mode)
  - `translate` → text → Gemini translation (live Web Speech results)
  - `notes` → transcript → Gemini meeting notes
- `supabase/schema.sql` — tables (`sessions`, `lines`) + RLS + `recordings` storage bucket.
- Live transcription for JA/ZH/MS/EN/TA uses the browser **Web Speech API** (free). Burmese → use **Record mode** (Gemini).

## Setup (one-time)

### 1. Supabase
1. Create a project at supabase.com (you have an account).
2. **SQL Editor** → paste & run `supabase/schema.sql`.
3. **Project Settings → API**: copy the **Project URL** and the **anon public** key.
4. **Authentication → URL Configuration**: add your Netlify site URL (and `http://localhost:8888`) to redirect URLs.

### 2. GitHub
Push this folder to a new GitHub repo (see commands below).

### 3. Netlify
1. **Add new site → Import from Git** → pick the GitHub repo.
2. Build settings: no build command; **publish directory = `public`**; functions are auto-detected in `netlify/functions`.
3. **Site settings → Environment variables** — add:
   - `GEMINI_API_KEY` = your Gemini key  *(server-side only)*
   - `GEMINI_MODEL` = `gemini-2.0-flash`
   - `SUPABASE_URL` = your Supabase project URL
   - `SUPABASE_ANON_KEY` = your Supabase anon public key
4. Deploy. Open the site, sign in with the magic link, and start.

## Push to GitHub
```powershell
# from this folder
git init
git add -A
git commit -m "Scribe Cloud: initial scaffold (Netlify + Supabase + Gemini)"
git branch -M main
git remote add origin https://github.com/<you>/scribe-cloud.git
git push -u origin main
```

## Local dev (optional)
```powershell
npm i -g netlify-cli
netlify dev   # serves public/ + functions, with env from a local .env (copy .env.example)
```

## Roadmap / not yet wired
- ElevenLabs Scribe as an alternative Burmese ASR (swap inside `transcribe.js`).
- Speaker diarization (the desktop sherpa-onnx path is local-only; cloud would need a diarization API).
- Tab/system-audio capture via `getDisplayMedia({audio:true})`.
