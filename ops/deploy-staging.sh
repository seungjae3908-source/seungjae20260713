#!/usr/bin/env bash
set -Eeuo pipefail

umask 077

TARGET_SHA="${1:-}"
SOURCE_DIR="${SOURCE_DIR:-}"
STAGING_DIR="${STAGING_DIR:-/srv/seungjae-staging}"
STAGING_PM2_NAME="${STAGING_PM2_NAME:-seungjae-staging}"
STAGING_PORT="${STAGING_PORT:-18080}"
STAGING_CANARY_PORT="${STAGING_CANARY_PORT:-18082}"
STAGING_BASE_URL="${STAGING_BASE_URL:-}"
STAGING_DATABASE_URL="${STAGING_DATABASE_URL:-}"
STAGING_AI_API_KEY="${STAGING_AI_API_KEY:-}"
RELEASE_ROOT="${RELEASE_ROOT:-/srv/seungjae-staging-releases}"
BACKUP_ROOT="${BACKUP_ROOT:-/srv/seungjae-staging-backups}"
LOCK_FILE="${LOCK_FILE:-/var/lock/seungjae-staging-deploy.lock}"
STATE_DIR="$STAGING_DIR/.deploy"

fail() { echo "[staging] $1" >&2; exit "${2:-1}"; }

[[ "$TARGET_SHA" =~ ^[0-9a-f]{40}$ ]] || fail 'exact lowercase 40-character SHA required' 2
[[ -n "$SOURCE_DIR" && -d "$SOURCE_DIR/.git" ]] || fail 'SOURCE_DIR must be a Git checkout' 3
[[ "$STAGING_DIR" == /srv/seungjae-staging* ]] || fail 'staging path must remain under /srv/seungjae-staging' 4
[[ "$STAGING_PM2_NAME" == seungjae-staging* ]] || fail 'staging PM2 name is not isolated' 5
[[ "$STAGING_PORT" != 8080 && "$STAGING_CANARY_PORT" != 18081 ]] || fail 'production ports are forbidden' 6
[[ -n "$STAGING_BASE_URL" ]] || fail 'STAGING_BASE_URL is required' 7
[[ -n "$STAGING_DATABASE_URL" ]] || fail 'STAGING_DATABASE_URL is required' 8
[[ -n "$STAGING_AI_API_KEY" ]] || fail 'STAGING_AI_API_KEY is required' 9
[[ "$STAGING_BASE_URL" != *'lsj119.duckdns.org'* ]] || fail 'production URL is forbidden' 10
[[ "$STAGING_DATABASE_URL" != *'prod'* && "$STAGING_DATABASE_URL" != *'production'* ]] || fail 'production-like database URL is forbidden' 11

for command_name in git node pnpm pm2 curl flock df awk rsync tar sha256sum; do
  command -v "$command_name" >/dev/null 2>&1 || fail "missing command: $command_name" 12
done

mkdir -p "$STAGING_DIR" "$RELEASE_ROOT" "$BACKUP_ROOT" "$STATE_DIR" "$(dirname "$LOCK_FILE")"
exec 9>"$LOCK_FILE"
flock -n 9 || fail 'another staging deployment is running' 13

RESOLVED_SHA="$(git -C "$SOURCE_DIR" rev-parse "$TARGET_SHA^{commit}")"
[[ "$RESOLVED_SHA" == "$TARGET_SHA" ]] || fail 'resolved SHA mismatch' 14
CURRENT_SHA="none"
[[ -s "$STATE_DIR/current-sha" ]] && CURRENT_SHA="$(tr -d '[:space:]' < "$STATE_DIR/current-sha")"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
RELEASE_DIR="$RELEASE_ROOT/$STAMP-${TARGET_SHA:0:10}"
BACKUP_DIR="$BACKUP_ROOT/$STAMP-${CURRENT_SHA:0:10}"
CANARY_LOG="$(mktemp /tmp/seungjae-staging-canary.XXXXXX)"
CANARY_PID=""

cleanup() {
  local status=$?
  if [[ -n "$CANARY_PID" ]] && kill -0 "$CANARY_PID" 2>/dev/null; then kill "$CANARY_PID" 2>/dev/null || true; fi
  rm -f "$CANARY_LOG"
  if (( status != 0 )) && [[ -d "$BACKUP_DIR/source" ]]; then
    echo '[staging] deployment failed; restoring previous snapshot'
    rsync -a --delete "$BACKUP_DIR/source/" "$STAGING_DIR/"
    if [[ "$CURRENT_SHA" == none ]]; then rm -f "$STATE_DIR/current-sha"; else printf '%s\n' "$CURRENT_SHA" > "$STATE_DIR/current-sha"; fi
    pm2 restart "$STAGING_PM2_NAME" >/dev/null 2>&1 || true
  fi
  exit "$status"
}
trap cleanup EXIT

