"""Scribe Burmese + Tamil + Chinese ASR microservice.
Burmese (my): MMS (facebook/mms-1b-all, 'mya' adapter) is PRIMARY — benchmarked on real KWSH care speech at
74.4% char / 51.4% digit accuracy, beating Dolphin (56.1% / 37.1%) and Whisper (~0%). Dolphin-small then
SeamlessM4T v2 are fallbacks. Set env SCRIBE_MY_ENGINE=dolphin to revert Burmese to Dolphin-primary.
Tamil (ta/IN) and Chinese (zh/CN, Cantonese, Hokkien): Dolphin-small (language-specialised) -> SeamlessM4T v2.
Translation via Google Translate (free, no budget). Other languages are handled by Cloudflare Whisper, not here.
POST /transcribe  {audio: <base64 WAV>, src: "my"|"ta", target: "en"}  ->  {transcript, translation}
"""
import base64, io, os, re, json, tempfile, unicodedata, urllib.parse, urllib.request
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
      "my": "my", "ko": "ko", "th": "th", "id": "id", "vi": "vi", "hi": "hi", "fr": "fr",
      "yue": "yue", "nan": "zh-CN"}   # Cantonese has its own Google code; Hokkien is written in Han -> translate as Chinese
def _gtranslate(text, sl, tl):
    if not text or not tl:
        return ""
    url = ("https://translate.googleapis.com/translate_a/single?client=gtx&sl=%s&tl=%s&dt=t&q=%s"
           % (GT.get(sl, "auto"), GT.get(tl, tl), urllib.parse.quote(text)))
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0", "Accept": "application/json"})
    data = json.loads(urllib.request.urlopen(req, timeout=15).read().decode("utf-8"))
    return "".join(seg[0] for seg in data[0] if seg and seg[0]).strip()

# --- Burmese Unicode normalization (LREC-2020 Gutkin et al.): Burmese text has variable diacritic ordering, and some
# sources use the non-Unicode Zawgyi encoding (visually identical, DIFFERENT codepoints) -> raw str matching in the
# glossary / number passes below silently misses. NFC-canonicalize (stdlib, no dep) so matching is stable; and, IF a
# Zawgyi detector+converter are vendored in, convert Zawgyi->Unicode first. Both are guarded/optional: neither is a pip
# dependency (myanmar-tools / a Rabbit converter aren't on PyPI), so by default this is NFC-only and never breaks the
# build. To enable Zawgyi handling, drop the two libs into the image and the imports below light up automatically. ---
try:
    from myanmar_tools import ZawgyiDetector
    _ZG_DETECT = ZawgyiDetector()
except Exception:
    _ZG_DETECT = None
try:
    from rabbit import zg2uni as _zg2uni   # Rabbit Converter (Zawgyi<->Unicode); optional, not a pip dep
except Exception:
    _zg2uni = None
def normalize_burmese_unicode(text):
    if not text:
        return text
    if _ZG_DETECT is not None and _zg2uni is not None:
        try:
            if _ZG_DETECT.get_zawgyi_probability(text) > 0.8:   # high-confidence Zawgyi only (don't corrupt Unicode)
                text = _zg2uni(text)
        except Exception:
            pass
    return unicodedata.normalize("NFC", text)

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
# Dolphin writes the tens with a creaky-tone dot (U+1037) before a following unit (e.g. 36 = [30]+[6]) -> add that
# variant so it matches (built by inserting U+1037 before the final asat, to keep the source ASCII-safe).
for _t in [k for k, v in _BN_MUL.items() if v == 10]:
    _BN_MUL[_t[:-1] + chr(0x1037) + _t[-1]] = 10
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
                j = i   # Dolphin spaces number-words apart ("... ဒသမ ...") -> skip spaces between two number tokens
                while j < n and text[j] == " ":
                    j += 1
                nm = match_at(j)
                if j > i and nm is not None and nm != "ရာခိုင်နှုန်း":
                    i = j
                    continue
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

