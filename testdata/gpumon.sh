#!/usr/bin/env bash
# Sample per-process GPU memory of the asr container every 0.5 s into $1 until killed.
out="$1"
pid=$(docker inspect -f '{{.State.Pid}}' asr)
: > "$out"
while true; do
  nvidia-smi --query-compute-apps=gpu_uuid,pid,used_memory --format=csv,noheader,nounits \
    | awk -F', ' -v p="$pid" '$2==p' >> "$out"
  sleep 0.5
done
