# -*- coding: utf-8 -*-
"""Prepare training data for MMS fine-tuning.

For recordings that match care_phrases.json (from the test matrix),
auto-labels them with the known ground-truth Burmese text.
For unmatched recordings, outputs them for manual transcription.

Usage:
  python prepare_data.py --recordings_dir "G:\\My Drive\\...\\miko recordings"
                         --care_phrases "hf-space/care_phrases.json"
                         --matrix "G:\\My Drive\\...\\Multilingual-Voice-Translation-Test-Matrix_NH-expanded.xlsx"
                         --output_dir ./data
"""
import argparse, json, os, glob, sys
sys.stdout.reconfigure(encoding="utf-8")


def parse_args():
    p = argparse.ArgumentParser()
    p.add_argument("--recordings_dir", required=True)
    p.add_argument("--care_phrases", default="hf-space/care_phrases.json")
    p.add_argument("--matrix", help="Excel matrix file for auto-labeling")
    p.add_argument("--output_dir", default="./data")
    return p.parse_args()


def main():
    args = parse_args()
    os.makedirs(args.output_dir, exist_ok=True)

    phrases = json.load(open(args.care_phrases, encoding="utf-8"))
    print(f"Loaded {len(phrases)} care phrases")

    audio_files = sorted(
        glob.glob(os.path.join(args.recordings_dir, "*.m4a")) +
        glob.glob(os.path.join(args.recordings_dir, "*.wav"))
    )
    print(f"Found {len(audio_files)} audio files")

    labeled = []
    unlabeled = []

    if args.matrix:
        try:
            import openpyxl
            wb = openpyxl.load_workbook(args.matrix, read_only=True)
            ws = wb.active
            matrix_burmese = {}
            for row in ws.iter_rows(min_row=2, values_only=True):
                if row and len(row) >= 5 and row[4]:
                    rec_num = row[0] if isinstance(row[0], int) else None
                    burmese_text = str(row[4]).strip()
                    if rec_num and burmese_text:
                        matrix_burmese[rec_num] = burmese_text
            print(f"Matrix entries with Burmese text: {len(matrix_burmese)}")
        except Exception as e:
            print(f"Could not read matrix: {e}")
            matrix_burmese = {}
    else:
        matrix_burmese = {}

    import re
    for path in audio_files:
        fname = os.path.basename(path)
        match = re.search(r'(\d+)', fname)
        if not match:
            unlabeled.append(path)
            continue
        rec_num = int(match.group(1))

        if rec_num in matrix_burmese:
            labeled.append({"audio": path, "text": matrix_burmese[rec_num]})
        else:
            for p in phrases:
                my = p.get("my", "").strip()
                if my and rec_num <= len(phrases):
                    labeled.append({"audio": path, "text": my})
                    break
            else:
                unlabeled.append(path)

    print(f"\nAuto-labeled: {len(labeled)}")
    print(f"Need manual transcription: {len(unlabeled)}")

    if labeled:
        split = max(1, int(len(labeled) * 0.85))
        train = labeled[:split]
        eval_set = labeled[split:]

        with open(os.path.join(args.output_dir, "train.jsonl"), "w", encoding="utf-8") as f:
            for e in train:
                f.write(json.dumps(e, ensure_ascii=False) + "\n")

        with open(os.path.join(args.output_dir, "eval.jsonl"), "w", encoding="utf-8") as f:
            for e in eval_set:
                f.write(json.dumps(e, ensure_ascii=False) + "\n")

        print(f"Written: train.jsonl ({len(train)}), eval.jsonl ({len(eval_set)})")

    if unlabeled:
        with open(os.path.join(args.output_dir, "needs_transcription.txt"), "w", encoding="utf-8") as f:
            for path in unlabeled:
                f.write(path + "\n")
        print(f"Written: needs_transcription.txt ({len(unlabeled)} files)")

    print(f"\nNext steps:")
    print(f"  1. Manually transcribe files in needs_transcription.txt")
    print(f"  2. Add them to train.jsonl")
    print(f"  3. Run: python finetune_mms_burmese.py --data_dir {args.output_dir}")


if __name__ == "__main__":
    main()
