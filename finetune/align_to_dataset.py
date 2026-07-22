# -*- coding: utf-8 -*-
"""MASS-PRODUCE MMS training data by forced alignment.
Given (audio, an ordered list of reference phrases it contains), align the phrases to the audio via
the MMS CTC path + DP, cut one clip per phrase, and append (clip, verified-text) rows to the manifest.

This is the scalable data factory: any transcribed KWSH recording -> many aligned training clips, no
manual per-clip cutting. Feed it:
  * a matrix reading (reference = the 60 matrix phrases), OR
  * any care recording whose transcript a Burmese/Karen speaker has verified (e.g. corrected MMS output
    in Praat -> export the interval texts as the phrase list).

CLI:  python align_to_dataset.py --wav "New Recording 17.wav" --phrases matrix   [--source rec17]
      python align_to_dataset.py --wav "<file>.wav" --phrases <phrases.txt>       # one phrase per line, in order
Reuses the exact alignment logic proven on Recording 17.
"""
import os, io, re, csv, sys, time, argparse, unicodedata
import numpy as np, soundfile as sf, librosa, torch
from transformers import Wav2Vec2ForCTC, AutoProcessor

REC  = r"G:\My Drive\Singapore-PoC\poc-multilingual-voice\Recordings"
DATA = os.path.join(REC, "finetune_data"); CLIPS = os.path.join(DATA, "clips")
REFP = os.path.join(REC, "transcripts", "REFERENCE_burmese_from_matrix.txt")
MYRE = re.compile(r'[က-႟]')
def my_only(s): return "".join(c for c in unicodedata.normalize("NFC", s) if MYRE.match(c))

def load_matrix_phrases():
    out=[]
    for l in io.open(REFP, encoding="utf-8").read().splitlines():
        if "]" in l: out.append(l.split("]",1)[1].split("\t")[0].strip())
    return out

_MODEL={}
def mms():
    if not _MODEL:
        proc=AutoProcessor.from_pretrained("facebook/mms-1b-all")
        model=Wav2Vec2ForCTC.from_pretrained("facebook/mms-1b-all")
        proc.tokenizer.set_target_lang("mya"); model.load_adapter("mya"); model.eval()
        _MODEL["p"]=proc; _MODEL["m"]=model; _MODEL["pad"]=proc.tokenizer.pad_token_id
    return _MODEL["p"], _MODEL["m"], _MODEL["pad"]

def char_timestamps(y, win=20):
    proc,model,pad=mms(); ch=[]; ts=[]
    for i in range(0, len(y), win*16000):
        c=y[i:i+win*16000]
        if len(c)<1600: continue
        inp=proc(c, sampling_rate=16000, return_tensors="pt")
        with torch.no_grad(): lg=model(**inp).logits[0]
        ids=torch.argmax(lg,dim=-1).tolist(); T=len(ids); fd=(len(c)/16000)/T; base=i/16000; prev=None
        for t,idv in enumerate(ids):
            if idv==prev: continue
            prev=idv
            if idv==pad: continue
            tok=proc.tokenizer.convert_ids_to_tokens(idv)
            if tok and MYRE.match(tok): ch.append(tok); ts.append(base+t*fd)
    return "".join(ch), ts

