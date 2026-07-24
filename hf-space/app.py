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
from fastapi import FastAPI, Request, WebSocket
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
        import torch
        from transformers import Wav2Vec2ForCTC, AutoProcessor
        proc = AutoProcessor.from_pretrained("facebook/mms-1b-all")
        model = Wav2Vec2ForCTC.from_pretrained("facebook/mms-1b-all")
        proc.tokenizer.set_target_lang("mya")   # Burmese ISO-639-3
        model.load_adapter("mya")
        model.eval()
        # int8 dynamic quantization: measured 2.2x faster greedy on CPU with 0.0% output drift (lossless).
        # On by default; disable with env SCRIBE_MY_QUANT=0.
        if os.environ.get("SCRIBE_MY_QUANT", "1") == "1":
            try:
                model = torch.quantization.quantize_dynamic(model, {torch.nn.Linear}, dtype=torch.qint8)
            except Exception:
                pass
        STATE["mms"] = (proc, model)
    return STATE["mms"]
# --- Optional LM decoding for Burmese CTC beam search. Enable with SCRIBE_MY_LM=1.
#     Two backends: kenlm (fast C++, built at Docker time from burmese_char.arpa) or pure-Python char n-gram (slow).
#     kenlm is preferred on the Space (Linux); pure-Python fallback for Windows/testing. ---
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

_KENLM_DECODER = None
def _kenlm_decoder():
    """Build a pyctcdecode BeamSearchDecoderCTC backed by the kenlm ARPA model (character-level).
    Returns the decoder or None if kenlm/pyctcdecode unavailable or ARPA missing."""
    global _KENLM_DECODER
    if _KENLM_DECODER is not None:
        return _KENLM_DECODER if _KENLM_DECODER else None
    arpa = os.path.join(os.path.dirname(__file__), "burmese_char.arpa")
    if not os.path.exists(arpa):
        _KENLM_DECODER = False; return None
    try:
        from pyctcdecode import build_ctcdecoder
        proc, _ = _mms_model()
        vocab = proc.tokenizer.get_vocab()
        labels = [k for k, _ in sorted(vocab.items(), key=lambda x: x[1])]
        _KENLM_DECODER = build_ctcdecoder(labels, kenlm_model_path=arpa, alpha=0.5, beta=1.0)
        return _KENLM_DECODER
    except Exception as e:
        import traceback; traceback.print_exc()
        _KENLM_DECODER = False; return None

def _mms_asr(data16k):
    import torch
    proc, model = _mms_model()
    use_lm = os.environ.get("SCRIBE_MY_LM") == "1"
    kenlm_dec = _kenlm_decoder() if use_lm else None
    if use_lm and not kenlm_dec:
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
        if kenlm_dec:
            lp = torch.log_softmax(logits, dim=-1)[0].cpu().numpy()
            out.append(kenlm_dec.decode(lp, beam_width=16))
        elif use_lm:
            lp = torch.log_softmax(logits, dim=-1)[0].tolist()
            out.append(_beam_decode(lp, id2ch, blank))
        else:
            out.append(proc.decode(torch.argmax(logits, dim=-1)[0]).strip())
    return " ".join(p for p in out if p).strip()


def _postprocess_my(transcript):
    """Burmese post-processing shared by /transcribe and /stream: Zawgyi/NFC + glossary + numerals->ASCII
    + spoken-symbols + keep-native."""
    if not transcript:
        return ""
    transcript = apply_glossary_mm(burmese_numerals_to_ascii(normalize_burmese_unicode(transcript)))
    transcript = apply_spoken_symbols(transcript, "my")
    return keep_native(transcript, "my")


# --- Closed-vocab snapping: garbled ASR -> nearest KNOWN care phrase (care_phrases.json, from the matrix)
#     -> its VERIFIED translation. Bypasses ASR garbling + MT errors for common care phrases; novel speech
#     falls through to raw transcript + Google Translate. Disable with env SCRIBE_MY_SNAP=0. ---
import json as _json
_CARE = None
_MYLET = re.compile(r'[က-႟]')
def _my_only(s):
    return "".join(c for c in unicodedata.normalize("NFC", str(s)) if _MYLET.match(c))
def _sym_cer(a, b):
    n, m = len(a), len(b)
    if n == 0 and m == 0:
        return 0.0
    prev = list(range(m + 1))
    for i in range(1, n + 1):
        cur = [i] + [0] * m
        ac = a[i - 1]
        for j in range(1, m + 1):
            cur[j] = min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (0 if ac == b[j - 1] else 1))
        prev = cur
    return prev[m] / max(n, m, 1)
