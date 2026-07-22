# -*- coding: utf-8 -*-
"""Build an MMS fine-tuning dataset from the forced-aligned KWSH Recording 17.
Cuts the recording into per-phrase clips using the alignment timestamps and pairs each with its
VERIFIED reference Burmese (the test-matrix phrase). Output: clips/*.wav + manifest.csv (+ train/val split).

Data status: only Recording 17 has verified reference text (it reads the 60 matrix phrases).
Recordings 18-21 are spontaneous interview speech with NO verified transcript yet -> excluded until
a Burmese/Karen speaker verifies them (see README). This is a small (60-clip) PROOF-OF-PIPELINE set.
"""
import os, io, csv, soundfile as sf, librosa, numpy as np

REC   = r"G:\My Drive\Singapore-PoC\poc-multilingual-voice\Recordings"
WAV   = os.path.join(REC, "New Recording 17.wav")
TSV   = os.path.join(REC, "transcripts", "rec17_perphrase_cer.tsv")
OUT   = os.path.join(REC, "finetune_data")
CLIPS = os.path.join(OUT, "clips")
os.makedirs(CLIPS, exist_ok=True)
PAD = 0.15   # seconds of context padding around each phrase span

y, sr = librosa.load(WAV, sr=16000, mono=True); dur = len(y)/sr
rows = []
for l in io.open(TSV, encoding="utf-8").read().splitlines()[1:]:
    p = l.split("\t")
    if len(p) >= 5:
        rows.append((p[0], float(p[1]), float(p[2]), float(p[3]), p[4].strip()))

manifest = []
for row, a, b, cer, text in rows:
    if not text or b <= a:      # skip phrases with no usable span
        continue
    s = max(0.0, a - PAD); e = min(dur, b + PAD)
    clip = y[int(s*16000):int(e*16000)]
    if len(clip) < 0.4*16000:   # skip <0.4s
        continue
    name = f"rec17_row{row}.wav"
    sf.write(os.path.join(CLIPS, name), clip, 16000, subtype="PCM_16")
    manifest.append({"path": f"clips/{name}", "text": text, "dur": round(len(clip)/16000,2),
                     "align_cer": round(cer,3), "source": "New Recording 17"})

# deterministic train/val split: every 5th clip -> val (no RNG; reproducible)
for i, m in enumerate(manifest):
    m["split"] = "val" if i % 5 == 4 else "train"

with io.open(os.path.join(OUT, "manifest.csv"), "w", encoding="utf-8", newline="") as f:
    w = csv.DictWriter(f, fieldnames=["path","text","dur","align_cer","source","split"])
    w.writeheader(); w.writerows(manifest)

ntr = sum(1 for m in manifest if m["split"]=="train"); nva = len(manifest)-ntr
tot = sum(m["dur"] for m in manifest)
print(f"clips: {len(manifest)}  (train {ntr} / val {nva})   total audio {tot:.0f}s")
print(f"manifest -> {os.path.join(OUT,'manifest.csv')}")
print(f"clips    -> {CLIPS}")
print("NOTE: 60-clip proof-of-pipeline set. Add verified recs 18-21 + more sessions to actually move accuracy.")
