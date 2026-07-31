#!/usr/bin/env bash
set -Eeuo pipefail

umask 077

APP_ROOT="${APP_ROOT:-/opt/stock-app}"
PM2_NAME="${PM2_NAME:-stock-app}"
LOCAL_URL="${LOCAL_URL:-http://127.0.0.1:8080}"
PUBLIC_URL="${PUBLIC_URL:-https://lsj119.duckdns.org}"
BACKUP_ROOT="${BACKUP_ROOT:-/opt/stock-app-backups/auth-repair}"
LOCK_FILE="${LOCK_FILE:-/var/lock/stock-app-auth-repair.lock}"
HEALTH_ATTEMPTS="${HEALTH_ATTEMPTS:-12}"
HEALTH_SLEEP_SECONDS="${HEALTH_SLEEP_SECONDS:-2}"

AUTH_SOURCE="$APP_ROOT/api-server/src/routes/auth.ts"
ROUTES_SOURCE="$APP_ROOT/api-server/src/routes/index.ts"
DIST_DIR="$APP_ROOT/api-server/dist"
DIST_ENTRY="$DIST_DIR/index.mjs"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BACKUP_DIR="$BACKUP_ROOT/$STAMP"
TMP_DIR="$(mktemp -d /tmp/stock-app-auth-repair.XXXXXX)"
BACKUP_READY=0
ROLLBACK_RUNNING=0

log() {
  printf '[auth-repair] %s\n' "$*"
}

fail() {
  printf '[auth-repair] FAILED: %s\n' "$1" >&2
  return 1
}

cleanup() {
  rm -rf -- "$TMP_DIR"
}

pm2_json() {
  pm2 jlist
}

assert_exact_app_process() {
  local json count status
  json="$(pm2_json)" || fail "pm2_jlist_failed"
  read -r count status < <(printf '%s' "$json" | node - "$PM2_NAME" <<'NODE'
let source = '';
process.stdin.on('data', (chunk) => { source += chunk; });
process.stdin.on('end', () => {
  const target = process.argv[2];
  const rows = JSON.parse(source || '[]');
  const matches = rows.filter((row) => String(row?.name ?? '') === target);
  process.stdout.write(`${matches.length} ${String(matches[0]?.pm2_env?.status ?? '')}`);
});
NODE
  )
  [[ "$count" == "1" ]] || fail "pm2_process_count_${count}_for_${PM2_NAME}"
  [[ "$status" == "online" ]] || fail "pm2_process_not_online:${status}"
}

assert_workers_disabled() {
  local json matches
  json="$(pm2_json)" || fail "pm2_jlist_failed"
  matches="$(printf '%s' "$json" | node <<'NODE'
let source = '';
process.stdin.on('data', (chunk) => { source += chunk; });
process.stdin.on('end', () => {
  const rows = JSON.parse(source || '[]');
  const dangerous = rows
    .filter((row) => {
      const name = String(row?.name ?? '');
      const status = String(row?.pm2_env?.status ?? '');
      const related =
        /(?:signal|alert|order).*worker|worker.*(?:signal|alert|order)|auto[-_ ]?trading/i.test(name);
      return related && status === 'online';
    })
    .map((row) => String(row?.name ?? ''));
  process.stdout.write(dangerous.join(','));
});
NODE
  )"
  [[ -z "$matches" ]] || fail "order_related_process_online:${matches}"
  log "signal/order/auto-trading workers online=0"
}

health_once() {
  local base_url="$1"
  local output_file="$2"
  curl --fail --silent --show-error \
    --connect-timeout 5 \
    --max-time 15 \
    -H 'Cache-Control: no-cache' \
    "${base_url%/}/api/health" \
    -o "$output_file" || return 1

  node - "$output_file" <<'NODE'
const fs = require('node:fs');
const file = process.argv[2];
const value = JSON.parse(fs.readFileSync(file, 'utf8'));
if (!(value && value.ok === true)) process.exit(1);
NODE
}

wait_for_health() {
  local name="$1"
  local base_url="$2"
  local output_file="$TMP_DIR/health-${name}.json"
  local attempt

  for ((attempt = 1; attempt <= HEALTH_ATTEMPTS; attempt += 1)); do
    if health_once "$base_url" "$output_file"; then
      log "${name} /api/health=OK"
      return 0
    fi
    sleep "$HEALTH_SLEEP_SECONDS"
  done

  fail "${name}_health_failed"
}

probe_invalid_login() {
  local name="$1"
  local base_url="$2"
  local response_file="$TMP_DIR/login-${name}.json"
  local request_file="$TMP_DIR/login-${name}-request.json"
  local http_code

  node - "$request_file" <<'NODE'
const fs = require('node:fs');
const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
fs.writeFileSync(
  process.argv[2],
  JSON.stringify({
    identifier: `__stockdeploy_invalid_${suffix}`,
    password: `invalid-only-${suffix}-A9!`,
  }),
  { mode: 0o600 },
);
NODE

  http_code="$(curl --silent --show-error \
    --connect-timeout 5 \
    --max-time 20 \
    -o "$response_file" \
    -w '%{http_code}' \
    -H 'Cache-Control: no-cache' \
    -H 'Content-Type: application/json' \
    --data-binary "@$request_file" \
    "${base_url%/}/api/auth/login")" || fail "${name}_login_probe_unreachable"

  node - "$response_file" "$http_code" <<'NODE'
const fs = require('node:fs');
const file = process.argv[2];
const status = Number(process.argv[3]);
let value = null;
try {
  value = JSON.parse(fs.readFileSync(file, 'utf8'));
} catch {
  process.exit(2);
}
if (value?.error === 'LOGIN_REQUIRED') process.exit(3);
if (status !== 401 || value?.error !== 'INVALID_CREDENTIALS') process.exit(4);
NODE

  log "${name} fake login=401 INVALID_CREDENTIALS"
}

