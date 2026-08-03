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
STAGING_SUPABASE_URL="${STAGING_SUPABASE_URL:-}"
STAGING_SUPABASE_ANON_KEY="${STAGING_SUPABASE_ANON_KEY:-}"
STAGING_SUPABASE_SECRET_KEY="${STAGING_SUPABASE_SECRET_KEY:-}"
STAGING_FAILPOINT="${STAGING_FAILPOINT:-}"
RELEASE_ROOT="${RELEASE_ROOT:-/srv/seungjae-staging-releases}"
BACKUP_ROOT="${BACKUP_ROOT:-/srv/seungjae-staging-backups}"
LOCK_FILE="${LOCK_FILE:-/var/lock/seungjae-staging-deploy.lock}"
STATE_DIR="$STAGING_DIR/.deploy"
MIN_FREE_KB="${MIN_FREE_KB:-800000}"
PM2_CONFIG="$STAGING_DIR/api-server/ecosystem.staging.json"
PM2_LAUNCHER="$STAGING_DIR/api-server/run-staging.sh"

fail() { echo "[staging] $1" >&2; exit "${2:-1}"; }

[[ "$TARGET_SHA" =~ ^[0-9a-f]{40}$ ]] || fail 'exact lowercase 40-character SHA required' 2
[[ -n "$SOURCE_DIR" && -d "$SOURCE_DIR/.git" ]] || fail 'SOURCE_DIR must be a Git checkout' 3
[[ "$STAGING_DIR" == /srv/seungjae-staging || "$STAGING_DIR" == /srv/seungjae-staging/* ]] || fail 'staging path must remain under /srv/seungjae-staging' 4
[[ "$STAGING_PM2_NAME" == seungjae-staging* ]] || fail 'staging PM2 name is not isolated' 5
[[ "$STAGING_PORT" != 8080 && "$STAGING_CANARY_PORT" != 18081 ]] || fail 'production ports are forbidden' 6
[[ -n "$STAGING_BASE_URL" ]] || fail 'STAGING_BASE_URL is required' 7
[[ "$STAGING_BASE_URL" != *'lsj119.duckdns.org'* ]] || fail 'production URL is forbidden' 8
[[ -z "$STAGING_FAILPOINT" || "$STAGING_FAILPOINT" == after-promotion ]] || fail 'unknown staging failpoint' 9

SUPABASE_VALUE_COUNT=0
[[ -n "$STAGING_SUPABASE_URL" ]] && ((SUPABASE_VALUE_COUNT += 1))
[[ -n "$STAGING_SUPABASE_ANON_KEY" ]] && ((SUPABASE_VALUE_COUNT += 1))
[[ -n "$STAGING_SUPABASE_SECRET_KEY" ]] && ((SUPABASE_VALUE_COUNT += 1))
if (( SUPABASE_VALUE_COUNT > 0 )); then
  [[ -n "$STAGING_SUPABASE_URL" ]] || fail 'STAGING_SUPABASE_URL is required when Supabase is enabled' 10
  [[ -n "$STAGING_SUPABASE_ANON_KEY" ]] || fail 'STAGING_SUPABASE_ANON_KEY is required when Supabase is enabled' 11
fi

for command_name in git node pnpm pm2 curl flock df awk rsync tar sha256sum sort xargs install ss; do
  command -v "$command_name" >/dev/null 2>&1 || fail "missing command: $command_name" 12
done

mkdir -p "$STAGING_DIR" "$RELEASE_ROOT" "$BACKUP_ROOT" "$STATE_DIR" "$(dirname "$LOCK_FILE")"
if [[ "${STAGING_LOCK_HELD:-}" != 1 ]]; then
  set +e
  flock --close --nonblock --conflict-exit-code 200 "$LOCK_FILE" env STAGING_LOCK_HELD=1 "$0" "$@"
  lock_status=$?
  set -e
  if [[ "$lock_status" == 200 ]]; then
    fail 'another staging deployment is running' 13
  fi
  exit "$lock_status"
fi

FREE_KB="$(df -Pk "$STAGING_DIR" | awk 'NR==2 {print $4}')"
[[ -n "$FREE_KB" ]] && (( FREE_KB >= MIN_FREE_KB )) || fail "insufficient staging disk space: ${FREE_KB:-unknown}KB" 14

RESOLVED_SHA="$(git -C "$SOURCE_DIR" rev-parse "$TARGET_SHA^{commit}")"
[[ "$RESOLVED_SHA" == "$TARGET_SHA" ]] || fail 'resolved SHA mismatch' 15
CURRENT_SHA="none"
[[ -s "$STATE_DIR/current-sha" ]] && CURRENT_SHA="$(tr -d '[:space:]' < "$STATE_DIR/current-sha")"
[[ "$CURRENT_SHA" == none || "$CURRENT_SHA" =~ ^[0-9a-f]{40}$ ]] || fail 'stored staging SHA is invalid' 16
CURRENT_RELEASE=""
[[ -s "$STATE_DIR/current-release" ]] && CURRENT_RELEASE="$(cat "$STATE_DIR/current-release")"
CURRENT_DEPLOYED_AT=""
[[ -s "$STATE_DIR/deployed-at" ]] && CURRENT_DEPLOYED_AT="$(cat "$STATE_DIR/deployed-at")"
CURRENT_PM2_PRESENT=0
pm2 describe "$STAGING_PM2_NAME" >/dev/null 2>&1 && CURRENT_PM2_PRESENT=1

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
RELEASE_DIR="$RELEASE_ROOT/$STAMP-${TARGET_SHA:0:10}"
BACKUP_DIR="$BACKUP_ROOT/$STAMP-${CURRENT_SHA:0:10}"
CANARY_LOG="$(mktemp /tmp/seungjae-staging-canary.XXXXXX)"
CANARY_HEALTH="$(mktemp /tmp/seungjae-staging-canary-health.XXXXXX)"
LIVE_HEALTH="$(mktemp /tmp/seungjae-staging-live-health.XXXXXX)"
CANARY_PID=""
ROLLBACK_REQUIRED=0

probe_health_url() {
  local url="$1"
  local expected_sha="$2"
  local output_file="$3"
  local attempts="${4:-20}"
  local sleep_seconds="${5:-2}"
  local attempt
  for ((attempt = 1; attempt <= attempts; attempt += 1)); do
    if curl --fail --silent --max-time 10 "$url" > "$output_file" 2>/dev/null \
      && node - "$expected_sha" "$output_file" <<'NODE'
const fs=require('fs');
const expected=process.argv[2];
const health=JSON.parse(fs.readFileSync(process.argv[3],'utf8'));
if(health.ok!==true) process.exit(1);
const reported=health.deploySha||health.sha||health.commitSha;
if(reported && reported!==expected) process.exit(1);
NODE
    then
      return 0
    fi
    sleep "$sleep_seconds"
  done
  return 1
}

sync_snapshot_tree() {
  local source_root="$1"
  local destination_root="$2"
  mkdir -p "$destination_root"
  rsync -a --delete \
    --exclude='.deploy/' \
    --exclude='.env' \
    --exclude='.env.*' \
    --exclude='*/.env' \
    --exclude='*/.env.*' \
    --exclude='logs/' \
    --exclude='*/logs/' \
    --exclude='uploads/' \
    --exclude='*/uploads/' \
    "$source_root/" "$destination_root/"
}

write_runtime_env() {
  local deploy_sha="$1"
  local env_dir="$STAGING_DIR/api-server"
  local temp_env
  mkdir -p "$env_dir"
  temp_env="$(mktemp "$env_dir/.env.staging.tmp.XXXXXX")"
  {
    printf 'NODE_ENV=production\n'
    printf 'PORT=%s\n' "$STAGING_PORT"
    printf 'API_PORT=%s\n' "$STAGING_PORT"
    printf 'APP_ENV=staging\n'
    printf 'DEPLOY_SHA=%s\n' "$deploy_sha"
    [[ -n "$STAGING_SUPABASE_URL" ]] && printf 'SUPABASE_URL=%s\n' "$STAGING_SUPABASE_URL"
    [[ -n "$STAGING_SUPABASE_ANON_KEY" ]] && printf 'SUPABASE_ANON_KEY=%s\n' "$STAGING_SUPABASE_ANON_KEY"
    [[ -n "$STAGING_SUPABASE_SECRET_KEY" ]] && printf 'SUPABASE_SECRET_KEY=%s\n' "$STAGING_SUPABASE_SECRET_KEY"
  } > "$temp_env"
  chmod 600 "$temp_env"
  mv -f "$temp_env" "$env_dir/.env.staging"
}

write_pm2_launcher() {
  mkdir -p "$STAGING_DIR/api-server"
  cat > "$PM2_LAUNCHER" <<'LAUNCHER'
#!/usr/bin/env bash
set -Eeuo pipefail
[[ -r .env.staging ]] || { echo '[staging] runtime env file is missing' >&2; exit 64; }
exec node --enable-source-maps --env-file=.env.staging ./dist/index.mjs
LAUNCHER
  chmod 700 "$PM2_LAUNCHER"
}

write_pm2_config() {
  mkdir -p "$STAGING_DIR/api-server"
  node - "$PM2_CONFIG" "$STAGING_PM2_NAME" "$STAGING_DIR/api-server" <<'NODE'
const fs = require('node:fs');
const [configPath, name, cwd] = process.argv.slice(2);
const config = {
  apps: [{
    name,
    cwd,
    script: './run-staging.sh',
    interpreter: '/bin/bash',
    autorestart: true,
    restart_delay: 1000,
  }],
};
fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
NODE
  chmod 600 "$PM2_CONFIG"
  node -e "const fs=require('node:fs'); const config=JSON.parse(fs.readFileSync(process.argv[1], 'utf8')); const app=config.apps?.[0]; if (!app || config.apps.length !== 1 || app.script !== './run-staging.sh' || app.interpreter !== '/bin/bash') process.exit(1);" "$PM2_CONFIG"
}

start_or_reload_staging() {
  write_pm2_launcher
  write_pm2_config
  pm2 startOrReload "$PM2_CONFIG" --only "$STAGING_PM2_NAME" --update-env
}

print_live_diagnostics() {
  echo '[staging] live process diagnostics' >&2
  pm2 describe "$STAGING_PM2_NAME" >&2 || true
  pm2 logs "$STAGING_PM2_NAME" --lines 120 --nostream >&2 || true
  ss -lntp "sport = :$STAGING_PORT" >&2 || true
  if [[ -s "$LIVE_HEALTH" ]]; then
    echo '[staging] last live health response' >&2
    cat "$LIVE_HEALTH" >&2 || true
  fi
}

restore_backup() {
  local restore_status=0
  echo '[staging] restoring previous staging snapshot after failed verification' >&2
  rm -f "$STAGING_DIR/api-server/.env.staging"
  sync_snapshot_tree "$BACKUP_DIR/source" "$STAGING_DIR" || restore_status=1

  if [[ "$CURRENT_SHA" == none ]]; then
    rm -f "$STATE_DIR/current-sha" "$STATE_DIR/current-release" "$STATE_DIR/deployed-at"
    if [[ "$CURRENT_PM2_PRESENT" == 0 ]]; then
      pm2 delete "$STAGING_PM2_NAME" >/dev/null 2>&1 || true
    else
      start_or_reload_staging >/dev/null 2>&1 || restore_status=1
    fi
  else
    write_runtime_env "$CURRENT_SHA" || restore_status=1
    printf '%s\n' "$CURRENT_SHA" > "$STATE_DIR/current-sha"
    if [[ -n "$CURRENT_RELEASE" ]]; then printf '%s\n' "$CURRENT_RELEASE" > "$STATE_DIR/current-release"; else rm -f "$STATE_DIR/current-release"; fi
    if [[ -n "$CURRENT_DEPLOYED_AT" ]]; then printf '%s\n' "$CURRENT_DEPLOYED_AT" > "$STATE_DIR/deployed-at"; else rm -f "$STATE_DIR/deployed-at"; fi
    start_or_reload_staging >/dev/null 2>&1 || restore_status=1
  fi
  pm2 save >/dev/null 2>&1 || true
  if [[ "$CURRENT_SHA" != none ]]; then
    probe_health_url "http://127.0.0.1:$STAGING_PORT/api/health" "$CURRENT_SHA" "$LIVE_HEALTH" 20 1 || restore_status=1
  fi
  printf '%s\n' "$TARGET_SHA" > "$STATE_DIR/last-rollback-from"
  printf '%s\n' "$CURRENT_SHA" > "$STATE_DIR/last-rollback-to"
  printf '%s\n' "$BACKUP_DIR" > "$STATE_DIR/last-rollback-backup"
  date -u +%Y-%m-%dT%H:%M:%SZ > "$STATE_DIR/last-rollback-at"
  return "$restore_status"
}

cleanup() {
  local status=$?
  trap - EXIT
  if [[ -n "$CANARY_PID" ]] && kill -0 "$CANARY_PID" 2>/dev/null; then
    kill "$CANARY_PID" 2>/dev/null || true
    wait "$CANARY_PID" 2>/dev/null || true
  fi
  rm -f "$CANARY_LOG" "$CANARY_HEALTH" "$LIVE_HEALTH"
  if (( status != 0 )) && [[ "$ROLLBACK_REQUIRED" == 1 ]] && [[ -d "$BACKUP_DIR/source" ]]; then
    restore_backup || status=91
    rm -rf -- "$RELEASE_DIR"
  fi
  exit "$status"
}
trap cleanup EXIT

mkdir -p "$RELEASE_DIR"
git -C "$SOURCE_DIR" archive "$TARGET_SHA" | tar -x -C "$RELEASE_DIR"

(
  cd "$RELEASE_DIR"
  pnpm install --frozen-lockfile
  VITE_SUPABASE_URL="$STAGING_SUPABASE_URL" \
  VITE_SUPABASE_ANON_KEY="$STAGING_SUPABASE_ANON_KEY" \
  NODE_ENV=production \
  pnpm --filter @workspace/api-server run build
)

[[ -f "$RELEASE_DIR/api-server/dist/index.mjs" ]] || fail 'API build output missing' 17
[[ -f "$RELEASE_DIR/stock-analyzer/dist/public/index.html" ]] || fail 'frontend build output missing' 18

(
  cd "$RELEASE_DIR/api-server"
  nohup env \
    PORT="$STAGING_CANARY_PORT" \
    API_PORT="$STAGING_CANARY_PORT" \
    NODE_ENV=production \
    APP_ENV=staging \
    DEPLOY_SHA="$TARGET_SHA" \
    SUPABASE_URL="$STAGING_SUPABASE_URL" \
    SUPABASE_ANON_KEY="$STAGING_SUPABASE_ANON_KEY" \
    SUPABASE_SECRET_KEY="$STAGING_SUPABASE_SECRET_KEY" \
    node --enable-source-maps ./dist/index.mjs >"$CANARY_LOG" 2>&1 &
  echo $! > "$RELEASE_DIR/.canary.pid"
)
CANARY_PID="$(cat "$RELEASE_DIR/.canary.pid")"

if ! probe_health_url "http://127.0.0.1:$STAGING_CANARY_PORT/api/health" "$TARGET_SHA" "$CANARY_HEALTH" 20 2; then
  tail -n 120 "$CANARY_LOG" >&2 || true
  fail 'canary health check failed' 19
fi
kill "$CANARY_PID" 2>/dev/null || true
wait "$CANARY_PID" 2>/dev/null || true
CANARY_PID=""

mkdir -p "$BACKUP_DIR/source"
sync_snapshot_tree "$STAGING_DIR" "$BACKUP_DIR/source"
printf '%s\n' "$CURRENT_SHA" > "$BACKUP_DIR/previous-sha.txt"
printf '%s\n' "$CURRENT_RELEASE" > "$BACKUP_DIR/previous-release.txt"
printf '%s\n' "$CURRENT_DEPLOYED_AT" > "$BACKUP_DIR/previous-deployed-at.txt"
(
  cd "$BACKUP_DIR/source"
  find . -type f -print0 | sort -z | xargs -0 -r sha256sum
) > "$BACKUP_DIR/checksums.sha256"
ROLLBACK_REQUIRED=1

rsync -a --delete \
  --exclude='.git/' \
  --exclude='.github/' \
  --exclude='node_modules/' \
  --exclude='*/node_modules/' \
  --exclude='.env' \
  --exclude='.env.*' \
  --exclude='*/.env' \
  --exclude='*/.env.*' \
  --exclude='.deploy/' \
  --exclude='logs/' \
  --exclude='*/logs/' \
  --exclude='uploads/' \
  --exclude='*/uploads/' \
  "$RELEASE_DIR/" "$STAGING_DIR/"
write_runtime_env "$TARGET_SHA"
printf '%s\n' "$TARGET_SHA" > "$STATE_DIR/current-sha"

start_or_reload_staging
pm2 save

if [[ "$STAGING_FAILPOINT" == after-promotion ]]; then
  fail 'intentional staging failpoint after promotion' 90
fi

if ! probe_health_url "http://127.0.0.1:$STAGING_PORT/api/health" "$TARGET_SHA" "$LIVE_HEALTH" 30 1; then
  print_live_diagnostics
  fail 'live staging health check failed' 20
fi
if ! probe_health_url "${STAGING_BASE_URL%/}/api/health" "$TARGET_SHA" "$LIVE_HEALTH" 10 2; then
  print_live_diagnostics
  fail 'external staging health check failed' 21
fi

printf '%s\n' "$RELEASE_DIR" > "$STATE_DIR/current-release"
printf '%s\n' "$BACKUP_DIR" > "$STATE_DIR/last-backup"
printf '%s\n' "$CURRENT_SHA" > "$STATE_DIR/previous-sha"
printf '%s\n' "$STAMP" > "$STATE_DIR/deployed-at"
ROLLBACK_REQUIRED=0

echo "[staging] deployed exact SHA: $TARGET_SHA"
echo "[staging] previous SHA: $CURRENT_SHA"
echo "[staging] backup: $BACKUP_DIR"

mapfile -t OLD_BACKUPS < <(find "$BACKUP_ROOT" -mindepth 1 -maxdepth 1 -type d -printf '%T@ %p\n' | sort -nr | awk 'NR>4 {print $2}')
for old_backup in "${OLD_BACKUPS[@]:-}"; do
  [[ -n "$old_backup" ]] && rm -rf -- "$old_backup"
done
mapfile -t OLD_RELEASES < <(find "$RELEASE_ROOT" -mindepth 1 -maxdepth 1 -type d -printf '%T@ %p\n' | sort -nr | awk 'NR>4 {print $2}')
for old_release in "${OLD_RELEASES[@]:-}"; do
  [[ -n "$old_release" && "$old_release" != "$RELEASE_DIR" && "$old_release" != "$CURRENT_RELEASE" ]] && rm -rf -- "$old_release"
done

exit 0
