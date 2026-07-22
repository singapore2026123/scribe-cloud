# -*- coding: utf-8 -*-
"""Evaluate an MMS model on the held-out in-domain clips (manifest split=val).
Reports overall char CER + digit CER, so you can compare BASE vs FINE-TUNED.

  python eval_mms.py                 # evaluate the base facebook/mms-1b-all (mya)
  python eval_mms.py --model <dir>   # evaluate a fine-tuned checkpoint (from train_mms.py)
  python eval_mms.py --split train   # (sanity: should be ~0 CER after enough fine-tuning = overfit check)

Note: keep an eye on SLR80 (eval/slr80_eval.py) too — if fine-tuning helps in-domain but WORSENS SLR80,
that's domain over-fit. A good result improves in-domain without wrecking general Burmese.
"""
import os, io, csv, re, argparse, unicodedata
import numpy as np, librosa, torch
from transformers import Wav2Vec2ForCTC, AutoProcessor

DATA=os.environ.get("FT_DATA", r"G:\My Drive\Singapore-PoC\poc-multilingual-voice\Recordings\finetune_data")
MYRE=re.compile(r'[က-႟]'); BUR2ASCII={0x1040+k:ord(str(k)) for k in range(10)}
def canon(s):
    s=unicodedata.normalize("NFC",s).translate(BUR2ASCII)
    return "".join(c for c in s if (0x1000<=ord(c)<=0x103F) or c.isdigit())
def digits(s): return "".join(c for c in canon(s) if c.isdigit())
def cer(ref,hyp):
    n,m=len(ref),len(hyp)
    if n==0: return 0.0
    prev=list(range(m+1))
    for i in range(1,n+1):
        cur=[i]+[0]*m; rc=ref[i-1]
        for j in range(1,m+1): cur[j]=min(prev[j]+1,cur[j-1]+1,prev[j-1]+(0 if rc==hyp[j-1] else 1))
        prev=cur
    return prev[m]/n

def main():
    ap=argparse.ArgumentParser()
    ap.add_argument("--model", default="facebook/mms-1b-all")
    ap.add_argument("--split", default="val")
    a=ap.parse_args()
    rows=[r for r in csv.DictReader(io.open(os.path.join(DATA,"manifest.csv"),encoding="utf-8")) if r["split"]==a.split]
    print(f"eval model={a.model}  split={a.split}  clips={len(rows)}", flush=True)
    proc=AutoProcessor.from_pretrained(a.model)
    model=Wav2Vec2ForCTC.from_pretrained(a.model)
    try: proc.tokenizer.set_target_lang("mya"); model.load_adapter("mya")
    except Exception: pass   # a fine-tuned checkpoint already has mya wired in
    model.eval()
    cc=[]; dd=[]; rc_tot=hc_tot=rd_tot=hd_tot=0
    for r in rows:
        y,_=librosa.load(os.path.join(DATA,r["path"]), sr=16000, mono=True)
        inp=proc(y.astype(np.float32), sampling_rate=16000, return_tensors="pt")
        with torch.no_grad(): lg=model(**inp).logits
        hyp=proc.decode(torch.argmax(lg,dim=-1)[0]).strip()
        rC,hC=canon(r["text"]),canon(hyp); rD,hD=digits(r["text"]),digits(hyp)
        cc.append(cer(rC,hC)); dd.append(cer(rD,hD) if rD else None)
    ch=[x for x in cc]; dg=[x for x in dd if x is not None]
    print(f"\noverall char CER: mean {sum(ch)/len(ch)*100:.1f}%  median {sorted(ch)[len(ch)//2]*100:.1f}%")
    if dg: print(f"digit CER       : mean {sum(dg)/len(dg)*100:.1f}%  ({len(dg)} clips with digits)")
    print(f"char accuracy   : {100-sum(ch)/len(ch)*100:.1f}%")

if __name__=="__main__": main()
