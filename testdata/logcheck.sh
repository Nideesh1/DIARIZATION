#!/usr/bin/env bash
# Verify container logs: every line is JSON, no ASR token / HF token / bearer strings,
# and the running container has no HF_TOKEN in its environment. Prints no secrets.
set -u
cd "$(dirname "$0")/.."
TOKEN="$(sed -n 's/^ASR_TOKEN=//p' asr.env)"
HF="$(tr -d '[:space:]' < "${HF_TOKEN_FILE:-/dev/null}" 2>/dev/null)"
logs="$(docker logs asr 2>&1)"
echo "log lines: $(printf '%s\n' "$logs" | wc -l)"
echo "non-JSON lines: $(printf '%s\n' "$logs" | python3 -c 'import sys,json
n=0
for l in sys.stdin:
    try: json.loads(l)
    except Exception: n+=1
print(n)')"
printf '%s' "$logs" | grep -qF "$TOKEN" && echo "ASR token FOUND in logs" || echo "ASR token not in logs"
[[ -n "$HF" ]] && { printf '%s' "$logs" | grep -qF "$HF" && echo "HF token FOUND in logs" || echo "HF token not in logs"; }
printf '%s' "$logs" | grep -qi "bearer [0-9a-f]" && echo "bearer value FOUND" || echo "no bearer values in logs"
docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' asr | grep -q '^HF_TOKEN=' \
  && echo "HF_TOKEN present in container env" || echo "HF_TOKEN absent from container env"
echo "request log keys: $(printf '%s\n' "$logs" | grep '"msg": "request"' | python3 -c 'import sys,json
k=set()
for l in sys.stdin: k|=set(json.loads(l))
print(sorted(k))')"
