#!/bin/bash
# Careful concurrency test after the 2026-09-28 host freeze: 1 -> 2 -> 3 concurrent
# 30-min jobs, sampling GPU power/VRAM every 0.5 s, stopping at the first failure.
# The bearer token is read from asr.env into a variable and never printed.
set -uo pipefail
D="$(cd "$(dirname "$0")/.." && pwd)"
CLIP=$D/testdata/sts41c_30min.mp3
OUT=$D/testdata/careful-$(date -u +%H%M%S)
mkdir -p "$OUT"
TOKEN=$(sed -n 's/^ASR_TOKEN=//p' "$D/asr.env")

nvidia-smi --query-gpu=timestamp,index,power.draw,memory.used,utilization.gpu \
  --format=csv,noheader,nounits -lms 500 > "$OUT/gpu.csv" &
MON=$!
trap 'kill $MON 2>/dev/null' EXIT

run_step() {
  local n=$1 pids=() i
  echo "== step: $n concurrent 30-min job(s)  $(date -u +%H:%M:%S)"
  local t0; t0=$(date +%s.%N)
  for i in $(seq 1 "$n"); do
    ( s=$(date +%s.%N)
      code=$(curl -s -o "$OUT/n${n}_job$i.json" -w '%{http_code}' --max-time 900 \
             -H "Authorization: Bearer $TOKEN" -H "Content-Type: audio/mpeg" \
             --data-binary @"$CLIP" \
             "http://127.0.0.1:9100/v1/transcribe?diarize=true")
      e=$(date +%s.%N)
      echo "   job $i: HTTP $code in $(printf '%.1f' "$(echo "$e - $s" | bc)") s" ) &
    pids+=($!)
  done
  local fail=0
  for p in "${pids[@]}"; do wait "$p" || fail=1; done
  local t1; t1=$(date +%s.%N)
  echo "   wall: $(printf '%.1f' "$(echo "$t1 - $t0" | bc)") s  -> $(printf '%.2f' "$(echo "$n * 30 / (($t1 - $t0) / 60)" | bc -l)") audio-min per min"
  grep -L '"words"' "$OUT"/n${n}_job*.json >/dev/null 2>&1 && \
    for f in "$OUT"/n${n}_job*.json; do grep -q '"words"' "$f" || { echo "   FAILED body: $(head -c 200 "$f")"; fail=1; }; done
  return $fail
}

for n in 1 2 3; do
  run_step "$n" || { echo "STOPPING: a job failed at n=$n"; break; }
  sleep 20
done
kill $MON 2>/dev/null
python3 - "$OUT/gpu.csv" <<'PY'
import sys, csv
peak = {}
tot = {}
for row in csv.reader(open(sys.argv[1])):
    if len(row) < 5: continue
    ts, idx, pw, mem, util = [x.strip() for x in row]
    try: pw, mem = float(pw), float(mem)
    except ValueError: continue
    p = peak.setdefault(idx, [0, 0]); p[0] = max(p[0], pw); p[1] = max(p[1], mem)
    tot[ts] = tot.get(ts, 0) + pw
for idx, (pw, mem) in sorted(peak.items()):
    print(f"GPU {idx}: peak power {pw:.0f} W (cap 300), peak VRAM {mem/1024:.1f} GB of 24")
print(f"peak combined GPU power: {max(tot.values()):.0f} W")
PY
echo "results in $OUT"
