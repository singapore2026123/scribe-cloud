# -*- coding: utf-8 -*-
"""Fine-tune the MMS Burmese ('mya') ADAPTER on the KWSH care-speech clips.
MMS is designed for adapter fine-tuning: the 1B base stays frozen, only the small per-language adapter
(+ CTC head) trains -> cheap, and you can ship just the adapter. Self-contained: torch + transformers only.

Usage (env vars):
  MAX_STEPS=2   -> smoke test (a couple of steps, verifies loss/backprop) then exit
  EPOCHS=10     -> full run (needs a GPU or a lot of CPU time for the 1B base)
  LR=1e-4
Output: <finetune_data>/mms_mya_finetuned/  (fine-tuned model + adapter).
"""
import os, io, csv, time, math
import numpy as np, soundfile as sf, librosa, torch
from transformers import Wav2Vec2ForCTC, AutoProcessor

DATA = os.environ.get("FT_DATA", r"G:\My Drive\Singapore-PoC\poc-multilingual-voice\Recordings\finetune_data")
OUT  = os.path.join(DATA, "mms_mya_finetuned")
EPOCHS   = int(os.environ.get("EPOCHS", "10"))
LR       = float(os.environ.get("LR", "1e-4"))
MAX_STEPS= int(os.environ.get("MAX_STEPS", "0"))   # >0 => smoke test
os.makedirs(OUT, exist_ok=True)

# ---- data ----
def load_manifest(split):
    rows=[]
    for r in csv.DictReader(io.open(os.path.join(DATA,"manifest.csv"),encoding="utf-8")):
        if r["split"]==split: rows.append(r)
    return rows
train = load_manifest("train")
print(f"train clips: {len(train)}", flush=True)

# ---- model: load mya adapter, freeze base, train adapter only ----
print("loading MMS...", flush=True); t0=time.time()
proc  = AutoProcessor.from_pretrained("facebook/mms-1b-all")
model = Wav2Vec2ForCTC.from_pretrained("facebook/mms-1b-all", ignore_mismatched_sizes=True)
proc.tokenizer.set_target_lang("mya")
model.load_adapter("mya")
model.freeze_base_model()                      # freeze feature-encoder + transformer; keep adapter + lm_head trainable
trainable=[]
try:
    for n,p in model._get_adapters().items():  # HF MMS helper: the adapter weights
        p.requires_grad=True; trainable.append(n)
except Exception:
    for n,p in model.named_parameters():
        if "adapter" in n or "lm_head" in n:
            p.requires_grad=True; trainable.append(n)
ntrain=sum(p.numel() for p in model.parameters() if p.requires_grad)
print(f"  loaded {time.time()-t0:.0f}s; trainable params={ntrain:,} ({len(trainable)} tensors)", flush=True)

opt=torch.optim.AdamW([p for p in model.parameters() if p.requires_grad], lr=LR)
model.train()

def clip_audio(relpath):
    y,_=librosa.load(os.path.join(DATA,relpath), sr=16000, mono=True)
    return y.astype(np.float32)

step=0; t0=time.time()
for ep in range(EPOCHS):
    tot=0.0
    for m in train:
        audio=clip_audio(m["path"])
        inp=proc(audio, sampling_rate=16000, return_tensors="pt")
        ids=proc.tokenizer(m["text"]).input_ids   # tokenize target text with the mya CTC vocab
        labels=torch.tensor([ids])
        out=model(input_values=inp.input_values, attention_mask=inp.get("attention_mask"), labels=labels)
        loss=out.loss
        loss.backward(); opt.step(); opt.zero_grad()
        lv=float(loss.detach()); tot+=lv; step+=1
        if MAX_STEPS and step>=MAX_STEPS:
            print(f"[smoke] step {step} loss={lv:.3f}  ({time.time()-t0:.0f}s) -> OK, backprop works", flush=True)
            break
    else:
        print(f"epoch {ep+1}/{EPOCHS}  avg loss={tot/max(1,len(train)):.3f}  ({time.time()-t0:.0f}s)", flush=True)
        continue
    break

if not MAX_STEPS:
    model.save_pretrained(OUT); proc.save_pretrained(OUT)
    print("saved fine-tuned model ->", OUT, flush=True)
else:
    print("smoke test done (model NOT saved). Set MAX_STEPS=0 + EPOCHS to train for real.", flush=True)
