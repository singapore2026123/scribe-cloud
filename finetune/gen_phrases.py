# -*- coding: utf-8 -*-
"""Generate phrases.txt for staff to read aloud (-> align_to_dataset.py -> training clips).
= the 60 verified matrix phrases + many NUMBER-DRILL variants (the 47%-accuracy weak spot).

Number drills are made by swapping ONLY the Burmese numerals inside verified vitals/meal sentences
(numerals map 1:1 to ASCII and vitals are read as plain digits + unit -> no grammar agreement, so the
Burmese words stay exactly as a human already verified them). Deterministic (no RNG) -> reproducible.
"""
import os, io, re
REC=r"G:\My Drive\Singapore-PoC\poc-multilingual-voice\Recordings"
REFP=os.path.join(REC,"transcripts","REFERENCE_burmese_from_matrix.txt")
OUT=os.path.join(os.path.dirname(__file__),"phrases.txt")

ASCII2BUR={ord(str(k)):0x1040+k for k in range(10)}
def bur(n): return str(n).translate(ASCII2BUR)
NUMRUN=re.compile(r'[၀-၉]+')

# load matrix phrases by row
phrases={}
for l in io.open(REFP,encoding="utf-8").read().splitlines():
    if "]" not in l: continue
    row=l.split("]",1)[0].replace("[row","").strip()
    phrases[row]=l.split("]",1)[1].split("\t")[0].strip()

def variants(row, slot_values, n):
    """Split the row's phrase on numeral-runs and refill the slots from slot_values (list of value-lists)."""
    tmpl=phrases.get(row)
    if not tmpl: return []
    parts=NUMRUN.split(tmpl)
    if len(parts)-1 != len(slot_values):
        return []   # slot count mismatch -> skip (guard against a changed reference)
    out=[]
    for i in range(n):
        vals=[sv[(i*(3+k)) % len(sv)] for k,sv in enumerate(slot_values)]   # coprime-ish strides -> varied combos
        s=parts[0]
        for k,v in enumerate(vals): s+=bur(v)+parts[k+1]
        out.append(s)
    return out

# row2 vitals: [temp_whole, temp_frac, systolic, diastolic, heart_rate, spo2]
V2=[[35,36,36,36,37,37,38],[0,2,4,6,8,1,3,5,7,9],
    [105,110,118,122,128,132,138,145,152,158,162,140],[62,68,70,72,76,78,80,82,85,88,90,95],
    [55,60,66,72,76,80,84,88,92,98,104,110],[100,99,98,97,96,95,94,99,98,100]]
# row4 meal: [rice%, dish%, soup%, water_ml]
V4=[[100,90,80,70,60,50,40,30],[100,90,80,60,50,40,30,20],[100,80,60,50,40,30,100,70],
    [50,80,100,120,150,180,200,60]]
# row28 blood sugar + insulin: [glucose, insulin_units]
V28=[[88,102,116,124,138,145,162,180,196,210],[2,3,4,5,6,8,10,4,6,2]]

lines=[]
lines += [phrases[k] for k in sorted(phrases, key=lambda x:(len(x),x))]   # 60 originals
lines += variants("2", V2, 40)     # vitals drill
lines += variants("4", V4, 20)     # meal-percentage drill
lines += variants("28", V28, 12)   # glucose/insulin drill

# de-dupe, keep order
seen=set(); final=[]
for l in lines:
    if l and l not in seen: seen.add(l); final.append(l)

io.open(OUT,"w",encoding="utf-8").write("\n".join(final)+"\n")
print(f"wrote {len(final)} phrases -> {OUT}")
print(f"  60 verified matrix phrases + {len(final)-len([1 for _ in phrases])} number-drill variants")
print("sample vitals drills:")
for l in variants("2",V2,3): print("  ", l)
