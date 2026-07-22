# -*- coding: utf-8 -*-
"""Synthetic data augmentation via MMS-TTS (facebook/mms-tts-mya).

⚠️ VERIFIED DEAD END FOR NUMBERS (2026-07-20): mms-tts-mya has NO Burmese numerals (၀-၉) in its
vocab, and the VitsTokenizer SILENTLY STRIPS them ("… ၃၆.၆ ဒီဂရီ" -> "… ဒီဂရီ"). So synthetic vitals
clips contain the WORDS but NO number audio, while their text labels DO have the numbers -> training on
them teaches the model to HALLUCINATE numbers from silence. Do NOT use TTS clips that contain digits.
The numbers weak spot needs REAL human recordings (people actually say the numbers). This script is kept
for reference / possible number-free prose augmentation only; its output was quarantined, not trained on.

Speaks each line of phrases.txt in Burmese -> clip, pairs it with that same (known) Burmese text,
and appends to the training manifest as source="tts". Targets the number/vitals weak spot: unlimited
number-drill audio without human recording.

HONEST LIMITS: single synthetic voice, TTS != real speech (domain gap). Use as a SUPPLEMENT that
bootstraps number/vocab coverage, mixed with real scripted recordings. All TTS clips go to the TRAIN
split only -> evaluation stays on REAL held-out audio. Per-clip speaking_rate/noise variation adds a
little acoustic diversity. No new installs (mms-tts-mya is is_uroman=False -> Burmese text goes in directly).
"""
import os, io, csv, torch, numpy as np, soundfile as sf, librosa
from transformers import VitsModel, VitsTokenizer, set_seed

REC   = r"G:\My Drive\Singapore-PoC\poc-multilingual-voice\Recordings"
DATA  = os.path.join(REC, "finetune_data"); CLIPS = os.path.join(DATA, "clips")
PHR   = os.path.join(os.path.dirname(__file__), "phrases.txt")
os.makedirs(CLIPS, exist_ok=True)

phrases = [l.strip() for l in io.open(PHR, encoding="utf-8").read().splitlines() if l.strip()]
print(f"phrases to synthesize: {len(phrases)}", flush=True)

tok   = VitsTokenizer.from_pretrained("facebook/mms-tts-mya")
model = VitsModel.from_pretrained("facebook/mms-tts-mya"); model.eval()
SR = model.config.sampling_rate
print(f"mms-tts-mya loaded; sampling_rate={SR}", flush=True)

# deterministic per-clip acoustic variation (no RNG dependence beyond fixed seeds)
RATES  = [0.9, 1.0, 1.1, 1.05, 0.95, 1.15]
NOISES = [0.6, 0.667, 0.7, 0.75, 0.8]

made = []
for i, text in enumerate(phrases):
    set_seed(1000 + i)                       # reproducible
    model.speaking_rate = RATES[i % len(RATES)]
    model.noise_scale   = NOISES[(i*3) % len(NOISES)]
    inputs = tok(text=text, return_tensors="pt")
    with torch.no_grad():
        wav = model(**inputs).waveform[0].cpu().numpy().astype(np.float32)
    if SR != 16000:
        wav = librosa.resample(wav, orig_sr=SR, target_sr=16000)
    name = f"tts_{i:03d}.wav"
    sf.write(os.path.join(CLIPS, name), wav, 16000, subtype="PCM_16")
    made.append({"path": f"clips/{name}", "text": text, "dur": round(len(wav)/16000,2),
                 "align_cer": 0.0, "source": "tts", "split": "train"})   # synthetic -> TRAIN only
    if (i+1) % 20 == 0: print(f"  {i+1}/{len(phrases)}", flush=True)

# append to manifest (skip paths already present)
mpath = os.path.join(DATA, "manifest.csv")
rows = list(csv.DictReader(io.open(mpath, encoding="utf-8"))) if os.path.exists(mpath) else []
have = {r["path"] for r in rows}
added = [m for m in made if m["path"] not in have]
rows += added
with io.open(mpath, "w", encoding="utf-8", newline="") as f:
    w = csv.DictWriter(f, fieldnames=["path","text","dur","align_cer","source","split"])
    w.writeheader(); w.writerows(rows)

real = sum(1 for r in rows if r["source"]!="tts"); tts = sum(1 for r in rows if r["source"]=="tts")
print(f"\nadded {len(added)} TTS clips ({sum(m['dur'] for m in made):.0f}s).")
print(f"manifest now: {len(rows)} rows  (real {real} / tts {tts})")
print("all TTS clips -> split=train; eval stays on real held-out val clips.")
