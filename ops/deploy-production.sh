#!/usr/bin/env bash
set -Eeuo pipefail

umask 077

TARGET_SHA="${1:-}"
SOURCE_DIR="${SOURCE_DIR:-}"
LIVE_DIR="${LIVE_DIR:-/opt/stock-app}"
PM2_NAME="${PM2_NAME:-stock-app}"
LIVE_PORT="${LIVE_PORT:-8080}"
CANARY_PORT="${CANARY_PORT:-18081}"
DATA_PROBE_PATH="${DATA_PROBE_PATH:-/api/healthz/data-plane}"
PUBLIC_BASE_URL="${PUBLIC_BASE_URL:-}"
RELEASE_ROOT="${RELEASE_ROOT:-/opt/stock-app-releases}"
BACKUP_ROOT="${BACKUP_ROOT:-/opt/stock-app-backups}"
MIN_FREE_KB="${MIN_FREE_KB:-1200000}"
LOCK_FILE="${LOCK_FILE:-/var/lock/stock-app-deploy.lock}"
DEPLOY_STATE_DIR="${DEPLOY_STATE_DIR:-$LIVE_DIR/.deploy}"

if [[ -z "$TARGET_SHA" ]]; then
  echo "[deploy] target SHA is required" >&2
  exit 2
fi

if [[ -z "$SOURCE_DIR" ]] || [[ ! -d "$SOURCE_DIR/.git" ]]; then
  echo "[deploy] SOURCE_DIR must point to a temporary Git checkout" >&2
  exit 3
fi

if [[ ! -d "$LIVE_DIR" ]]; then
  echo "[deploy] live directory not found: $LIVE_DIR" >&2
  exit 4
fi

for command_name in git node pnpm pm2 curl flock df awk rsync tar; do
  command -v "$command_name" >/dev/null 2>&1 || {
    echo "[deploy] missing command: $command_name" >&2
    exit 5
  }
done

mkdir -p "$RELEASE_ROOT" "$BACKUP_ROOT" "$DEPLOY_STATE_DIR" "$(dirname "$LOCK_FILE")"
exec 9>"$LOCK_FILE"
flock -n 9 || {
  echo "[deploy] another deployment is already running" >&2
  exit 6
}

TARGET_SHA="$(git -C "$SOURCE_DIR" rev-parse "$TARGET_SHA^{commit}")"
CURRENT_SHA="legacy"
if [[ -s "$DEPLOY_STATE_DIR/current-sha" ]]; then
  CURRENT_SHA="$(tr -d '[:space:]' < "$DEPLOY_STATE_DIR/current-sha")"
fi

SHORT_SHA="${TARGET_SHA:0:10}"
CURRENT_LABEL="${CURRENT_SHA:0:10}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
RELEASE_DIR="$RELEASE_ROOT/$STAMP-$SHORT_SHA"
BACKUP_DIR="$BACKUP_ROOT/$STAMP-$CURRENT_LABEL"
CANARY_ENV="$(mktemp /tmp/stock-app-canary-env.XXXXXX)"
CANARY_LOG="$(mktemp /tmp/stock-app-canary-log.XXXXXX)"
CANARY_PID=""
RELEASE_CREATED=0

sync_source_tree() {
  local source_root="$1"
  local destination_root="$2"

  mkdir -p "$destination_root"
  rsync -a --delete \
    --exclude='.git/' \
    --exclude='.github/' \
    --exclude='node_modules/' \
    --exclude='*/node_modules/' \
    --exclude='api-server/dist/' \
    --exclude='stock-analyzer/dist/' \
    --exclude='.env' \
    --exclude='.env.*' \
    --exclude='*/.env' \
    --exclude='*/.env.*' \
    --exclude='.deploy/' \
    --exclude='logs/' \
    --exclude='*/logs/' \
    --exclude='uploads/' \
    --exclude='*/uploads/' \
    "$source_root/" "$destination_root/"
}

cleanup() {
  if [[ -n "$CANARY_PID" ]] && kill -0 "$CANARY_PID" 2>/dev/null; then
    kill "$CANARY_PID" 2>/dev/null || true
    wait "$CANARY_PID" 2>/dev/null || true
  fi

  rm -f "$CANARY_ENV" "$CANARY_LOG"

  if [[ "$RELEASE_CREATED" == "1" ]] && [[ -d "$RELEASE_DIR" ]]; then
    rm -rf -- "$RELEASE_DIR"
  fi
}
trap cleanup EXIT

