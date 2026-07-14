# Burmese ASR eval (OpenSLR SLR80)

Objective accuracy benchmark for the Space's Burmese path. Until now we've had **no
measured Burmese WER/CER** — this gives a repeatable number so we can tell whether a
change (e.g. the NFC/Zawgyi normalization, a glossary edit, or a future paid ASR) actually
helps instead of eyeballing it.

## What it uses

- **OpenSLR SLR80** — Google's free Burmese speech corpus (LREC 2020, Gutkin et al.,
  CC BY-SA 4.0): 2,528 female-speaker clips with hand-curated Burmese transcripts.
- **Eval set only, not a fine-tune set.** It's single-gender, clean *studio read speech* —
  useful as a fixed yardstick, but it is **not** representative of elderly care-home
  conversational Burmese, so do not fine-tune Dolphin on it (would likely hurt real-world
  accuracy).

## Metric

`cer_nospace` = character error rate with whitespace removed from both reference and
hypothesis, both NFC-normalized. Burmese word boundaries are subjective and Dolphin emits
unsegmented text, so a word-level WER would be meaninglessly high; CER-no-space is the fair
comparison (and matches how the project's earlier `cer_*` benchmarks were computed).

## Run (PowerShell)

```powershell
cd C:\Users\kanamic\Projects\voice-pipeline\scribe-cloud\eval
# one-time corpus download (large) + eval 30 random-ish clips:
python slr80_eval.py --space-url https://singapore2026123-scribe-burmese-asr.hf.space --limit 30
```

- Stdlib only — no `pip install`.
- **Slow:** the free HF Space is ~30s/clip, so `--limit 30` ~= 15 min. Use a small limit
  first; `--limit 0` runs the whole set.
- First call also wakes the Space (cold start) if it was asleep.
- Results are written to `slr80/slr80_results.csv` (id, ref, hyp, cer_nospace) plus a mean/
  median summary on stdout.
- `--data-dir <dir>` reuses an already-extracted corpus and skips the download.

## Note on the normalization change

`hf-space/app.py` now runs a Zawgyi→Unicode + NFC pass before the glossary/number passes.
To measure its effect, run this eval **after re-uploading `app.py` to the Space** (the Space
is manual-upload, not GitHub-linked), and compare the mean CER to a run against the old code.