def _load_json(name):
    try:
        return _json.load(io.open(os.path.join(os.path.dirname(__file__), name), encoding="utf-8"))
    except Exception:
        return []
def _care_phrases():
    """Unified snap candidates: verified care SENTENCES (care_phrases.json, from the matrix) +
    the app's controlled care VOCABULARY (care_vocab.json, Zawgyi->Unicode). Each carries an
    `is_vocab` flag so vocab (short terms) can be matched more conservatively than sentences."""
    global _CARE
    if _CARE is None:
        _CARE = []
        for p in _load_json("care_phrases.json"):
            p = dict(p); p["_my"] = _my_only(p.get("my", "")); p["is_vocab"] = False
            _CARE.append(p)
        for v in _load_json("care_vocab.json"):
            v = dict(v); v["_my"] = _my_only(v.get("my", "")); v["is_vocab"] = True
            _CARE.append(v)
    return _CARE

_CONFUSABLES = None
def _confusable_set():
    """Build a set of candidate indices that have a near-identical Burmese partner with DIFFERENT
    meaning. When snapping hits one of these, require a wider margin vs the partner to snap."""
    global _CONFUSABLES
    if _CONFUSABLES is not None:
        return _CONFUSABLES
    cands = _care_phrases()
    pairs = {}  # idx -> list of confusable partner indices
    for i in range(len(cands)):
        mi = cands[i]["_my"]
        if not mi or len(mi) < 4:
            continue
        for j in range(i + 1, len(cands)):
            mj = cands[j]["_my"]
            if not mj or abs(len(mi) - len(mj)) > 5:
                continue
            cer = _sym_cer(mi, mj)
            ja_i = cands[i].get("ja", "")
            ja_j = cands[j].get("ja", "")
            if 0 < cer < 0.20 and ja_i != ja_j:
                pairs.setdefault(i, []).append(j)
                pairs.setdefault(j, []).append(i)
    _CONFUSABLES = pairs
    return _CONFUSABLES

# --- Semantic tiers for snapping (used when char-CER can't match a garbled/paraphrased utterance) ---
_TFIDF = None   # (vectorizer, matrix) over candidate _my strings; char-ngram cosine, no model needed
def _tfidf():
    global _TFIDF
    if _TFIDF is None:
        try:
            from sklearn.feature_extraction.text import TfidfVectorizer
            cands = [p["_my"] for p in _care_phrases()]
            vec = TfidfVectorizer(analyzer="char_wb", ngram_range=(2, 4))
            mat = vec.fit_transform(cands)
            _TFIDF = (vec, mat)
        except Exception:
            _TFIDF = (None, None)
    return _TFIDF

_LABSE = None   # sentence-transformers LaBSE (multilingual incl. Burmese); embeds candidates once
_LABSE_EMB = None
def _labse():
    global _LABSE, _LABSE_EMB
    if _LABSE is None:
        if os.environ.get("SCRIBE_MY_SEMANTIC", "1") != "1":
            _LABSE = False; return None
        try:
            from sentence_transformers import SentenceTransformer
            _LABSE = SentenceTransformer(os.environ.get("SCRIBE_LABSE_MODEL", "sentence-transformers/LaBSE"))
            cands = [p["_my"] for p in _care_phrases()]
            _LABSE_EMB = _LABSE.encode(cands, normalize_embeddings=True, batch_size=64)
        except Exception:
            _LABSE = False
    return _LABSE or None