probe_json() {
  local url="$1"
  local output_file="$2"
  local attempts="${3:-6}"
  local sleep_seconds="${4:-3}"
  local attempt

  for ((attempt = 1; attempt <= attempts; attempt += 1)); do
    if curl --fail --silent --show-error --max-time 25 "$url" -o "$output_file" \
      && node -e 'const fs=require("fs"); const value=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); if(value===null) process.exit(1);' "$output_file"; then
      return 0
    fi
    sleep "$sleep_seconds"
  done

  return 1
}

probe_health() {
  local base_url="$1"
  local expected_sha="${2:-}"
  local output_file
  output_file="$(mktemp /tmp/stock-app-health.XXXXXX)"

  if ! probe_json "$base_url/api/health" "$output_file" 10 3; then
    rm -f "$output_file"
    return 1
  fi

  node - "$output_file" "$expected_sha" <<'NODE'
const fs = require('fs');
const [file, expectedSha] = process.argv.slice(2);
const value = JSON.parse(fs.readFileSync(file, 'utf8'));
if (value?.ok !== true) process.exit(1);
if (expectedSha) {
  const exact = /^[0-9a-f]{40}$/.test(expectedSha);
  const identityValid = exact
    && value?.deploySha === expectedSha
    && value?.processDeploySha === expectedSha
    && value?.deployMarkerSha === expectedSha
    && value?.identityMatch === true
    && value?.identityStatus === 'match';
  if (!identityValid) process.exit(1);
}
NODE
  local result=$?
  rm -f "$output_file"
  return "$result"
}

probe_data() {
  local base_url="$1"
  local output_file
  output_file="$(mktemp /tmp/stock-app-data.XXXXXX)"

  if ! probe_json "$base_url$DATA_PROBE_PATH" "$output_file" 4 5; then
    rm -f "$output_file"
    return 1
  fi

  node -e '
    const fs = require("fs");
    const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const valid = value?.ok === true
      && value?.dataPlane === "market-quotes"
      && Number(value?.available) >= 1
      && value?.priceValidated === true
      && Number.isFinite(Date.parse(value?.providerUpdatedAt));
    if (!valid) process.exit(1);
  ' "$output_file"
  local result=$?
  rm -f "$output_file"
  return "$result"
}

telegram_runtime_activation_ready() {
  local output_file
  output_file="$(mktemp /tmp/stock-app-telegram-runtime.XXXXXX)"
  pm2 jlist >"$output_file"

  node - "$output_file" "$PM2_NAME" <<'NODE'
const fs = require('fs');
const [file, processName] = process.argv.slice(2);
const processes = JSON.parse(fs.readFileSync(file, 'utf8'));
const selected = processes.find((item) => item.name === processName);
const env = selected?.pm2_env;
const valid = env?.status === 'online'
  && String(env?.LIVE_TELEGRAM_ACTIVATION_APPROVED ?? '') === 'true'
  && String(env?.TELEGRAM_INTELLIGENCE_WORKER_ENABLED ?? 'true') !== 'false';
if (!valid) process.exit(1);
NODE
  local result=$?
  rm -f "$output_file"
  return "$result"
}

restore_backup() {
  echo "[rollback] restoring previous production snapshot"

  sync_source_tree "$BACKUP_DIR/source" "$LIVE_DIR"

  rm -rf "$LIVE_DIR/api-server/dist" "$LIVE_DIR/stock-analyzer/dist"
  [[ -d "$BACKUP_DIR/api-server-dist" ]] && cp -a "$BACKUP_DIR/api-server-dist" "$LIVE_DIR/api-server/dist"
  [[ -d "$BACKUP_DIR/stock-analyzer-dist" ]] && cp -a "$BACKUP_DIR/stock-analyzer-dist" "$LIVE_DIR/stock-analyzer/dist"

  if [[ "$CURRENT_SHA" == "legacy" ]]; then
    rm -f "$DEPLOY_STATE_DIR/current-sha"
  else
    printf '%s\n' "$CURRENT_SHA" > "$DEPLOY_STATE_DIR/current-sha"
  fi

  if [[ "$CURRENT_SHA" =~ ^[0-9a-f]{40}$ ]]; then
    DEPLOY_SHA="$CURRENT_SHA" pm2 restart "$PM2_NAME" --update-env
  else
    DEPLOY_SHA="" pm2 restart "$PM2_NAME" --update-env
  fi
  pm2 save

  if ! probe_health "http://127.0.0.1:$LIVE_PORT" "$([[ "$CURRENT_SHA" =~ ^[0-9a-f]{40}$ ]] && printf '%s' "$CURRENT_SHA")"; then
    echo "[rollback] CRITICAL: rollback completed but health check still fails" >&2
    return 1
  fi

  echo "[rollback] previous production restored successfully"
}