def align(y, phrases):
    """DP-align the concatenated reference to the MMS hyp char stream; return per-phrase (start,end,cer,text)."""
    hyp, ht = char_timestamps(y)
    ref=""; bounds=[]
    for txt in phrases:
        mo=my_only(txt); s=len(ref); ref+=mo; bounds.append((s,len(ref),txt,mo))
    n,m=len(ref),len(hyp); bp=bytearray((n+1)*(m+1)); prev=list(range(m+1))
    for j in range(m+1): bp[j]=2
    for i in range(1,n+1):
        cur=[i]+[0]*m; rc=ref[i-1]; off=i*(m+1); bp[off]=1; pj=prev
        for j in range(1,m+1):
            d=pj[j-1]+(0 if rc==hyp[j-1] else 1); up=pj[j]+1; lf=cur[j-1]+1
            if d<=up and d<=lf: cur[j]=d; bp[off+j]=0
            elif up<=lf: cur[j]=up; bp[off+j]=1
            else: cur[j]=lf; bp[off+j]=2
        prev=cur
    ref2hyp=[-1]*n; i,j=n,m
    while i>0 or j>0:
        b=bp[i*(m+1)+j]
        if i>0 and b==1: ref2hyp[i-1]=j-1 if j>0 else 0; i-=1
        elif j>0 and b==2: j-=1
        else: ref2hyp[i-1]=j-1; i-=1; j-=1
    for k in range(n):
        if ref2hyp[k]<0: ref2hyp[k]=ref2hyp[k-1] if k>0 else 0
    def ed(a,b):
        na,nb=len(a),len(b)
        if na==0: return nb
        pr=list(range(nb+1))
        for x in range(1,na+1):
            cu=[x]+[0]*nb
            for yy in range(1,nb+1): cu[yy]=min(pr[yy]+1,cu[yy-1]+1,pr[yy-1]+(0 if a[x-1]==b[yy-1] else 1))
            pr=cu
        return pr[nb]
    res=[]; pend=0.0
    for s,e,txt,mo in bounds:
        js=[ref2hyp[k] for k in range(s,e) if 0<=ref2hyp[k]<len(ht)]
        if js: a=ht[min(js)]; b=ht[max(js)]; hs=hyp[min(js):max(js)+1]
        else: a=pend; b=pend; hs=""
        if b<a: b=a
        res.append((a,b,ed(mo,hs)/max(1,len(mo)),txt)); pend=b
    return res

def append_clips(y, dur, aligned, source, pad=0.15):
    os.makedirs(CLIPS, exist_ok=True)
    mpath=os.path.join(DATA,"manifest.csv"); rows=[]
    if os.path.exists(mpath):
        rows=list(csv.DictReader(io.open(mpath,encoding="utf-8")))
    have={r["path"] for r in rows}; added=0
    for k,(a,b,cer,txt) in enumerate(aligned):
        if not txt or b<=a: continue
        s=max(0.0,a-pad); e=min(dur,b+pad); clip=y[int(s*16000):int(e*16000)]
        if len(clip)<0.4*16000: continue
        name=f"{source}_seg{k:03d}.wav"; rp=f"clips/{name}"
        if rp in have: continue
        sf.write(os.path.join(CLIPS,name), clip, 16000, subtype="PCM_16")
        rows.append({"path":rp,"text":txt,"dur":round(len(clip)/16000,2),
                     "align_cer":round(cer,3),"source":source,"split":"val" if len(rows)%5==4 else "train"})
        added+=1
    with io.open(mpath,"w",encoding="utf-8",newline="") as f:
        w=csv.DictWriter(f,fieldnames=["path","text","dur","align_cer","source","split"]); w.writeheader(); w.writerows(rows)
    return added, len(rows)

def main():
    ap=argparse.ArgumentParser()
    ap.add_argument("--wav", required=True, help="wav filename (in Recordings/) or absolute path")
    ap.add_argument("--phrases", required=True, help="'matrix' or path to a UTF-8 file, one reference phrase per line")
    ap.add_argument("--source", default=None, help="source tag for clip names (default: wav stem)")
    a=ap.parse_args()
    wav=a.wav if os.path.isabs(a.wav) else os.path.join(REC,a.wav)
    src=a.source or re.sub(r'\W+','_',os.path.splitext(os.path.basename(wav))[0])
    phrases=load_matrix_phrases() if a.phrases=="matrix" else [l.strip() for l in io.open(a.phrases,encoding="utf-8").read().splitlines() if l.strip()]
    print(f"wav={wav}\nsource={src}  phrases={len(phrases)}", flush=True)
    y,_=librosa.load(wav, sr=16000, mono=True); y=y.astype(np.float32); dur=len(y)/16000
    t0=time.time(); aligned=align(y, phrases); print(f"aligned {len(aligned)} phrases in {time.time()-t0:.0f}s", flush=True)
    added,total=append_clips(y,dur,aligned,src)
    print(f"added {added} clips; manifest now {total} rows -> {os.path.join(DATA,'manifest.csv')}", flush=True)

if __name__=="__main__": main()
