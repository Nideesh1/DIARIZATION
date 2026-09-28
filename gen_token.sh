#!/usr/bin/env bash
# Generate (or rotate with --rotate) the service bearer token in asr.env (mode 600).
# Never prints the token.
set -euo pipefail
cd "$(dirname "$0")"
umask 077
if [[ -f asr.env && "${1:-}" != "--rotate" ]]; then
  echo "asr.env exists (use --rotate to replace)"; exit 0
fi
printf 'ASR_TOKEN=%s\n' "$(openssl rand -hex 32)" > asr.env.tmp
chmod 600 asr.env.tmp
mv asr.env.tmp asr.env
echo "wrote $(pwd)/asr.env"
