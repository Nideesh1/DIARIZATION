"""Compact summary lines for verification: python summ.py resp.json [chars]"""
import json, sys
d = json.load(open(sys.argv[1]))
n = int(sys.argv[2]) if len(sys.argv) > 2 else 300
print("duration_s", d["duration_s"], "speakers", d["speakers"], "words", len(d["words"]),
      "segments", len(d["segments"]), "model", d["model"])
print("null speakers in words:", all(w["speaker"] is None for w in d["words"]),
      "| in segments:", all(s["speaker"] is None for s in d["segments"]))
print("text:", d["text"][:n])
