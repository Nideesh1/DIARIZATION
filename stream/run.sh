#!/usr/bin/env bash
# (Re)start the live ASR container on kamd1. Usage: ./run.sh [image-tag]
# Uses the SAME bearer token as the batch service (../asr.env, from ../gen_token.sh).
# GPU 0 only (shared with the batch asr container; ~5.5 GB here).
set -euo pipefail
cd "$(dirname "$0")"
TAG="${1:-asr-stream:0.1.0}"
ENVF="${ENV_FILE:-$(pwd)/../asr.env}"
[[ -f "$ENVF" ]] || { echo "$ENVF missing" >&2; exit 1; }
docker volume create asr-stream-models >/dev/null
docker run --rm -u 0 -v asr-stream-models:/models "$TAG" chown -R 10001:10001 /models
docker rm -f asr-stream >/dev/null 2>&1 || true
docker run -d --name asr-stream --restart unless-stopped \
  --gpus '"device=0"' \
  -p 9101:9101 \
  --env-file "$ENVF" \
  -e ATT_CONTEXT="${ATT_CONTEXT:-56,6}" \
  -e MAX_SPEAKERS="${MAX_SPEAKERS:-4}" \
  -e MAX_SESSIONS="${MAX_SESSIONS:-4}" \
  -e LANGUAGE="${LANGUAGE:-auto}" \
  --log-opt max-size=50m --log-opt max-file=5 \
  -v asr-stream-models:/models \
  "$TAG"
echo "waiting for /health (model load + warm-up, ~2-4 min) ..."
for _ in $(seq 1 90); do
  code=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:9101/health || true)
  [[ "$code" == 200 ]] && { curl -s http://127.0.0.1:9101/health; echo; exit 0; }
  sleep 5
done
echo "not healthy after 7.5 min; see: docker logs asr-stream" >&2
curl -s http://127.0.0.1:9101/health; echo
exit 1
