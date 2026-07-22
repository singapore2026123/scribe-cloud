# MMS Burmese fine-tuning (KWSH care speech)

Improve the Space's **primary Burmese engine** (MMS `facebook/mms-1b-all`, `mya` adapter) on real
care-home speech — **overall accuracy, not just numbers.** Baseline on KWSH Recording 17: **74.4% char /
51.4% digit accuracy** (beats Dolphin 56.1/37.1 and Whisper ~0). The stock `mya` adapter was trained on
generic Burmese (religious-text readings), so it's off-distribution for elderly-care vocabulary,
conversational style, and Karen-accented Burmese. Numbers are the single worst sub-case, but the goal is
to lift the whole thing: care vocabulary, real speakers, and spontaneous phrasing — with numbers as one
facet, not the only target.

MMS is built for **adapter fine-tuning**: the 1B base stays frozen; only the ~2.3M-param `mya` adapter
(+ CTC head) trains. Cheap, and you ship just the adapter.

## Two-tier data strategy

| Tier | Source | Use |
|---|---|---|
| **Mass-produced, in-domain** | KWSH recordings + verified transcripts → `align_to_dataset.py` (forced alignment) | **Fine-tune** on this |
| **General yardstick** | OpenSLR SLR80 (`../eval/slr80_eval.py`) | **Eval only** — do NOT fine-tune on it |

> ⚠️ SLR80 is single-gender clean studio read speech. `../eval/README.md` warns it is **not**
> representative of care-home Burmese and fine-tuning on it "would likely hurt real-world accuracy."
> We keep it strictly as a regression yardstick: if fine-tuning helps in-domain but worsens SLR80,
> that's domain over-fit.

## Pipeline

```
# 1. Build / grow the training set --------------------------------------------
#    (a) from the matrix reading (already produced 60 clips):
python build_dataset.py
#    (b) MASS-PRODUCE more from any transcribed recording (forced alignment):
python align_to_dataset.py --wav "New Recording 17.wav" --phrases matrix --source rec17
python align_to_dataset.py --wav "<new session>.wav"     --phrases phrases.txt --source sess02
#        phrases.txt = one verified reference line per utterance, in spoken order.

# 2. Baseline eval (before) ---------------------------------------------------
python eval_mms.py                       # base model on the held-out val clips

# 3. Fine-tune the mya adapter ------------------------------------------------
$env:EPOCHS=15; python train_mms.py      # writes finetune_data/mms_mya_finetuned/

# 4. Eval (after) + regression guard ------------------------------------------
python eval_mms.py --model "G:\...\finetune_data\mms_mya_finetuned"   # in-domain
python ../eval/slr80_eval.py --limit 30                               # general Burmese didn't regress?
```

Data + checkpoints live under `…/Recordings/finetune_data/` (on the Drive, not in git):
`clips/*.wav`, `manifest.csv` (path,text,dur,align_cer,source,split), `mms_mya_finetuned/`.

## How to grow the data (the real lever)

Accuracy moves with **in-domain data**, and we currently have only **60 clips from ONE speaker
(Recording 17)** — a proof-of-pipeline, not enough to shift real-world accuracy. For **overall** Burmese
ASR (not just numbers), the levers in priority order:

1. **More SPEAKERS reading the phrases — the #1 lever.** A model trained on one voice won't generalize.
   Have several Burmese-speaking staff each read the comprehensive phrase set (`phrases.txt`, which already
   spans the whole care domain: meals, bathing, medication, vitals, mobility, wound care, cognition,
   handover, infection control). Diverse voices/accents matter more than more phrases from one voice.
2. **Broader vocabulary** — add real care phrases beyond the 60 as they come up (a Burmese speaker writes
   them; don't synthesize). Comprehensive coverage lifts overall accuracy.
3. **Spontaneous speech** for conversational realism — recs 18–21 etc.: correct the MMS draft per interval
   in Praat (a Burmese speaker), export as a `phrases.txt`, then `align_to_dataset.py`. This is the
   human-in-the-loop loop; it's what teaches natural phrasing (read speech alone won't).
4. **Numbers** are one facet — they need real spoken audio (scripted readings cover this; TTS cannot,
   see `tts_augment.py`). Don't over-weight them at the expense of breadth.
5. **Acoustic variety** — different rooms, devices, background noise.

Re-run steps 1→4 of the pipeline as data grows. Watch in-domain CER **and** SLR80 (regression guard).

## Honest limits

- **Numbers won't fix from 13 number-phrases.** Digit accuracy needs many more vitals examples.
- **CPU is too slow for a full run** of a 1B base (even adapter-only). Use a GPU (or a long overnight
  CPU run). The trainer's `MAX_STEPS=2` smoke mode verifies the loop without a full train.
- **Overfit risk** on 60 clips — hence the val split + the SLR80 regression check.
- Alignment timestamps come from MMS itself, so clip boundaries are approximate (±~0.2s padding added).

## Deploy a fine-tuned adapter

After training, point the Space at the fine-tuned checkpoint: either replace the `mya` adapter file in
`hf-space` model loading, or set the model path in `_mms_model()` (`hf-space/app.py`) to the fine-tuned
dir. Re-run the SLR80 eval against the Space before/after to confirm the gain in production.
