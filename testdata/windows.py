import json, sys
d = json.load(open(sys.argv[1]))
print(d['text'][:600])
W = d['words']
for s in range(0, int(d['duration_s']), 60):
    ws = [w for w in W if s <= w['start'] < s + 120]
    sw = sum(1 for a, b in zip(ws, ws[1:]) if a['speaker'] != b['speaker'])
    print(s, len(ws), sw, sorted({w['speaker'] for w in ws if w['speaker']}))
