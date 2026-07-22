# -*- coding: utf-8 -*-
"""Pure-Python Zawgyi -> Unicode converter (Rabbit zg2uni rules, 118 sequential regex
subs). Rules downloaded from Rabbit-Converter/Rabbit and stored in zg2uni_rules.json.
Validated with Google's myanmartools ZawgyiDetector (P 1.0 -> 0.0)."""
import json, re, os

_RULES_PATH = os.path.join(os.path.dirname(__file__), "zg2uni_rules.json")
_COMPILED = None

def _load():
    global _COMPILED
    if _COMPILED is None:
        rules = json.load(open(_RULES_PATH, encoding="utf-8"))
        _COMPILED = [(re.compile(r["from"]), re.sub(r"\$(\d)", r"\\\1", r["to"])) for r in rules]
    return _COMPILED

def zg2uni(text):
    if not text:
        return text
    for pat, rep in _load():
        text = pat.sub(rep, text)
    return text
