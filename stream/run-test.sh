#!/bin/bash
# Run live_test.py in the feasibility image on GPU 0; sample GPU 0 memory every 0.5 s.
# Usage: run-test.sh <mt|n35> [max_spks] [wav]
D="$(cd "$(dirname "$0")" && pwd)"; MODE="$1"; SPK="${2:-4}"; WAV="${3:-nasa2min.wav}"
docker run --rm -u 0 -v asr-stream-models:/models asr-stream:feas chown -R 10001:10001 /models
nvidia-smi --query-gpu=memory.used --format=csv,noheader,nounits -i 0 -lms 500 > "$D/gpu-$MODE.txt" &
SMI=$!
base=$(nvidia-smi --query-gpu=memory.used --format=csv,noheader,nounits -i 0)
docker run --rm --gpus '"device=0"' -v asr-stream-models:/models -v "$D":/work \
  -e ATT="${ATT:-}" asr-stream:feas python live_test.py "/work/$WAV" "$MODE" "$SPK" > "$D/out-$MODE.log" 2>&1
echo "exit $?"
kill $SMI
peak=$(sort -n "$D/gpu-$MODE.txt" | tail -1)
echo "GPU0 baseline ${base} MiB, peak ${peak} MiB -> pipeline used ~$((peak - base)) MiB"
grep -E "^RESULT" "$D/out-$MODE.log" || tail -25 "$D/out-$MODE.log"
sed -n '/TRANSCRIPT_START/,/TRANSCRIPT_END/p' "$D/out-$MODE.log" | head -40
