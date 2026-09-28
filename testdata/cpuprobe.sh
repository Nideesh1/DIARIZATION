#!/usr/bin/env bash
# Probe CPU/GPU utilisation of the asr process during one 30-min job: cpuprobe.sh [query]
cd "$(dirname "$0")"
pid=$(docker inspect -f '{{.State.Pid}}' asr)
./tx.sh sts41c_30min.mp3 "${1:-}" /dev/null &
sleep 6
for i in 1 2 3 4 5; do
  echo "--- t=$((6 + (i-1)*7))s"
  ps -o pcpu=,nlwp= -p "$pid"
  top -b -n1 -H -p "$pid" | sed -n 8,12p
  nvidia-smi --query-gpu=index,utilization.gpu --format=csv,noheader | tr '\n' ' '; echo
  sleep 7
done
wait
