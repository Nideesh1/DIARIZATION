#!/usr/bin/env bash
# Fire N concurrent requests of the same file; print status + Retry-After for each.
# Usage: concurrent.sh <file> [N] [query]
set -u
f="$1"; n="${2:-3}"; q="${3:-}"
TOKEN="$(sed -n 's/^ASR_TOKEN=//p' "$(dirname "$0")/../asr.env")"
for i in $(seq 1 "$n"); do
  (
    curl -s -D "/tmp/asr_c$i.hdr" -o "/tmp/asr_c$i.json" \
      -w "req$i HTTP %{http_code} %{time_total}s\n" \
      -H @<(printf 'Authorization: Bearer %s\n' "$TOKEN") \
      --data-binary @"$f" "${ASR_URL:-http://127.0.0.1:9100}/v1/transcribe${q:+?$q}"
    grep -i '^retry-after' "/tmp/asr_c$i.hdr" | sed "s/^/  req$i /"
  ) &
  sleep 0.2
done
wait