FREE_KB="$(df -Pk "$LIVE_DIR" | awk 'NR==2 {print $4}')"
if [[ -z "$FREE_KB" ]] || (( FREE_KB < MIN_FREE_KB )); then
  echo "[deploy] insufficient disk space: ${FREE_KB:-unknown}KB free, ${MIN_FREE_KB}KB required" >&2
  exit 7
fi

if ! pm2 describe "$PM2_NAME" >/dev/null 2>&1; then
  echo "[deploy] PM2 process not found: $PM2_NAME" >&2
  exit 8
fi

if [[ "$CURRENT_SHA" == "$TARGET_SHA" ]]; then
  echo "[deploy] target marker is already active: $TARGET_SHA"
  if probe_health "http://127.0.0.1:$LIVE_PORT" "$TARGET_SHA" \
    && probe_data "http://127.0.0.1:$LIVE_PORT" \
    && telegram_runtime_activation_ready; then
    exit 0
  fi
  echo "[deploy] runtime identity or Telegram activation is stale; refreshing PM2 environment for the already-active target"
  LIVE_TELEGRAM_ACTIVATION_APPROVED=true \
    TELEGRAM_INTELLIGENCE_WORKER_ENABLED=true \
    DEPLOY_SHA="$TARGET_SHA" \
    pm2 restart "$PM2_NAME" --update-env
  pm2 save
  probe_health "http://127.0.0.1:$LIVE_PORT" "$TARGET_SHA"
  probe_data "http://127.0.0.1:$LIVE_PORT"
  telegram_runtime_activation_ready
  exit 0
fi

mkdir -p "$RELEASE_DIR"
RELEASE_CREATED=1

echo "[deploy] current=$CURRENT_SHA target=$TARGET_SHA"
echo "[deploy] exporting isolated release: $RELEASE_DIR"
git -C "$SOURCE_DIR" archive "$TARGET_SHA" | tar -x -C "$RELEASE_DIR"
mkdir -p "$RELEASE_DIR/.deploy"
printf '%s\n' "$TARGET_SHA" > "$RELEASE_DIR/.deploy/current-sha"

for relative_env in \
  .env \
  .env.production \
  api-server/.env \
  api-server/.env.production \
  stock-analyzer/.env \
  stock-analyzer/.env.production; do
  source_env="$LIVE_DIR/$relative_env"
  target_env="$RELEASE_DIR/$relative_env"
  if [[ -f "$source_env" ]] && [[ ! -e "$target_env" ]]; then
    mkdir -p "$(dirname "$target_env")"
    ln -s "$source_env" "$target_env"
  fi
done

(
  cd "$RELEASE_DIR"
  pnpm install --frozen-lockfile
  NODE_ENV=production pnpm --filter @workspace/api-server run build
)

[[ -f "$RELEASE_DIR/api-server/dist/index.mjs" ]] || {
  echo "[deploy] API build output missing" >&2
  exit 9
}

[[ -f "$RELEASE_DIR/stock-analyzer/dist/public/index.html" ]] || {
  echo "[deploy] frontend build output missing" >&2
  exit 10
}

PM2_JSON="$(mktemp /tmp/stock-app-pm2.XXXXXX)"
pm2 jlist >"$PM2_JSON"
node - "$PM2_JSON" "$PM2_NAME" "$CANARY_ENV" <<'NODE'
const fs = require('fs');
const [jsonPath, processName, outputPath] = process.argv.slice(2);
const processes = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
const selected = processes.find((item) => item.name === processName);
if (!selected?.pm2_env) {
  throw new Error(`PM2 process environment not found: ${processName}`);
}

const excluded = new Set([
  'name', 'namespace', 'cwd', 'args', 'exec_interpreter', 'exec_mode',
  'pm_exec_path', 'pm_cwd', 'pm_out_log_path', 'pm_err_log_path',
  'pm_pid_path', 'status', 'NODE_APP_INSTANCE', 'PORT', 'API_PORT', 'DEPLOY_SHA',
]);
const lines = [];
for (const [key, rawValue] of Object.entries(selected.pm2_env)) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
  if (excluded.has(key) || key.startsWith('pm_') || key.startsWith('axm_')) continue;
  if (rawValue === null || rawValue === undefined || typeof rawValue === 'object') continue;
  lines.push(`${key}=${JSON.stringify(String(rawValue))}`);
}
fs.writeFileSync(outputPath, `${lines.join('\n')}\n`, { mode: 0o600 });
NODE
rm -f "$PM2_JSON"