def _snap_care(transcript, target):
    """Snap garbled/paraphrased Burmese ASR to the nearest KNOWN care phrase and return
    (clean_phrase, verified_translation), else None. Three tiers, tried most-precise first:
      1. char-CER          (orthographic; catches garbled versions of a known phrase)
      2. char-ngram TF-IDF (robust to reordering/partial garble)
      3. LaBSE embeddings  (semantic; catches paraphrases in natural speech)
    Vocab terms (short) use stricter thresholds than sentences to avoid coarse mismatches."""
    if os.environ.get("SCRIBE_MY_SNAP", "1") != "1":
        return None
    h = _my_only(transcript)
    if len(h) < 6:
        return None
    cands = _care_phrases()

    def ok_len(pm, tight):
        lo, hi = (0.6, 1.7) if tight else (0.4, 2.5)
        r = len(pm) / max(len(h), 1)
        return lo <= r <= hi

    def result(p):
        return p.get("my", ""), (p.get(target) or p.get("ja") or p.get("en") or "")

    confusables = _confusable_set()

    def _confusable_ambiguous(best_idx, best_score, scores_fn, margin):
        """Return True if a confusable partner scores within `margin` of the best — too close to snap."""
        partners = confusables.get(best_idx, [])
        if not partners:
            return False
        for pi in partners:
            ps = scores_fn(pi)
            if abs(best_score - ps) < margin:
                return True
        return False

    # Tier 1: char-CER
    best = None
    best_idx = -1
    cer_cache = {}
    for i, p in enumerate(cands):
        pm = p["_my"]
        if not pm or not ok_len(pm, p["is_vocab"]):
            continue
        c = _sym_cer(pm, h)
        cer_cache[i] = c
        if best is None or c < best[0]:
            best = (c, p)
            best_idx = i
    if best:
        thr = 0.33 if best[1]["is_vocab"] else 0.45
        if best[0] <= thr:
            if not _confusable_ambiguous(best_idx, best[0], lambda i: cer_cache.get(i, 1.0), 0.10):
                return result(best[1])

    # Tier 2: char-ngram TF-IDF cosine
    vec, mat = _tfidf()
    if vec is not None:
        try:
            import numpy as _np
            q = vec.transform([h])
            sims = (mat @ q.T).toarray().ravel()
            order = sims.argsort()[::-1]
            for idx in order[:5]:
                p = cands[idx]
                if not ok_len(p["_my"], p["is_vocab"]):
                    continue
                thr = 0.72 if p["is_vocab"] else 0.58
                if sims[idx] >= thr:
                    if not _confusable_ambiguous(idx, sims[idx], lambda i: sims[i], 0.08):
                        return result(p)
                break
        except Exception:
            pass

    # Tier 3: LaBSE semantic
    model = _labse()
    if model is not None and _LABSE_EMB is not None:
        try:
            import numpy as _np
            qe = model.encode([h], normalize_embeddings=True)[0]
            sims = _LABSE_EMB @ qe
            order = sims.argsort()[::-1]
            for idx in order[:5]:
                p = cands[idx]
                if not ok_len(p["_my"], p["is_vocab"]):
                    continue
                thr = 0.82 if p["is_vocab"] else 0.72
                if sims[idx] >= thr:
                    if not _confusable_ambiguous(idx, sims[idx], lambda i: sims[i], 0.06):
                        return result(p)
                break
        except Exception:
            pass
    return None

# --- Translation for Burmese when snapping misses: Gemini (robust to ASR noise) if a key is set,
#     else Google Translate. Gemini reads THROUGH garbled ASR; enable by setting GEMINI_API_KEY. ---
_GEMINI_LANG = {"ja": "Japanese", "en": "English", "zh": "Chinese", "ms": "Malay",
                "ta": "Tamil", "hi": "Hindi", "vi": "Vietnamese", "my": "Burmese"}
def _gemini_translate(text, target):
    key = os.environ.get("GEMINI_API_KEY", "").strip()
    if not key or not text:
        return ""
    try:
        import requests
        lang = _GEMINI_LANG.get(target, target)
        model = os.environ.get("SCRIBE_GEMINI_MODEL", "gemini-flash-latest")
        prompt = ("The following is Burmese text from a care-worker's spoken note, transcribed by a "
                  "speech recognizer that may contain errors. Infer the intended meaning and translate "
                  f"it into {lang}. It is about elderly care (vitals, meals, bathing, excretion, "
                  "medication, mobility). Output ONLY the translation, no notes.\n\n" + text)
        url = "https://generativelanguage.googleapis.com/v1beta/models/%s:generateContent" % model
        r = requests.post(url, params={"key": key},
                          json={"contents": [{"parts": [{"text": prompt}]}],
                                "generationConfig": {"temperature": 0.2}}, timeout=20)
        r.raise_for_status()
        return r.json()["candidates"][0]["content"]["parts"][0]["text"].strip()
    except Exception:
        return ""
_OPENAI_LANG = _GEMINI_LANG
def _openai_translate(text, target):
    key = os.environ.get("OPENAI_API_KEY", "").strip()
    if not key or not text:
        return ""
    try:
        import requests
        lang = _OPENAI_LANG.get(target, target)
        model = os.environ.get("SCRIBE_OPENAI_MODEL", "gpt-4o-mini")
        prompt = ("The following is Burmese text from a care-worker's spoken note, transcribed by a "
                  "speech recognizer that may contain errors. Infer the intended meaning and translate "
                  f"it into {lang}. It is about elderly care (vitals, meals, bathing, excretion, "
                  "medication, mobility). Output ONLY the translation, no notes.\n\n" + text)
        r = requests.post("https://api.openai.com/v1/chat/completions",
                          headers={"Authorization": "Bearer " + key},
                          json={"model": model, "temperature": 0.2,
                                "messages": [{"role": "user", "content": prompt}]}, timeout=20)
        r.raise_for_status()
        return r.json()["choices"][0]["message"]["content"].strip()
    except Exception:
        return ""