# Spoken-symbol -> symbol normalization for the Space languages (Dolphin), fires ONLY between digits so it's safe on
# prose. Uses the spoken forms verified in the language glossaries' number sections. Tamil "128 பை 98"->"128/98",
# "36 புள்ளி 6"->"36.6"; Chinese "128比98"->"128/98", "36点6"->"36.6"; Burmese BP "128 ကို 98"->"128/98" (applied AFTER
# normalize_burmese_numbers has turned the number-words into digits). NOTE: no ZH/TA vitals clips exist yet to measure this.
_SPOKEN_SYM = {
    "ta": [("புள்ளி", "."), ("பை", "/"), ("பர்சென்ட்", "%")],
    "zh": [("点", "."), ("比", "/"), ("杠", "/")],
    "my": [("ကို", "/")],   # BP "over"; the decimal ဒသမ is already consumed by normalize_burmese_numbers
}
def apply_spoken_symbols(text, lang):
    rules = _SPOKEN_SYM.get(lang)
    if not rules or not text:
        return text
    for word, sym in rules:
        pat = re.compile(r"(\d)\s*" + re.escape(word) + r"\s*(\d)")
        prev = None
        while prev != text:   # chained, e.g. "1 point 2 point 3"
            prev = text
            text = pat.sub(r"\1" + sym + r"\2", text)
    return text

app = FastAPI()
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])
STATE = {"proc": None, "model": None, "dolphin": None, "mms": None}
DTOK = re.compile(r"<[^>]*>")   # strip Dolphin control tokens like <my><MM><asr><notimestamp>
def _native_ok(s, lang):   # keep sentence if it has native script (Tamil 0x0B80-0x0BFF / Burmese 0x1000-0x109F) or no Latin letters
    lo, hi = (0x0B80, 0x0BFF) if lang == "ta" else (0x1000, 0x109F)
    has_native = any(lo <= ord(c) <= hi for c in s)
    has_latin = any((65 <= ord(c) <= 90) or (97 <= ord(c) <= 122) for c in s)
    return has_native or (not has_latin)
def keep_native(text, lang):
    """Dolphin sometimes emits fluent English sentences for ta/my (self-translation/hallucination).
    Keep only sentences with native script; drop English-only sentences."""
    if lang not in ("ta", "my"):
        return text
    out = [p.strip() for p in re.split(r"(?<=[.!?])\s+", text) if p.strip() and _native_ok(p.strip(), lang)]
    return " ".join(out).strip()


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


# --- MMS (facebook/mms-1b-all + Burmese 'mya' adapter). Benchmarked on real KWSH care speech (Recording 17):
#     MMS 74.4% char / 51.4% digit accuracy, vs Dolphin 56.1% / 37.1% and Whisper ~0%. -> MMS is the primary
#     Burmese engine; Dolphin + SeamlessM4T stay as fallbacks. Revert with env SCRIBE_MY_ENGINE=dolphin.
#     MMS emits Burmese numerals directly (၃၆) -> map to ASCII digits; it does NOT use the Dolphin number-WORD parser. ---
_MM2ASCII = {0x1040 + k: ord(str(k)) for k in range(10)}   # Myanmar digits U+1040-1049 -> "0".."9"
def burmese_numerals_to_ascii(t):
    return t.translate(_MM2ASCII) if t else t
def _mms_model():
    if STATE.get("mms") is None:
        from transformers import Wav2Vec2ForCTC, AutoProcessor
        proc = AutoProcessor.from_pretrained("facebook/mms-1b-all")
        model = Wav2Vec2ForCTC.from_pretrained("facebook/mms-1b-all")
        proc.tokenizer.set_target_lang("mya")   # Burmese ISO-639-3
        model.load_adapter("mya")
        model.eval()
        STATE["mms"] = (proc, model)
    return STATE["mms"]