mkdir -p "$RELEASE_DIR"
git -C "$SOURCE_DIR" archive "$TARGET_SHA" | tar -x -C "$RELEASE_DIR"

cat > "$RELEASE_DIR/api-server/.env.staging" <<ENV
NODE_ENV=production
PORT=$STAGING_PORT
API_PORT=$STAGING_PORT
DATABASE_URL=$STAGING_DATABASE_URL
TRADING_REVIEW_API_KEY=$STAGING_AI_API_KEY
APP_ENV=staging
DEPLOY_SHA=$TARGET_SHA
ENV
chmod 600 "$RELEASE_DIR/api-server/.env.staging"

(
  cd "$RELEASE_DIR"
  pnpm install --frozen-lockfile
  NODE_ENV=production pnpm --filter @workspace/api-server run build
)

[[ -f "$RELEASE_DIR/api-server/dist/index.mjs" ]] || fail 'API build output missing' 15
[[ -f "$RELEASE_DIR/stock-analyzer/dist/public/index.html" ]] || fail 'frontend build output missing' 16

(
  cd "$RELEASE_DIR/api-server"
  nohup env PORT="$STAGING_CANARY_PORT" API_PORT="$STAGING_CANARY_PORT" NODE_ENV=production APP_ENV=staging DEPLOY_SHA="$TARGET_SHA" \
    DATABASE_URL="$STAGING_DATABASE_URL" TRADING_REVIEW_API_KEY="$STAGING_AI_API_KEY" \
    node --enable-source-maps ./dist/index.mjs >"$CANARY_LOG" 2>&1 &
  echo $! > "$RELEASE_DIR/.canary.pid"
)
CANARY_PID="$(cat "$RELEASE_DIR/.canary.pid")"

for _ in $(seq 1 20); do
  if curl --fail --silent --show-error --max-time 10 "http://127.0.0.1:$STAGING_CANARY_PORT/api/health" >/tmp/staging-health.json \
    && node -e 'const v=require("fs").readFileSync("/tmp/staging-health.json","utf8");const j=JSON.parse(v);if(j.ok!==true)process.exit(1)'; then
    break
  fi
  sleep 2
done
curl --fail --silent --show-error "http://127.0.0.1:$STAGING_CANARY_PORT/api/health" >/dev/null || {
  tail -n 120 "$CANARY_LOG" >&2 || true
  fail 'canary health check failed' 17
}
kill "$CANARY_PID" 2>/dev/null || true
wait "$CANARY_PID" 2>/dev/null || true
CANARY_PID=""

mkdir -p "$BACKUP_DIR/source"
rsync -a --delete --exclude='.deploy/' --exclude='.env*' --exclude='*/.env*' "$STAGING_DIR/" "$BACKUP_DIR/source/"
find "$BACKUP_DIR/source" -type f -print0 | sort -z | xargs -0 sha256sum > "$BACKUP_DIR/checksums.sha256"

rsync -a --delete --exclude='.git/' --exclude='.github/' --exclude='node_modules/' --exclude='*/node_modules/' \
  --exclude='.env' --exclude='.env.*' --exclude='*/.env' --exclude='*/.env.*' "$RELEASE_DIR/" "$STAGING_DIR/"
cp "$RELEASE_DIR/api-server/.env.staging" "$STAGING_DIR/api-server/.env.staging"
printf '%s\n' "$TARGET_SHA" > "$STATE_DIR/current-sha"
printf '%s\n' "$STAMP" > "$STATE_DIR/deployed-at"

if pm2 describe "$STAGING_PM2_NAME" >/dev/null 2>&1; then
  pm2 restart "$STAGING_PM2_NAME" --update-env
else
  cd "$STAGING_DIR/api-server"
  pm2 start ./dist/index.mjs --name "$STAGING_PM2_NAME" --node-args='--enable-source-maps' --update-env
fi
pm2 save

curl --fail --silent --show-error --max-time 15 "http://127.0.0.1:$STAGING_PORT/api/health" >/tmp/staging-live-health.json
node - "$TARGET_SHA" <<'NODE'
const fs=require('fs');
const expected=process.argv[2];
const health=JSON.parse(fs.readFileSync('/tmp/staging-live-health.json','utf8'));
if(health.ok!==true) throw new Error('staging health is not ok');
const reported=health.deploySha||health.sha||health.commitSha;
if(reported && reported!==expected) throw new Error(`staging SHA mismatch: ${reported}`);
NODE
curl --fail --silent --show-error --max-time 15 "${STAGING_BASE_URL%/}/api/health" >/dev/null

echo "[staging] deployed exact SHA: $TARGET_SHA"
echo "[staging] previous SHA: $CURRENT_SHA"
echo "[staging] backup: $BACKUP_DIR"
