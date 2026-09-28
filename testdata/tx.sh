#!/usr/bin/env bash
# Test client: tx.sh <audio-file> [query-string] [out.json]
# Reads ASR_TOKEN from ../asr.env without printing it. Prints "HTTP <code> <seconds>s".
set -euo pipefail
f="$1"; q="${2:-}"; out="${3:-/dev/stdout}"
TOKEN="$(sed -n 's/^ASR_TOKEN=//p' "$(dirname "$0")/../asr.env")"
curl -s -o "$out" -w 'HTTP %{http_code} %{time_total}s\n' \
  -H @<(printf 'Authorization: Bearer %s\n' "$TOKEN") \
  --data-binary @"$f" -H 'Content-Type: application/octet-stream' \
  "${ASR_URL:-http://127.0.0.1:9100}/v1/transcribe${q:+?$q}"
