"""Scribe Burmese ASR microservice.
Primary: Dolphin-small (DataoceanAI) — the desktop app's Burmese engine (fast + accurate).
Fallback: SeamlessM4T v2 if Dolphin can't load/run. Translation via Google Translate (free, no budget).
Non-Burmese languages are handled by Cloudflare Whisper, not here.
POST /transcribe  {audio: <base64 WAV>, src: "my", target: "en"}  ->  {transcript, translation}
"""
import base64, io, os, re, json, tempfile, urllib.parse, urllib.request
import numpy as np
import soundfile as sf
import librosa
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware

# SeamlessM4T ASR codes (fallback path only).
LANG = {"en": "eng", "ja": "jpn", "zh": "cmn", "zh-CN": "cmn", "ms": "zsm",
        "my": "mya", "ta": "tam", "ko": "kor", "th": "tha", "id": "ind", "vi": "vie", "hi": "hin", "fr": "fra"}
GEN = dict(no_repeat_ngram_size=3, repetition_penalty=1.3, max_new_tokens=256, num_beams=1)

# Google Translate free endpoint (no key, no budget) for the translation half.
GT = {"en": "en", "ja": "ja", "zh": "zh-CN", "zh-CN": "zh-CN", "ms": "ms", "ta": "ta",
      "my": "my", "ko": "ko", "th": "th", "id": "id", "vi": "vi", "hi": "hi", "fr": "fr"}
def _gtranslate(text, sl, tl):
    if not text or not tl:
        return ""
    url = ("https://translate.googleapis.com/translate_a/single?client=gtx&sl=%s&tl=%s&dt=t&q=%s"
           % (GT.get(sl, "auto"), GT.get(tl, tl), urllib.parse.quote(text)))
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0", "Accept": "application/json"})
    data = json.loads(urllib.request.urlopen(req, timeout=15).read().decode("utf-8"))
    return "".join(seg[0] for seg in data[0] if seg and seg[0]).strip()

app = FastAPI()
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])
STATE = {"proc": None, "model": None, "dolphin": None}
DTOK = re.compile(r"<[^>]*>")   # strip Dolphin control tokens like <my><MM><asr><notimestamp>


def _seamless():
    if STATE["model"] is None:
        from transformers import AutoProcessor, SeamlessM4Tv2Model
        STATE["proc"] = AutoProcessor.from_pretrained("facebook/seamless-m4t-v2-large")
        STATE["model"] = SeamlessM4Tv2Model.from_pretrained("facebook/seamless-m4t-v2-large")
    return STATE["proc"], STATE["model"]


def _dolphin_model():
    if STATE["dolphin"] is None:
        import dolphin
        STATE["dolphin"] = dolphin.load_model("small", device="cpu")   # ~1.4 GB, cached in MODELSCOPE_CACHE
    return STATE["dolphin"]


def _dolphin_asr(data16k):
    import dolphin
    tmp = os.path.join(tempfile.gettempdir(), "scribe_mm.wav")
    sf.write(tmp, data16k, 16000, subtype="PCM_16")
    res = dolphin.transcribe(_dolphin_model(), tmp, lang_sym="my", region_sym="MM")
    txt = DTOK.sub("", res.text if hasattr(res, "text") else str(res)).strip()
    return txt.split(" ⁇ ")[-1].strip()


def _chunks(a, sr=16000, max_sec=18.0):
    n = int(max_sec * sr)
    return [a] if len(a) <= n else [a[i:i + n] for i in range(0, len(a), n)]


@app.get("/")
def health():
    return {"ok": True, "engine": "dolphin+seamless", "dolphin_loaded": STATE["dolphin"] is not None}


@app.post("/transcribe")
async def transcribe(req: Request):
    body = await req.json()
    b64 = body.get("audio", "")
    src = body.get("src", "my")
    target = body.get("target", "en")
    if not b64:
        return {"transcript": "", "translation": ""}
    data, sr = sf.read(io.BytesIO(base64.b64decode(b64)), dtype="float32")
    if data.ndim > 1:
        data = data.mean(axis=1)
    if sr != 16000:
        data = librosa.resample(data, orig_sr=sr, target_sr=16000)
    data = data.astype(np.float32)

    # Burmese -> Dolphin (primary) + Google Translate; falls back to SeamlessM4T if Dolphin fails.
    if src == "my":
        transcript = ""
        try:
            transcript = _dolphin_asr(data)
        except Exception:
            transcript = ""
        if transcript:
            translation = ""
            if target and target != "off" and target != "my":
                try:
                    translation = _gtranslate(transcript, "my", target)
                except Exception:
                    translation = ""
            return {"transcript": transcript, "translation": translation}
        # Dolphin unavailable/empty -> SeamlessM4T fallback below.

    proc, model = _seamless()
    s = LANG.get(src, "mya")
    raws = []
    for ch in _chunks(data):
        inp = proc(audio=ch, sampling_rate=16000, return_tensors="pt")
        asr = model.generate(**inp, tgt_lang=s, generate_speech=False, **GEN)
        cr = proc.decode(asr[0].tolist()[0], skip_special_tokens=True).strip()
        if cr:
            raws.append(cr)
    transcript = " ".join(raws).strip()
    translation = ""
    if transcript and target and target != "off" and GT.get(target) and GT.get(target) != GT.get(src):
        try:
            translation = _gtranslate(transcript, src, target)
        except Exception:
            translation = ""
    return {"transcript": transcript, "translation": translation}
