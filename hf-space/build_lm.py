# -*- coding: utf-8 -*-
"""Build a character-level kenlm ARPA model from the Burmese corpus.
Run at Docker build time: python build_lm.py
Produces burmese_char.arpa (loaded by app.py for CTC beam search)."""
import os, subprocess, tempfile

CORPUS = os.path.join(os.path.dirname(__file__), "burmese_lm_corpus.txt")
ARPA = os.path.join(os.path.dirname(__file__), "burmese_char.arpa")
ORDER = 5

lines = [l.strip() for l in open(CORPUS, encoding="utf-8") if l.strip()]
char_lines = [" ".join(list(l)) for l in lines]

with tempfile.NamedTemporaryFile("w", suffix=".txt", delete=False, encoding="utf-8") as f:
    f.write("\n".join(char_lines) + "\n")
    char_corpus = f.name

try:
    subprocess.run(
        ["lmplz", "-o", str(ORDER), "--text", char_corpus, "--arpa", ARPA, "--discount_fallback"],
        check=True, capture_output=True, text=True
    )
    print(f"built {ARPA} ({ORDER}-gram, {len(lines)} lines, {os.path.getsize(ARPA)//1024}KB)")
except FileNotFoundError:
    print("lmplz not found (kenlm not installed with CLI); skipping ARPA build")
except subprocess.CalledProcessError as e:
    print(f"lmplz failed: {e.stderr[:200]}")
finally:
    os.unlink(char_corpus)