def _translate_my(text, target):
    """Burmese->target: Gemini -> OpenAI -> Google Translate (first available key wins)."""
    if not text or not target or target in ("off", "my"):
        return ""
    tr = _gemini_translate(text, target)
    if tr:
        return tr
    tr = _openai_translate(text, target)
    if tr:
        return tr
    try:
        return _gtranslate(text, "my", target)
    except Exception:
        return ""


# --- Real-time streaming: WebSocket /stream. Client sends raw PCM16LE mono 16kHz chunks (binary frames) as the
#     mic captures them, and a text frame "end" to finish. Server does energy-VAD segmentation: when it hears a
#     pause it transcribes that utterance with quantized MMS greedy and sends {"final": text}; a light interim
#     {"partial": text} is emitted while speech continues. Utterance-level = bounded cost + phrase-by-phrase output
#     (matches how care notes are spoken). Blocking MMS runs in a threadpool so the socket stays responsive.
#     Tuning via env: SCRIBE_VAD_RMS (speech threshold), SCRIBE_VAD_SIL (pause secs). ---
@app.websocket("/stream")
async def stream(ws: WebSocket):
    from starlette.concurrency import run_in_threadpool
    import numpy as np
    await ws.accept()
    target = ws.query_params.get("target", "")   # facility/record language for translation (e.g. ja/en); "" = none
    SR = 16000
    THRESH = float(os.environ.get("SCRIBE_VAD_RMS", "0.008"))
    SIL = float(os.environ.get("SCRIBE_VAD_SIL", "0.6"))
    MINSP, MAXSEG = 0.4, 15.0
    seg = []; trailing = 0.0; started = False; last_partial = 0.0
    async def do(samples, translate=False):
        txt = await run_in_threadpool(lambda: _postprocess_my(_mms_asr(np.asarray(samples, dtype=np.float32))))
        tr = ""
        if translate and txt:
            snap = _snap_care(txt, target)          # known care phrase -> verified clean text + translation
            if snap:
                txt, tr = snap[0], snap[1]
            elif target and target not in ("off", "my"):
                tr = await run_in_threadpool(lambda: _translate_my(txt, target))
        return txt, tr
    async def flush():
        nonlocal seg, trailing, started, last_partial
        if len(seg) / SR >= MINSP:
            txt, tr = await do(seg, translate=True)
            await ws.send_json({"final": txt, "translation": tr})
        seg = []; trailing = 0.0; started = False; last_partial = 0.0
    try:
        while True:
            m = await ws.receive()
            if m.get("type") == "websocket.disconnect":
                break
            if m.get("text") == "end":
                await flush(); continue
            b = m.get("bytes")
            if not b:
                continue
            chunk = np.frombuffer(b, dtype=np.int16).astype(np.float32) / 32768.0
            if not len(chunk):
                continue
            rms = float(np.sqrt(np.mean(chunk ** 2)))
            dur = len(chunk) / SR
            if rms > THRESH:
                started = True; trailing = 0.0; seg.extend(chunk.tolist())
            elif started:
                seg.extend(chunk.tolist()); trailing += dur
            cur = len(seg) / SR
            if started and (trailing >= SIL or cur >= MAXSEG):
                await flush()
            elif started and cur - last_partial >= 1.5:   # occasional interim update while still speaking
                last_partial = cur
                await ws.send_json({"partial": (await do(seg))[0]})
    except Exception:
        pass
    try:
        await flush()
    except Exception:
        pass


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
            "my_lm_backend": "kenlm" if (_kenlm_decoder() if os.environ.get("SCRIBE_MY_LM") == "1" else None) else "python",
            "my_quant": os.environ.get("SCRIBE_MY_QUANT", "1") == "1",
            "my_snap": os.environ.get("SCRIBE_MY_SNAP", "1") == "1",
            "my_semantic": os.environ.get("SCRIBE_MY_SEMANTIC", "1") == "1",
            "my_candidates": len(_care_phrases()),
            "my_translate": "gemini" if os.environ.get("GEMINI_API_KEY", "").strip() else ("openai" if os.environ.get("OPENAI_API_KEY", "").strip() else "google"),
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
            snap = _snap_care(transcript, target)   # known care phrase -> verified clean text + translation
            if snap:
                return {"transcript": snap[0], "translation": snap[1]}
            translation = ""
            if target and target != "off" and target != src:
                translation = _translate_my(transcript, target)   # Gemini if GEMINI_API_KEY else Google
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