restore_previous_dist() {
  local original_status="$1"
  (( ROLLBACK_RUNNING == 0 )) || return 0
  ROLLBACK_RUNNING=1
  trap - ERR
  set +e

  printf '[auth-repair] rollback started after exit=%s\n' "$original_status" >&2

  if (( BACKUP_READY == 1 )) && [[ -d "$BACKUP_DIR/api-server-dist" ]]; then
    rm -rf -- "$DIST_DIR"
    cp -a "$BACKUP_DIR/api-server-dist" "$DIST_DIR"

    if [[ -f "$DIST_ENTRY" ]]; then
      node --check "$DIST_ENTRY" >/dev/null 2>&1 || \
        printf '[auth-repair] restored dist syntax check failed\n' >&2
    fi

    pm2 restart "$PM2_NAME" >/dev/null 2>&1 || \
      printf '[auth-repair] rollback PM2 restart failed\n' >&2

    wait_for_health "rollback-local" "$LOCAL_URL" >/dev/null 2>&1 || \
      printf '[auth-repair] rollback local health failed\n' >&2
    wait_for_health "rollback-public" "$PUBLIC_URL" >/dev/null 2>&1 || \
      printf '[auth-repair] rollback public health failed\n' >&2
    assert_workers_disabled >/dev/null 2>&1 || \
      printf '[auth-repair] worker safety check failed after rollback\n' >&2

    printf '[auth-repair] previous dist restored; only %s restarted\n' "$PM2_NAME" >&2
  else
    printf '[auth-repair] rollback backup was not ready; no files changed\n' >&2
  fi

  cleanup
  exit "$original_status"
}

on_error() {
  local status=$?
  restore_previous_dist "$status"
}

trap cleanup EXIT
trap on_error ERR

for command_name in node pnpm pm2 curl flock cp rm mkdir sha256sum; do
  command -v "$command_name" >/dev/null 2>&1 || fail "missing_command:${command_name}"
done

[[ -d "$APP_ROOT/api-server" ]] || fail "api_server_missing:$APP_ROOT/api-server"
[[ -f "$AUTH_SOURCE" ]] || fail "patched_auth_source_missing:$AUTH_SOURCE"
[[ -f "$ROUTES_SOURCE" ]] || fail "patched_routes_source_missing:$ROUTES_SOURCE"
[[ -d "$DIST_DIR" && -f "$DIST_ENTRY" ]] || fail "existing_api_dist_missing"

mkdir -p "$(dirname "$LOCK_FILE")" "$BACKUP_ROOT"
exec 9>"$LOCK_FILE"
flock -n 9 || fail "another_auth_repair_is_running"

assert_exact_app_process
assert_workers_disabled

mkdir -p "$BACKUP_DIR/source/api-server/src/routes"
cp -a "$DIST_DIR" "$BACKUP_DIR/api-server-dist"
cp -a "$AUTH_SOURCE" "$BACKUP_DIR/source/api-server/src/routes/auth.ts"
cp -a "$ROUTES_SOURCE" "$BACKUP_DIR/source/api-server/src/routes/index.ts"
sha256sum \
  "$BACKUP_DIR/source/api-server/src/routes/auth.ts" \
  "$BACKUP_DIR/source/api-server/src/routes/index.ts" \
  "$BACKUP_DIR/api-server-dist/index.mjs" \
  > "$BACKUP_DIR/SHA256SUMS"
BACKUP_READY=1
log "backup=$BACKUP_DIR"

# Intentionally server-only. Do not run frontend builds, migrations, env edits,
# Caddy changes, package installation, pm2 save or any worker command.
(
  cd "$APP_ROOT/api-server"
  pnpm run build:server
)

[[ -f "$DIST_ENTRY" ]] || fail "new_api_dist_missing"
node --check "$DIST_ENTRY"
grep -aFq 'INVALID_CREDENTIALS' "$DIST_ENTRY" || fail "invalid_credentials_marker_missing"
grep -aFq '/login' "$DIST_ENTRY" || fail "login_route_marker_missing"
grep -aFq '/auth' "$DIST_ENTRY" || fail "auth_mount_marker_missing"
log "build:server and route bundle checks=OK"

assert_workers_disabled
pm2 restart "$PM2_NAME" >/dev/null
log "pm2 restarted=$PM2_NAME (pm2 save was not run)"

wait_for_health "local" "$LOCAL_URL"
wait_for_health "public" "$PUBLIC_URL"
probe_invalid_login "local" "$LOCAL_URL"
probe_invalid_login "public" "$PUBLIC_URL"
assert_workers_disabled
assert_exact_app_process

trap - ERR
log "SUCCESS: server auth route active; rollback backup retained at $BACKUP_DIR"
