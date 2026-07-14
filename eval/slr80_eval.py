#!/usr/bin/env python3
"""Burmese ASR accuracy benchmark for the Scribe Space, using OpenSLR SLR80.

SLR80 = Google's free crowd-sourced Burmese speech corpus (LREC 2020, Gutkin et al.;
CC BY-SA 4.0), https://openslr.org/80 . 2,528 female-speaker read-speech clips with
hand-curated Burmese transcripts. We run each clip through the Space /transcribe
(src=my, target=off) and report CER vs the reference. This is an EVAL set only, NOT a
fine-tune set (single-gender, clean studio read speech != conversational care audio).

Metric: character error rate with whitespace removed from BOTH sides (cer_nospace),
because Burmese word boundaries are subjective and Dolphin emits unsegmented text —
so a raw word-level WER would be meaninglessly high. Both sides are NFC-normalized,
matching the Space's own normalization pass.

Usage (PowerShell):
  # auto-download the corpus (~large; one-time) then eval 30 random clips:
  python slr80_eval.py --space-url https://singapore2026123-scribe-burmese-asr.hf.space --limit 30
  # reuse an already-extracted corpus dir (skip download):
  python slr80_eval.py --data-dir ./slr80 --limit 30
  # full run (slow: the free Space is ~30s/clip):
  python slr80_eval.py --limit 0

Only the Python standard library is required.
"""
import argparse
import base64
import csv
import json
import os
import sys
import time
import unicodedata
import urllib.request
import zipfile

SLR80_BASE = "https://www.openslr.org/resources/80/"
ZIP_NAME = "my_mm_female.zip"
INDEX_NAME = "line_index_female.tsv"
DEFAULT_SPACE = "https://singapore2026123-scribe-burmese-asr.hf.space"


def nfc(s):
    return unicodedata.normalize("NFC", (s or "").strip())


def _strip_ws(s):
    return "".join(nfc(s).split())


def cer_nospace(ref, hyp):
    """Character error rate with whitespace removed from both sides (Levenshtein / len(ref))."""
    r = _strip_ws(ref)
    h = _strip_ws(hyp)
    if not r:
        return 0.0 if not h else 1.0
    # two-row Levenshtein (O(len(r)) memory)
    prev = list(range(len(h) + 1))
    for i, rc in enumerate(r, 1):
        cur = [i] + [0] * len(h)
        for j, hc in enumerate(h, 1):
            cost = 0 if rc == hc else 1
            cur[j] = min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost)
        prev = cur
    return prev[len(h)] / len(r)


def download(url, dest):
    if os.path.exists(dest) and os.path.getsize(dest) > 0:
        print("  cached: %s" % dest)
        return
    print("  downloading %s -> %s" % (url, dest))
    tmp = dest + ".part"
    with urllib.request.urlopen(url, timeout=120) as r, open(tmp, "wb") as f:
        total = int(r.headers.get("Content-Length", 0))
        got = 0
        while True:
            chunk = r.read(1 << 20)
            if not chunk:
                break
            f.write(chunk)
            got += len(chunk)
            if total:
                sys.stdout.write("\r  %.1f / %.1f MB" % (got / 1e6, total / 1e6))
                sys.stdout.flush()
    sys.stdout.write("\n")
    os.replace(tmp, dest)


def ensure_corpus(data_dir):
    """Return (wav_dir, index_path), downloading + extracting SLR80 if needed."""
    os.makedirs(data_dir, exist_ok=True)
    index_path = os.path.join(data_dir, INDEX_NAME)
    if not os.path.exists(index_path):
        download(SLR80_BASE + INDEX_NAME, index_path)
    # wav files land somewhere under data_dir after extraction; detect a directory that has *.wav
    def find_wavs():
        for root, _dirs, files in os.walk(data_dir):
            if any(fn.lower().endswith(".wav") for fn in files):
                return root
        return None
    wav_dir = find_wavs()
    if wav_dir is None:
        zip_path = os.path.join(data_dir, ZIP_NAME)
        download(SLR80_BASE + ZIP_NAME, zip_path)
        print("  extracting %s ..." % ZIP_NAME)
        with zipfile.ZipFile(zip_path) as z:
            z.extractall(data_dir)
        wav_dir = find_wavs()
    if wav_dir is None:
        raise SystemExit("no .wav files found under %s after extraction" % data_dir)
    return wav_dir, index_path


