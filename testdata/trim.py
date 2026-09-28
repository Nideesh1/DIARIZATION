"""Print a trimmed view of a /v1/transcribe response: python trim.py resp.json [nwords] [nsegs]"""
import json, sys
d = json.load(open(sys.argv[1]))
nw = int(sys.argv[2]) if len(sys.argv) > 2 else 10
ns = int(sys.argv[3]) if len(sys.argv) > 3 else 5
t = {k: d[k] for k in ("model", "duration_s", "language", "speakers")}
t["text"] = d["text"][:200] + "..."
t["segments"] = d["segments"][:ns] + [f"... ({len(d['segments'])} total)"]
t["words"] = d["words"][:nw] + [f"... ({len(d['words'])} total)"]
print(json.dumps(t, indent=1))