# --- Optional char-n-gram LM decoding for Burmese (shallow-fusion CTC beam search). Enable with SCRIBE_MY_LM=1.
#     Prototype: rec-17 CER 25.7% (greedy) -> 24.8% (beam+LM), +0.9pt, NO acoustic retraining, from the care glossary.
#     Char-level (correct for space-less Burmese) + pure Python (no kenlm/C++ build; portable & testable). Adds CPU
#     latency per utterance, so it's off by default. Corpus: hf-space/burmese_lm_corpus.txt (glossary; expand for
#     more gain). SPEED NOTE: on the Space you can swap the Python n-gram below for a char-level kenlm backend. ---
import math
from collections import defaultdict
_LM = {}
def _lm_build(N=5):
    if _LM:
        return
    full = defaultdict(int); ctx = defaultdict(int); V = set()
    path = os.path.join(os.path.dirname(__file__), "burmese_lm_corpus.txt")
    try:
        for line in io.open(path, encoding="utf-8"):
            t = "^" + unicodedata.normalize("NFC", line.strip()) + "$"
            for c in t: V.add(c)
            for n in range(1, N + 1):
                for i in range(len(t) - n + 1):
                    full[t[i:i + n]] += 1
                    if n > 1: ctx[t[i:i + n - 1]] += 1
    except FileNotFoundError:
        pass
    _LM.update(full=full, ctx=ctx, V=max(len(V), 1), N=N,
               uni=sum(v for g, v in full.items() if len(g) == 1) or 1)
def _lm_logp(prefix_chars, ch):   # P(ch | last N-1 chars), stupid-backoff + add-k
    N = _LM["N"]; full = _LM["full"]; ctx = _LM["ctx"]; V = _LM["V"]
    for n in range(N, 1, -1):
        c = prefix_chars[-(n - 1):]
        den = ctx.get(c, 0)
        if den > 0:
            return math.log((full.get(c + ch, 0) + 0.1) / (den + 0.1 * V))
    return math.log((full.get(ch, 0) + 0.1) / (_LM["uni"] + 0.1 * V))
_MYRE = re.compile(r'[က-ဿ]')   # Burmese letters (not numerals) -> only score these with the LM
def _beam_decode(logp, id2ch, blank, alpha=0.4, beam=12, topk=12):
    NEG = -1e30
    def lse(a, b):
        if a == NEG: return b
        if b == NEG: return a
        m = max(a, b); return m + math.log(math.exp(a - m) + math.exp(b - m))
    beams = {(): [0.0, NEG]}
    cache = {}
    def lm(prefix, ch):
        cs = id2ch.get(ch, "")
        if not (cs and _MYRE.match(cs)): return 0.0
        key = ("".join(id2ch.get(i, "") for i in prefix[-(_LM["N"] - 1):]), cs)
        if key not in cache: cache[key] = alpha * _lm_logp(key[0], cs)
        return cache[key]
    for row in logp:
        top = sorted(range(len(row)), key=lambda c: -row[c])[:topk]
        if blank not in top: top.append(blank)
        new = defaultdict(lambda: [NEG, NEG])
        for prefix, (pb, pnb) in beams.items():
            ptot = lse(pb, pnb)
            for c in top:
                lp = row[c]
                if c == blank:
                    e = new[prefix]; e[0] = lse(e[0], ptot + lp); continue
                last = prefix[-1] if prefix else -1
                if c == last:
                    e = new[prefix]; e[1] = lse(e[1], pnb + lp)
                    np_ = prefix + (c,); e2 = new[np_]; e2[1] = lse(e2[1], pb + lp + lm(prefix, c))
                else:
                    np_ = prefix + (c,); e2 = new[np_]; e2[1] = lse(e2[1], ptot + lp + lm(prefix, c))
        beams = dict(sorted(new.items(), key=lambda kv: -lse(kv[1][0], kv[1][1]))[:beam])
    best = max(beams.items(), key=lambda kv: lse(kv[1][0], kv[1][1]))[0]
    return "".join(id2ch.get(i, "") for i in best if id2ch.get(i, "") not in ("<pad>", "<s>", "</s>", "<unk>", "|"))

