#!/usr/bin/env bash
# Sample GPU memory every 0.5 s into $1 until killed. Each line:
#   <epoch> <gpu0_total_MiB> <gpu1_total_MiB> <asr_gpu0_MiB> <asr_gpu1_MiB>
# Summarise with: gpupeak.py $1
out="$1"
pid=$(docker inspect -f '{{.State.Pid}}' asr)
g0=$(nvidia-smi -i 0 --query-gpu=uuid --format=csv,noheader)
g1=$(nvidia-smi -i 1 --query-gpu=uuid --format=csv,noheader)
: > "$out"
while true; do
  tot=$(nvidia-smi --query-gpu=memory.used --format=csv,noheader,nounits | tr '\n' ' ')
  apps=$(nvidia-smi --query-compute-apps=gpu_uuid,pid,used_memory --format=csv,noheader,nounits)
  a0=$(awk -F', ' -v p="$pid" -v g="$g0" '$2==p && $1==g {print $3}' <<<"$apps")
  a1=$(awk -F', ' -v p="$pid" -v g="$g1" '$2==p && $1==g {print $3}' <<<"$apps")
  echo "$(date +%s.%N) $tot ${a0:-0} ${a1:-0}" >> "$out"
  sleep 0.5
done
