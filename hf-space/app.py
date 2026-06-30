"""Scribe Burmese ASR microservice — SeamlessM4T v2 (transcribe + translate) behind FastAPI.
Portable: this same container runs on HF Spaces (free CPU), Cloud Run, Fly.io, etc.
POST /transcribe  {audio: <base64 WAV>, src: "my", target: "en"}  ->  {transcript, translation}
"""
import base64, io
import numpy as np
import soundfile as sf
import librosa
from fastapi import FastAPI, Request

LANG = {"en": "eng", "ja": "jpn", "zh": "cmn", "zh-CN": "cmn", "ms": "zsm",
        "my": "mya", "ta": "tam", "ko": "kor", "th": "tha", "id": "ind", "vi": "vie", "hi": "hin", "fr": "fra"}
# Burmese loops badly -> aggressive anti-repeat. Other languages (esp. Japanese/Chinese)
# legitimately repeat short sequences, so those same settings force WRONG characters ->
# decode them with beam search and no forced anti-repeat instead.
GEN_MY = dict(no_repeat_ngram_size=3, repetition_penalty=1.3, max_new_tokens=256, num_beams=1)
GEN_DEFAULT = dict(max_new_tokens=256, num_beams=1)   # greedy, no forced anti-repeat (that corrupted JA/ZH); fast for live


def _gen(lang_code):
    return GEN_MY if lang_code == "mya" else GEN_DEFAULT

app = FastAPI()
# Allow the browser (Netlify site) to call this Space directly, cross-origin.
from fastapi.middleware.cors import CORSMiddleware
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])
STATE = {"proc": None, "model": None}


def _model():
    if STATE["model"] is None:
        from transformers import AutoProcessor, SeamlessM4Tv2Model
        STATE["proc"] = AutoProcessor.from_pretrained("facebook/seamless-m4t-v2-large")
        STATE["model"] = SeamlessM4Tv2Model.from_pretrained("facebook/seamless-m4t-v2-large")
    return STATE["proc"], STATE["model"]


def _chunks(a, sr=16000, max_sec=18.0):
    n = int(max_sec * sr)
    return [a] if len(a) <= n else [a[i:i + n] for i in range(0, len(a), n)]


@app.get("/")
def health():
    return {"ok": True, "model": "facebook/seamless-m4t-v2-large", "loaded": STATE["model"] is not None}


@app.post("/transcribe")
async def transcribe(req: Request):
    body = await req.json()
    b64 = body.get("audio", "")
    src = body.get("src", "my")
    target = body.get("target", "en")
    if not b64:
        return {"transcript": "", "translation": ""}
    proc, model = _model()
    data, sr = sf.read(io.BytesIO(base64.b64decode(b64)), dtype="float32")
    if data.ndim > 1:
        data = data.mean(axis=1)
    if sr != 16000:
        data = librosa.resample(data, orig_sr=sr, target_sr=16000)
    data = data.astype(np.float32)
    s = LANG.get(src, "mya")
    t = LANG.get(target)
    raws, trs = [], []
    for ch in _chunks(data):
        inp = proc(audio=ch, sampling_rate=16000, return_tensors="pt")
        asr = model.generate(**inp, tgt_lang=s, generate_speech=False, **_gen(s))
        cr = proc.decode(asr[0].tolist()[0], skip_special_tokens=True).strip()
        if cr:
            raws.append(cr)
        if t and target != "off" and t != s:
            tr = model.generate(**inp, tgt_lang=t, generate_speech=False, **_gen(t))
            ct = proc.decode(tr[0].tolist()[0], skip_special_tokens=True).strip()
            if ct:
                trs.append(ct)
    return {"transcript": " ".join(raws).strip(), "translation": " ".join(trs).strip()}
