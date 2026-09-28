#!/usr/bin/env bash
# One-off: download both models into the `asr-models` volume (HF cache at /models/hf).
# Needs a Hugging Face token with access to pyannote/speaker-diarization-community-1.
# Usage: HF_TOKEN_FILE=/path/to/hf_token ./prefetch.sh [image-tag]
# The token is passed via a temporary env file (mode 600) and never printed or baked in.
set -euo pipefail
TAG="${1:-asr-service:0.2.0}"
: "${HF_TOKEN_FILE:?set HF_TOKEN_FILE to the file holding the HF token}"
umask 077
envf="$(mktemp)"
trap 'rm -f "$envf"' EXIT
printf 'HF_TOKEN=%s\n' "$(tr -d '[:space:]' < "$HF_TOKEN_FILE")" > "$envf"
docker volume create asr-models >/dev/null
# the image runs as uid 10001; make sure it owns the volume root
docker run --rm -u 0 -v asr-models:/models "$TAG" chown -R 10001:10001 /models
docker run --rm --env-file "$envf" -e HF_HUB_OFFLINE=0 -e TRANSFORMERS_OFFLINE=0 \
  -v asr-models:/models "$TAG" python prefetch.py
