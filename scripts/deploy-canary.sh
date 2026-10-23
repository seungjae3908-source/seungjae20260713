#!/usr/bin/env bash
set -euo pipefail
RELEASE_DIR="${1:-/opt/stock-app-releases/f6b2bea/api-server}"
SRC_DIR="/root/seungjae20260713/api-server"
CANARY="$RELEASE_DIR/.canary-dist"
MODULES=(web-push ws @supabase pino pino-http pino-pretty thread-stream)

echo "[deploy-canary] target: $CANARY"
mkdir -p "$CANARY/node_modules"

# 1) node_modules 심볼릭 재생성
for m in "${MODULES[@]}"; do
  target="$SRC_DIR/node_modules/$m"
  if [ ! -e "$target" ]; then
    echo "  MISSING: $target" >&2
    exit 1
  fi
  ln -sfn "$target" "$CANARY/node_modules/$m"
  echo "  linked: $m"
done

# 2) alert-worker.mjs 복사
cp -v "$SRC_DIR/dist/alert-worker.mjs" "$CANARY/alert-worker.mjs"

# 3) PM2 재시작
pm2 restart stock-alert-worker-f6b2bea-canary
pm2 save

echo "[deploy-canary] DONE"