def read_index(index_path):
    """Map utterance-id -> reference transcript. Handles 2- or 3-column TSV (id ... text)."""
    refs = {}
    with open(index_path, encoding="utf-8") as f:
        for line in f:
            parts = [p.strip() for p in line.rstrip("\n").split("\t") if p.strip()]
            if len(parts) < 2:
                continue
            refs[parts[0]] = parts[-1]
    return refs


def index_wavs(wav_dir):
    out = {}
    for root, _dirs, files in os.walk(wav_dir):
        for fn in files:
            if fn.lower().endswith(".wav"):
                out[os.path.splitext(fn)[0]] = os.path.join(root, fn)
    return out


def transcribe(space_url, wav_path):
    with open(wav_path, "rb") as f:
        b64 = base64.b64encode(f.read()).decode("ascii")
    body = json.dumps({"audio": b64, "src": "my", "target": "off"}).encode("utf-8")
    req = urllib.request.Request(
        space_url.rstrip("/") + "/transcribe",
        data=body,
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=180) as r:
        return json.loads(r.read().decode("utf-8")).get("transcript", "")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--space-url", default=DEFAULT_SPACE)
    ap.add_argument("--data-dir", default=os.path.join(os.path.dirname(os.path.abspath(__file__)), "slr80"))
    ap.add_argument("--limit", type=int, default=30, help="clips to eval (0 = all; deterministic first-N by id)")
    ap.add_argument("--out", default=None, help="results CSV (default: <data-dir>/slr80_results.csv)")
    args = ap.parse_args()

    print("SLR80 Burmese ASR eval")
    print("  space: %s" % args.space_url)
    wav_dir, index_path = ensure_corpus(args.data_dir)
    refs = read_index(index_path)
    wavs = index_wavs(wav_dir)
    ids = sorted(k for k in refs if k in wavs)
    if not ids:
        raise SystemExit("no overlap between line-index ids and .wav files")
    if args.limit and args.limit > 0:
        ids = ids[: args.limit]
    out_path = args.out or os.path.join(args.data_dir, "slr80_results.csv")
    print("  clips: %d (of %d transcribed refs)  ~30s/clip on the free Space" % (len(ids), len(refs)))

    rows = []
    scores = []
    t0 = time.time()
    for n, uid in enumerate(ids, 1):
        try:
            hyp = transcribe(args.space_url, wavs[uid])
        except Exception as e:
            print("  [%d/%d] %s  ERROR %s" % (n, len(ids), uid, e))
            continue
        c = cer_nospace(refs[uid], hyp)
        scores.append(c)
        rows.append({"id": uid, "ref": nfc(refs[uid]), "hyp": nfc(hyp), "cer_nospace": "%.4f" % c})
        print("  [%d/%d] %s  CER=%.3f" % (n, len(ids), uid, c))

    with open(out_path, "w", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=["id", "ref", "hyp", "cer_nospace"])
        w.writeheader()
        w.writerows(rows)

    if scores:
        scores_sorted = sorted(scores)
        mean = sum(scores) / len(scores)
        median = scores_sorted[len(scores_sorted) // 2]
        print("\n== RESULTS ==")
        print("  clips scored : %d" % len(scores))
        print("  mean CER     : %.3f" % mean)
        print("  median CER   : %.3f" % median)
        print("  best / worst : %.3f / %.3f" % (scores_sorted[0], scores_sorted[-1]))
        print("  elapsed      : %.0fs" % (time.time() - t0))
        print("  written      : %s" % out_path)
    else:
        print("no clips scored")


if __name__ == "__main__":
    main()
