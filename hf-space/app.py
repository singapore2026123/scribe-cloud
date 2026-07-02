"""Scribe Burmese + Tamil + Chinese ASR microservice.
Primary: Dolphin-small (DataoceanAI) — language-specialised ASR for Burmese (my/MM), Tamil (ta/IN) and
Chinese Mandarin (zh/CN; Dolphin is a Chinese-specialist model). Fallback: SeamlessM4T v2 if Dolphin can't load/run.
Translation via Google Translate (free, no budget). Other languages are handled by Cloudflare Whisper, not here.
POST /transcribe  {audio: <base64 WAV>, src: "my"|"ta", target: "en"}  ->  {transcript, translation}
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

# --- Burmese term-snapping: deterministic wrong->correct fixes observed in Dolphin output (safe: non-word wrongs) ---
GLOSSARY_MM = [
    ("ကတင်", "ကုတင်"), ("လယ်ကြောင်း", "လည်ချောင်း"), ("ပရိထိန်း", "ဘရိတ်ထိန်း"),
    ("ဘီးတက်ကုလား", "ဘီးတပ်ကုလား"), ("မင်းမကျန်", "မေ့မကျန်"), ("မြက်စင်း", "မျက်စဉ်း"),
    ("ခက်ပေးခဲ့", "ခတ်ပေးခဲ့"), ("ကိုပူချိန်", "ကိုယ်အပူချိန်"), ("သွေးပေောင်", "သွေးပေါင်"),
    ("မြစ်နေသဖြင့်", "မြင့်နေသဖြင့်"), ("အောင်ောက်စီဂျင်", "အောက်ဆီဂျင်"),
]
def apply_glossary_mm(t):
    for w, c in GLOSSARY_MM:
        if w in t:
            t = t.replace(w, c)
    return t

# --- Burmese number-words -> digits (fixes vitals; conservative: leaves garbled/unknown tokens as-is) ---
_BN_DIG = {"သုည": 0, "တစ်": 1, "နှစ်": 2, "သုံး": 3, "လေး": 4, "ငါး": 5, "ခြောက်": 6, "ခုနစ်": 7, "ခုနှစ်": 7, "ရှစ်": 8, "ကိုး": 9}
_BN_MUL = {"ဆယ်": 10, "ရာ": 100, "ထောင်": 1000}
_BN_TOKENS = sorted(list(_BN_DIG) + list(_BN_MUL) + ["ဒသမ", "ရာခိုင်နှုန်း"], key=len, reverse=True)
def _bn_value(words):
    total = 0; cur = 0
    for w in words:
        if w in _BN_DIG:
            cur += _BN_DIG[w]
        elif w in _BN_MUL:
            cur = (cur or 1) * _BN_MUL[w]; total += cur; cur = 0
    return total + cur
def normalize_burmese_numbers(text):
    out = []; i = 0; n = len(text)
    def match_at(p):
        for tk in _BN_TOKENS:
            if text.startswith(tk, p):
                return tk
        return None
    while i < n:
        tk = match_at(i)
        if tk is None or tk == "ရာခိုင်နှုန်း":   # ရာခိုင်နှုန်း (percent word) is emitted literally, not parsed
            out.append(tk if tk == "ရာခိုင်နှုန်း" else text[i]); i += len(tk) if tk else 1
            continue
        run = []
        while i < n:
            m = match_at(i)
            if m is None or m == "ရာခိုင်နှုန်း":
                break
            run.append(m); i += len(m)
        parts = [[]]
        for w in run:
            if w == "ဒသမ":
                parts.append([])
            else:
                parts[-1].append(w)
        nums = [str(_bn_value(p)) for p in parts if p]
        out.append(".".join(nums) if nums else "".join(run))
    return "".join(out)

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


def _dolphin_asr(data16k, lang_sym="my", region_sym="MM"):
    import dolphin
    tmp = os.path.join(tempfile.gettempdir(), "scribe_%s.wav" % lang_sym)
    sf.write(tmp, data16k, 16000, subtype="PCM_16")
    res = dolphin.transcribe(_dolphin_model(), tmp, lang_sym=lang_sym, region_sym=region_sym)
    txt = DTOK.sub("", res.text if hasattr(res, "text") else str(res)).strip()
    return txt.split(" ⁇ ")[-1].strip()


def _chunks(a, sr=16000, max_sec=18.0):
    n = int(max_sec * sr)
    return [a] if len(a) <= n else [a[i:i + n] for i in range(0, len(a), n)]


@app.on_event("startup")
def _prewarm():   # load Dolphin in the background at boot so the first request isn't blocked by the ~1.4GB load
    import threading
    def _load():
        try:
            _dolphin_model()
        except Exception:
            pass
    threading.Thread(target=_load, daemon=True).start()


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

    # Burmese, Tamil & Chinese -> Dolphin (primary, language-specialised) + Google Translate; falls back to SeamlessM4T.
    _LR = {"my": ("my", "MM"), "ta": ("ta", "IN"), "zh": ("zh", "CN"), "zh-CN": ("zh", "CN")}
    if src in _LR:
        lang_sym, region_sym = _LR[src]
        transcript = ""
        try:
            transcript = _dolphin_asr(data, lang_sym, region_sym)
        except Exception:
            transcript = ""
        if src == "my" and transcript:
            transcript = normalize_burmese_numbers(apply_glossary_mm(transcript))   # snap terms + numbers->digits
        if transcript:
            translation = ""
            if target and target != "off" and target != src:
                try:
                    translation = _gtranslate(transcript, src, target)
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