(
  cd "$RELEASE_DIR/api-server"
  nohup env PORT="$CANARY_PORT" API_PORT="$CANARY_PORT" NODE_ENV=production DEPLOY_SHA="$TARGET_SHA" \
    LIVE_TELEGRAM_ACTIVATION_APPROVED=false TELEGRAM_INTELLIGENCE_WORKER_ENABLED=false \
    node --env-file="$CANARY_ENV" --enable-source-maps ./dist/index.mjs \
    >"$CANARY_LOG" 2>&1 &
  echo $! >"$RELEASE_DIR/.canary.pid"
)
CANARY_PID="$(cat "$RELEASE_DIR/.canary.pid")"

echo "[deploy] validating canary on port $CANARY_PORT"
if ! probe_health "http://127.0.0.1:$CANARY_PORT" "$TARGET_SHA"; then
  echo "[deploy] canary health check failed" >&2
  tail -n 120 "$CANARY_LOG" >&2 || true
  exit 11
fi

if ! probe_data "http://127.0.0.1:$CANARY_PORT"; then
  echo "[deploy] canary data probe failed: $DATA_PROBE_PATH" >&2
  tail -n 120 "$CANARY_LOG" >&2 || true
  exit 12
fi

kill "$CANARY_PID" 2>/dev/null || true
wait "$CANARY_PID" 2>/dev/null || true
CANARY_PID=""

echo "[deploy] canary passed; creating rollback backup"
mkdir -p "$BACKUP_DIR/source"
sync_source_tree "$LIVE_DIR" "$BACKUP_DIR/source"
printf '%s\n' "$CURRENT_SHA" > "$BACKUP_DIR/previous-sha.txt"
[[ -d "$LIVE_DIR/api-server/dist" ]] && cp -a "$LIVE_DIR/api-server/dist" "$BACKUP_DIR/api-server-dist"
[[ -d "$LIVE_DIR/stock-analyzer/dist" ]] && cp -a "$LIVE_DIR/stock-analyzer/dist" "$BACKUP_DIR/stock-analyzer-dist"

set +e
(
  set -Eeuo pipefail

  sync_source_tree "$RELEASE_DIR" "$LIVE_DIR"
  (
    cd "$LIVE_DIR"
    pnpm install --frozen-lockfile
  )

  rm -rf "$LIVE_DIR/api-server/dist" "$LIVE_DIR/stock-analyzer/dist"
  cp -a "$RELEASE_DIR/api-server/dist" "$LIVE_DIR/api-server/dist"
  mkdir -p "$LIVE_DIR/stock-analyzer"
  cp -a "$RELEASE_DIR/stock-analyzer/dist" "$LIVE_DIR/stock-analyzer/dist"
  printf '%s\n' "$TARGET_SHA" > "$DEPLOY_STATE_DIR/current-sha"

  LIVE_TELEGRAM_ACTIVATION_APPROVED=true \
    TELEGRAM_INTELLIGENCE_WORKER_ENABLED=true \
    DEPLOY_SHA="$TARGET_SHA" \
    pm2 restart "$PM2_NAME" --update-env
  pm2 save

  probe_health "http://127.0.0.1:$LIVE_PORT" "$TARGET_SHA"
  probe_data "http://127.0.0.1:$LIVE_PORT"
  telegram_runtime_activation_ready

  if [[ -n "$PUBLIC_BASE_URL" ]]; then
    probe_health "${PUBLIC_BASE_URL%/}" "$TARGET_SHA"
  fi
)
DEPLOY_RESULT=$?
set -e

if (( DEPLOY_RESULT != 0 )); then
  echo "[deploy] production verification failed; starting automatic rollback" >&2
  restore_backup
  exit 13
fi

echo "[deploy] production deployment succeeded: $TARGET_SHA"

mapfile -t OLD_BACKUPS < <(find "$BACKUP_ROOT" -mindepth 1 -maxdepth 1 -type d -printf '%T@ %p\n' | sort -nr | awk 'NR>3 {print $2}')
for old_backup in "${OLD_BACKUPS[@]:-}"; do
  [[ -n "$old_backup" ]] && rm -rf -- "$old_backup"
done