def _mms_asr(data16k):
    import torch
    proc, model = _mms_model()
    use_lm = os.environ.get("SCRIBE_MY_LM") == "1"
    if use_lm:
        _lm_build()
        id2ch = {i: t for t, i in proc.tokenizer.get_vocab().items()}
        blank = proc.tokenizer.pad_token_id
    out = []
    for ch in _chunks(data16k, max_sec=15.0):
        if len(ch) < 1600:
            continue
        inp = proc(ch, sampling_rate=16000, return_tensors="pt")
        with torch.no_grad():
            logits = model(**inp).logits
        if use_lm:
            lp = torch.log_softmax(logits, dim=-1)[0].tolist()
            out.append(_beam_decode(lp, id2ch, blank))
        else:
            out.append(proc.decode(torch.argmax(logits, dim=-1)[0]).strip())
    return " ".join(p for p in out if p).strip()


@app.on_event("startup")
def _prewarm():   # preload the primary Burmese engine at boot so the first request isn't blocked by the model load
    import threading
    def _load():
        try:
            if os.environ.get("SCRIBE_MY_ENGINE", "mms") == "mms":
                _mms_model()      # ~1GB, primary for Burmese
            else:
                _dolphin_model()  # ~1.4GB
        except Exception:
            pass
    threading.Thread(target=_load, daemon=True).start()


@app.get("/")
def health():
    return {"ok": True, "engine": "mms+dolphin+seamless", "my_engine": os.environ.get("SCRIBE_MY_ENGINE", "mms"),
            "my_lm": os.environ.get("SCRIBE_MY_LM") == "1",
            "mms_loaded": STATE.get("mms") is not None, "dolphin_loaded": STATE["dolphin"] is not None}


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

    # Burmese: MMS primary (benchmarked best on KWSH care speech), then Dolphin, then SeamlessM4T. Toggle off
    # with env SCRIBE_MY_ENGINE=dolphin. Other langs are unchanged (Dolphin -> Seamless).
    if src == "my" and os.environ.get("SCRIBE_MY_ENGINE", "mms") == "mms":
        transcript = ""
        try:
            transcript = _mms_asr(data)
        except Exception:
            transcript = ""
        if transcript:
            # MMS emits Burmese numerals directly -> ASCII digits (NOT the Dolphin number-word parser).
            transcript = apply_glossary_mm(burmese_numerals_to_ascii(normalize_burmese_unicode(transcript)))
            transcript = apply_spoken_symbols(transcript, "my")   # "128 ကို 98" -> "128/98"
            transcript = keep_native(transcript, "my")            # drop any English-only sentences
        if transcript:
            translation = ""
            if target and target != "off" and target != src:
                try:
                    translation = _gtranslate(transcript, src, target)
                except Exception:
                    translation = ""
            return {"transcript": transcript, "translation": translation}
        # MMS unavailable/empty -> fall through to Dolphin (and then Seamless) below.

    # Burmese, Tamil & Chinese -> Dolphin (language-specialised) + Google Translate; falls back to SeamlessM4T.
    # Dolphin two-level tokens: Cantonese = ct/HK, Hokkien (Min Nan) = zh/MINNAN (both in the model's languages.md).
    _LR = {"my": ("my", "MM"), "ta": ("ta", "IN"), "zh": ("zh", "CN"), "zh-CN": ("zh", "CN"),
           "yue": ("ct", "HK"), "nan": ("zh", "MINNAN")}
    if src in _LR:
        lang_sym, region_sym = _LR[src]
        transcript = ""
        try:
            transcript = _dolphin_asr(data, lang_sym, region_sym)
        except Exception:
            transcript = ""
        if src == "my" and transcript:
            # Zawgyi->Unicode + NFC first, so the glossary/number passes match reliably, then snap terms + numbers->digits.
            transcript = normalize_burmese_numbers(apply_glossary_mm(normalize_burmese_unicode(transcript)))
        if transcript and src in _SPOKEN_SYM:
            transcript = apply_spoken_symbols(transcript, src)   # spoken decimal/slash -> "." / "/" between digits
        if transcript and src in ("ta", "my"):
            transcript = keep_native(transcript, src)   # drop English-only sentences Dolphin emits for ta/my
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
