"""Peak memory from a gpumon2.sh log: python gpupeak.py log"""
import sys
rows = [list(map(float, l.split())) for l in open(sys.argv[1]) if len(l.split()) == 5]
cap = 24576
for i, name in ((1, "GPU0 total"), (2, "GPU1 total"), (3, "GPU0 asr"), (4, "GPU1 asr")):
    pk = max(r[i] for r in rows)
    extra = f"  headroom {(cap - pk) / 1024:.2f} GiB" if "total" in name else ""
    print(f"{name}: peak {pk:.0f} MiB ({pk / 1024:.2f} GiB){extra}")
print("samples", len(rows), "span", round(rows[-1][0] - rows[0][0], 1), "s")
