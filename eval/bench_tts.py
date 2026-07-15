#!/usr/bin/env python3
"""Run the poc-multilingual-voice TTS clips through the live Scribe pipeline and score them.

For each audio clip: route to the correct ASR (JA/MS -> Cloudflare Worker Whisper;
MM/ZH -> HF Space Dolphin), capture transcript + English translation, and compute CER
vs the reference transcript. Writes a UTF-8 CSV that gets uploaded to Drive as a Sheet.

References:
  JA scenario  <- phrases_source.csv          (Japanese Phrase, by audio filename)
  MM/MS scenario <- phrases_draft_MM_MS.csv    (Myanmar/Malay Phrase, by ID -> <ID>_MM/_MS.wav)
  ZH glossary  <- validation/tts_manifest.csv  (text, by audio basename)

Usage (PowerShell):
  python bench_tts.py --langs ja,ms
  python bench_tts.py --langs my --zh-limit 0
  python bench_tts.py --langs zh --zh-limit 20
Routing needs the Worker (always up) and, for my/zh, the HF Space to be running.
"""
import argparse
import base64
import csv
import json
import os
import time
import unicodedata
import urllib.request

POC = r"G:\My Drive\Singapore-PoC\poc-multilingual-voice"
WORKER = "https://scribe-cloud.singapore2026123.workers.dev/transcribe"
SPACE = "https://singapore2026123-scribe-burmese-asr.hf.space/transcribe"
FOLDER = {"ja": "日本語", "ms": "マレー・ミャンマー語", "my": "マレー・ミャンマー語", "zh": "中国語"}
ROUTE = {"ja": WORKER, "ms": WORKER, "my": SPACE, "zh": SPACE}


def nfc(s):
    return unicodedata.normalize("NFC", (s or "").strip())


def cer_nospace(ref, hyp):
    r = "".join(nfc(ref).split())
    h = "".join(nfc(hyp).split())
    if not r:
        return "" if not h else 1.0
    prev = list(range(len(h) + 1))
    for i, rc in enumerate(r, 1):
        cur = [i] + [0] * len(h)
        for k, hc in enumerate(h, 1):
            cur[k] = min(prev[k] + 1, cur[k - 1] + 1, prev[k - 1] + (0 if rc == hc else 1))
        prev = cur
    return round(prev[len(h)] / len(r), 3)


def read_csv(path):
    with open(path, encoding="utf-8-sig") as f:
        return list(csv.DictReader(f))


def build_refs():
    """basename(lower) -> {lang, ref, group, category}"""
    refs = {}
    # JA scenario
    for r in read_csv(os.path.join(POC, "phrases_source.csv")):
        fn = (r.get("Audio File Name") or "").strip()
        if fn.endswith("_JA.wav"):
            refs[fn.lower()] = {"lang": "ja", "ref": (r.get("Japanese Phrase") or "").strip(),
                                "group": "scenario", "category": fn.split("-")[0]}
    # MM + MS scenario (by ID -> <ID>_MM/_MS.wav)
    for r in read_csv(os.path.join(POC, "phrases_draft_MM_MS.csv")):
        rid = (r.get("ID") or "").strip()
        cat = (r.get("Category") or (rid.split("-")[0] if rid else "")).strip()
        if r.get("Myanmar Phrase"):
            refs[(rid + "_MM.wav").lower()] = {"lang": "my", "ref": r["Myanmar Phrase"].strip(), "group": "scenario", "category": cat}
        if r.get("Malay Phrase"):
            refs[(rid + "_MS.wav").lower()] = {"lang": "ms", "ref": r["Malay Phrase"].strip(), "group": "scenario", "category": cat}
    # ZH glossary (manifest)
    man = os.path.join(POC, "validation", "tts_manifest.csv")
    if os.path.exists(man):
        for r in read_csv(man):
            af = (r.get("audio_file") or "").strip()
            if (r.get("language") or "").upper() == "ZH" and af:
                base = os.path.basename(af)
                refs[base.lower()] = {"lang": "zh", "ref": (r.get("text") or "").strip(),
                                      "group": base.split("_row")[0] if "_row" in base else "zh", "category": "term"}
    return refs


def transcribe(url, path, src):
    with open(path, "rb") as f:
        b64 = base64.b64encode(f.read()).decode("ascii")
    body = json.dumps({"audio": b64, "src": src, "target": "en"}).encode("utf-8")
    req = urllib.request.Request(url, data=body, headers={
        "Content-Type": "application/json",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",   # Cloudflare bot-filter 403s Python-urllib's default UA
    })
    with urllib.request.urlopen(req, timeout=240) as r:
        d = json.loads(r.read().decode("utf-8"))
    return d.get("transcript", ""), d.get("translation", ""), d.get("error", "")


# --- ElevenLabs Scribe STT engine (alternative to Worker/Space) — key comes from env ELEVENLABS_API_KEY, never a file ---
EL_LANG = {"ja": "jpn", "ms": "msa", "my": "mya", "zh": "zho", "ta": "tam", "en": "eng"}  # Scribe accepts ISO-639-3


