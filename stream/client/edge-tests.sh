#!/bin/bash
# Error paths and fast mode against the running asr-stream.
cd "$(dirname "$0")/.." || exit 1
run() {
  echo "== $*"
  timeout 180 uv run -q --with websockets --with soundfile --with numpy \
    python client/stream_wav.py warmup.wav --quiet "$@" 2>&1 | python3 -c '
import json, sys
t = sys.stdin.read()
try:
    d = json.loads(t[t.index("{"):])
except Exception:
    print("RAW:", t[-300:]); sys.exit()
e = d.get("error") or (d.get("exception") and {"exception": d["exception"]})
print(json.dumps(e)[:220] if e else {k: d.get(k) for k in ("final_type", "final_segments", "speakers", "wall_s", "audio_s")})'
}
run --auth none
run --auth message --fast
run --language xx-XX
run --max-speakers 9
run --fast --language en-US --max-speakers 2
curl -s http://127.0.0.1:9101/health; echo
docker logs asr-stream 2>&1 | grep -E '"msg": "(session end|unauthorized|busy)"' | tail -6 | cut -c1-260
