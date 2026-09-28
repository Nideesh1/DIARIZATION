#!/usr/bin/env bash
# (Re)start the ASR container on kamd1. Usage: ./run.sh [image-tag]
# Measured 2026-09-28 (300 W caps): 2 jobs = 55 audio-min/min; 3 jobs = 52 and GPU0 peaked 23.0/24 GB.
# Default is single-user: 1 STT + 1 diarization instance on GPU 0, one job at a time
# (idle ~3.9 GB instead of ~20 GB; a 30-min file still takes ~42 s). That leaves GPU 0 room for
# the live service (../asr-stream, ~3.6 GB) and GPU 1 to llama-server.
# For more throughput: STT_REPLICAS=2 DIAR_REPLICAS=2 DIAR_DEVICES=cuda:0,cuda:1 MAX_JOBS=2 ./run.sh
# Model pools (override any of these from the environment, e.g. MAX_JOBS=2 ./run.sh):
#   STT_REPLICAS Parakeet instances, round-robin over STT_DEVICES
#   DIAR_REPLICAS pyannote instances, round-robin over DIAR_DEVICES
#   MAX_JOBS     concurrent jobs admitted (the rest get 503 + Retry-After)
# cuda:N inside the container = host GPU N (both GPUs are passed through).
set -euo pipefail
cd "$(dirname "$0")"
TAG="${1:-asr-service:0.2.0}"
STT_REPLICAS="${STT_REPLICAS:-1}"
STT_DEVICES="${STT_DEVICES:-cuda:0}"
DIAR_REPLICAS="${DIAR_REPLICAS:-1}"
DIAR_DEVICES="${DIAR_DEVICES:-cuda:0}"
MAX_JOBS="${MAX_JOBS:-1}"
[[ -f asr.env ]] || { echo "asr.env missing: run ./gen_token.sh first" >&2; exit 1; }
docker rm -f asr >/dev/null 2>&1 || true
docker run -d --name asr --restart unless-stopped \
  --gpus '"device=0,1"' \
  -p 9100:9100 \
  --env-file "$(pwd)/asr.env" \
  -e STT_REPLICAS="$STT_REPLICAS" -e STT_DEVICES="$STT_DEVICES" \
  -e DIAR_REPLICAS="$DIAR_REPLICAS" -e DIAR_DEVICES="$DIAR_DEVICES" \
  -e MAX_JOBS="$MAX_JOBS" \
  --log-opt max-size=50m --log-opt max-file=5 \
  -v asr-models:/models \
  "$TAG"
echo "waiting for /health ..."
for _ in $(seq 1 72); do
  code=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:9100/health || true)
  [[ "$code" == 200 ]] && { curl -s http://127.0.0.1:9100/health; echo; exit 0; }
  sleep 5
done
echo "not healthy after 6 min; see: docker logs asr" >&2
curl -s http://127.0.0.1:9100/health; echo
exit 1