def _multipart(fields, filename, filebytes):
    boundary = "----scribebenchboundary7f3a2b"
    crlf = "\r\n"
    parts = []
    for k, v in fields.items():
        parts.append("--%s%sContent-Disposition: form-data; name=\"%s\"%s%s%s" % (boundary, crlf, k, crlf, crlf, v))
    body = crlf.join(parts).encode("utf-8") + crlf.encode()
    body += ("--%s%sContent-Disposition: form-data; name=\"file\"; filename=\"%s\"%sContent-Type: application/octet-stream%s%s"
             % (boundary, crlf, filename, crlf, crlf, crlf)).encode("utf-8")
    body += filebytes + crlf.encode() + ("--%s--%s" % (boundary, crlf)).encode()
    return boundary, body


def el_transcribe(path, lang, key):
    fields = {"model_id": "scribe_v1", "language_code": EL_LANG.get(lang, lang), "diarize": "false", "tag_audio_events": "false"}
    with open(path, "rb") as f:
        boundary, body = _multipart(fields, os.path.basename(path), f.read())
    req = urllib.request.Request("https://api.elevenlabs.io/v1/speech-to-text", data=body,
                                 headers={"xi-api-key": key, "Content-Type": "multipart/form-data; boundary=" + boundary})
    with urllib.request.urlopen(req, timeout=180) as r:
        d = json.loads(r.read().decode("utf-8"))
    return d.get("text", ""), "", ""   # Scribe is STT only (no translation)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--langs", default="ja,ms,my,zh")
    ap.add_argument("--zh-limit", type=int, default=24, help="cap ZH clips (0 = all)")
    ap.add_argument("--engine", default="scribe", choices=["scribe", "elevenlabs"], help="scribe = Worker/Space; elevenlabs = ElevenLabs Scribe STT")
    ap.add_argument("--out", default=None)
    args = ap.parse_args()
    if args.out is None:
        args.out = os.path.join(POC, "tts_asr_results_elevenlabs.csv" if args.engine == "elevenlabs" else "tts_asr_results.csv")
    el_key = os.environ.get("ELEVENLABS_API_KEY", "")
    if args.engine == "elevenlabs" and not el_key:
        raise SystemExit("set ELEVENLABS_API_KEY in the environment")
    langs = [x.strip() for x in args.langs.split(",") if x.strip()]
    refs = build_refs()

    # collect audio files per requested language, keyed off the folder + filename suffix
    jobs = []
    for lang in langs:
        folder = os.path.join(POC, FOLDER[lang])
        if not os.path.isdir(folder):
            continue
        for fn in sorted(os.listdir(folder)):
            low = fn.lower()
            if not low.endswith((".wav", ".mp3")):
                continue
            flang = ({"_ja": "ja", "_mm": "my", "_ms": "ms", "_zh": "zh"}).get(low[-7:-4], None)
            if flang != lang:
                continue
            meta = refs.get(low, {"lang": lang, "ref": "", "group": "", "category": ""})
            jobs.append({"file": fn, "path": os.path.join(folder, fn), "lang": lang, **{k: meta.get(k, "") for k in ("ref", "group", "category")}})
    # cap ZH
    if args.zh_limit > 0:
        zh = [j for j in jobs if j["lang"] == "zh"]
        keep = set(id(j) for j in zh[: args.zh_limit])
        jobs = [j for j in jobs if j["lang"] != "zh" or id(j) in keep]

    print("clips: %d  (%s)" % (len(jobs), ", ".join("%s=%d" % (l, sum(1 for j in jobs if j["lang"] == l)) for l in langs)))
    cols = ["audio_file", "language", "group", "category", "reference", "transcript", "translation", "cer_nospace", "seconds", "error"]
    # resume-friendly: keep any existing rows for files we're not re-running
    existing = {}
    if os.path.exists(args.out):
        for r in read_csv(args.out):
            existing[r["audio_file"]] = r
    for n, jb in enumerate(jobs, 1):
        t0 = time.time()
        tr, tl, err = "", "", ""
        try:
            if args.engine == "elevenlabs":
                tr, tl, err = el_transcribe(jb["path"], jb["lang"], el_key)
            else:
                tr, tl, err = transcribe(ROUTE[jb["lang"]], jb["path"], jb["lang"])
        except Exception as e:
            err = str(e)
        sec = round(time.time() - t0, 1)
        cer = cer_nospace(jb["ref"], tr) if jb["ref"] else ""
        existing[jb["file"]] = {"audio_file": jb["file"], "language": jb["lang"], "group": jb["group"],
                                "category": jb["category"], "reference": jb["ref"], "transcript": tr,
                                "translation": tl, "cer_nospace": cer, "seconds": sec, "error": err}
        print("[%d/%d] %-22s %-3s %5ss cer=%s %s" % (n, len(jobs), jb["file"], jb["lang"], sec, cer, ("ERR " + err) if err else ""))
        with open(args.out, "w", encoding="utf-8-sig", newline="") as f:   # flush every row
            w = csv.DictWriter(f, fieldnames=cols)
            w.writeheader()
            for row in existing.values():
                w.writerow(row)
    # summary
    print("\n== mean CER by language (scored clips only) ==")
    for lang in langs:
        vals = [float(r["cer_nospace"]) for r in existing.values() if r["language"] == lang and r["cer_nospace"] not in ("", None)]
        if vals:
            print("  %-3s  mean %.3f  (n=%d)" % (lang, sum(vals) / len(vals), len(vals)))
    print("written: %s" % args.out)


if __name__ == "__main__":
    main()
