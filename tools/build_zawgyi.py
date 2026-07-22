# -*- coding: utf-8 -*-
"""Download the canonical Rabbit zg2uni rules (public GitHub raw) -> save authoritative
local copy -> build a pure-Python Zawgyi->Unicode converter -> validate on the app's
master-data Burmese column with Google's ZawgyiDetector. No transcription by hand."""
import json, re, os, sys, urllib.request

RULES_URL = "https://raw.githubusercontent.com/Rabbit-Converter/Rabbit/master/source/rule/zg2uni.json"
RULES_PATH = os.path.join(os.path.dirname(__file__), "zg2uni_rules.json")

def fetch_rules():
    try:
        with urllib.request.urlopen(RULES_URL, timeout=30) as r:
            data = r.read().decode("utf-8")
        rules = json.loads(data)
        with open(RULES_PATH, "w", encoding="utf-8") as f:
            json.dump(rules, f, ensure_ascii=False, indent=1)
        print(f"downloaded {len(rules)} rules -> {RULES_PATH}")
        return rules
    except Exception as e:
        print(f"download failed ({e}); using local {RULES_PATH}")
        return json.load(open(RULES_PATH, encoding="utf-8"))

def build_converter(rules):
    compiled = []
    for r in rules:
        pat = re.compile(r["from"])
        rep = re.sub(r"\$(\d)", r"\\\1", r["to"])   # JS $1 -> Python \1
        compiled.append((pat, rep))
    def convert(text):
        for pat, rep in compiled:
            text = pat.sub(rep, text)
        return text
    return convert

def main():
    rules = fetch_rules()
    zg2uni = build_converter(rules)

    # validate with Google's detector: P(zawgyi) should be HIGH before, LOW after.
    try:
        from myanmartools import ZawgyiDetector
        det = ZawgyiDetector()
        score = lambda s: det.get_zawgyi_probability(s)
    except Exception as e:
        print("detector unavailable:", e); score = None

    samples = [
        "လက္ေတြ႔အေကာင္အထည္ေဖာ္မႈ",  # app: 実施記録
        "အည္စ္အေကြးစွန္႔ြင္း",  # app: 排泄 (Excretion)
        "အသုံးြပုသူအမည္",  # app: 利用者名 (User name)
    ]
    for s in samples:
        u = zg2uni(s)
        if score:
            print(f"\nZG P={score(s):.3f} -> UNI P={score(u):.3f}")
        print("  in :", s)
        print("  out:", u)

if __name__ == "__main__":
    main()
