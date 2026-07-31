#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

APP="${APP:-/opt/stock-app}"
API="$APP/api-server"
SRC="$API/src"
DIST="$API/dist"
LOCAL_URL="${LOCAL_URL:-http://127.0.0.1:8080}"
PUBLIC_URL="${PUBLIC_URL:-https://lsj119.duckdns.org}"
PM2_APP="${PM2_APP:-stock-app}"
BACKUP_ROOT="${BACKUP_ROOT:-/opt/stock-app-backups}"
RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)-$$"
BACKUP_DIR="$BACKUP_ROOT/auth-recovery-$RUN_ID"
TMP_DIR="$(mktemp -d)"
ROLLBACK_ARMED=0

log() { printf '%s\n' "$*"; }
fail() { printf 'AUTH_RECOVERY=FAILED\nREASON=%s\n' "$1" >&2; exit 1; }

pm2_json() { pm2 jlist; }

count_workers() {
  pm2_json | node -e '
let s="";
process.stdin.on("data", d => s += d).on("end", () => {
  const list = JSON.parse(s || "[]");
  const count = list.filter((p) =>
    /signal-worker|alert-worker|auto.?trade|order-worker/i.test(String(p?.name || "")) &&
    p?.pm2_env?.status === "online"
  ).length;
  process.stdout.write(String(count));
});'
}

count_app() {
  pm2_json | node -e '
let s="";
process.stdin.on("data", d => s += d).on("end", () => {
  const list = JSON.parse(s || "[]");
  const count = list.filter((p) =>
    String(p?.name || "") === process.argv[1] &&
    p?.pm2_env?.status === "online"
  ).length;
  process.stdout.write(String(count));
});' "$PM2_APP"
}

wait_for_app() {
  local attempt
  for attempt in $(seq 1 30); do
    [[ "$(count_app)" == "1" ]] && return 0
    sleep 1
  done
  return 1
}

health_check() {
  local label="$1"
  local base="$2"
  local output="$TMP_DIR/${label}.health.json"
  local code

  code="$(curl -sS --connect-timeout 5 --max-time 15 \
    -o "$output" -w '%{http_code}' \
    -H 'Cache-Control: no-cache' \
    "$base/api/health?auth_recovery=$RUN_ID")" || return 1

  [[ "$code" == "200" ]] || return 1

  node - "$output" <<'NODE'
const fs = require('fs');
let body;
try {
  body = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
} catch {
  process.exit(1);
}
if (!(body && (body.ok === true || body.status === 'ok' || body.status === 'healthy'))) {
  process.exit(1);
}
NODE

  log "${label}_HEALTH_HTTP=200"
  log "${label}_HEALTH=OK"
}

hash_tree() {
  local root="$1"
  local output="$2"

  if [[ -f "$root" ]]; then
    sha256sum "$root" >> "$output"
  elif [[ -d "$root" ]]; then
    while IFS= read -r -d '' file; do
      sha256sum "$file" >> "$output"
    done < <(find "$root" -type f -print0 | sort -z)
  fi
}

snapshot_protected() {
  local output="$1"
  : > "$output"

  hash_tree "$APP/stock-analyzer/dist" "$output"
  hash_tree "$APP/supabase" "$output"
  hash_tree "/etc/caddy/Caddyfile" "$output"

  while IFS= read -r -d '' file; do
    sha256sum "$file" >> "$output"
  done < <(
    find "$APP" -maxdepth 5 -type f \
      \( -name '.env*' -o -name '*.db' -o -name '*.db-*' -o -name '*.sqlite' -o -name '*.sqlite-*' \) \
      -print0 2>/dev/null | sort -z
  )
}

validate_source() {
  local auth="$SRC/routes/auth.ts"
  local routes="$SRC/routes/index.ts"
  local entry="$SRC/index.ts"
  local json_line
  local api_line

  [[ -f "$auth" ]] || fail 'auth_source_missing'
  [[ -f "$routes" ]] || fail 'routes_index_missing'
  [[ -f "$entry" ]] || fail 'server_entry_missing'

  grep -Eq "router\.post\(['\"]\/login['\"]" "$auth" || fail 'login_handler_missing'
  grep -Fq 'validIdentifier(req.body?.identifier)' "$auth" || fail 'identifier_validation_missing'
  grep -Fq 'signInWithPassword' "$auth" || fail 'supabase_login_missing'
  grep -Fq "error: 'INVALID_CREDENTIALS'" "$auth" || fail 'invalid_credentials_response_missing'
  grep -Eq "router\.use\(['\"]\/auth['\"],[[:space:]]*authRouter" "$routes" || fail 'public_auth_mount_missing'
  grep -Eq "app\.use\(['\"]\/api['\"],[[:space:]]*apiRouter" "$entry" || fail 'api_mount_missing'

  json_line="$(grep -n -m1 'express\.json' "$entry" | cut -d: -f1)"
  api_line="$(grep -n -m1 -E "app\.use\(['\"]\/api['\"],[[:space:]]*apiRouter" "$entry" | cut -d: -f1)"
  [[ "$json_line" =~ ^[0-9]+$ && "$api_line" =~ ^[0-9]+$ ]] || fail 'json_parser_or_api_mount_line_missing'
  (( json_line < api_line )) || fail 'json_parser_after_api_mount'

  node -e '
const pkg = require(process.argv[1]);
if (typeof pkg.scripts?.["build:server"] !== "string" || !pkg.scripts["build:server"].trim()) process.exit(1);
' "$API/package.json" || fail 'build_server_script_missing'

  log 'SOURCE_VALIDATION=OK'
}

fake_login_check() {
  local label="$1"
  local base="$2"
  local body="$TMP_DIR/${label}.fake-login.json"
  local code
  local error_name
  local fake_id="sd$(printf '%s' "$RUN_ID" | sha256sum | cut -c1-12)"
  local fake_password="Invalid!$(printf '%s' "$RUN_ID" | sha256sum | cut -c13-24)"

  code="$(node -e '
const [identifier, password] = process.argv.slice(1);
process.stdout.write(JSON.stringify({ identifier, password }));
' "$fake_id" "$fake_password" | curl -sS --connect-timeout 5 --max-time 20 \
    -o "$body" -w '%{http_code}' \
    -H 'Cache-Control: no-cache' \
    -H 'Content-Type: application/json' \
    --data-binary @- "$base/api/auth/login")" || fail "${label}_fake_login_unreachable"

  error_name="$(node - "$body" <<'NODE'
const fs = require('fs');
let body = {};
try { body = JSON.parse(fs.readFileSync(process.argv[2], 'utf8')); } catch {}
process.stdout.write(typeof body.error === 'string' ? body.error : '');
NODE
)"

  log "${label}_FAKE_LOGIN_HTTP=$code"
  log "${label}_FAKE_LOGIN_ERROR=${error_name:-NONE}"

  [[ "$error_name" != 'LOGIN_REQUIRED' ]] || fail "${label}_login_required_still_present"
  [[ "$code" == '401' && "$error_name" == 'INVALID_CREDENTIALS' ]] || fail "${label}_fake_login_not_expected_invalid_credentials"
}

rollback() {
  trap - EXIT
  set +e
  log 'ROLLBACK=STARTED'

  if [[ -d "$BACKUP_DIR/src" ]]; then
    rm -rf "$SRC"
    cp -a "$BACKUP_DIR/src" "$SRC"
  fi

  if [[ -d "$BACKUP_DIR/dist" ]]; then
    rm -rf "$DIST"
    cp -a "$BACKUP_DIR/dist" "$DIST"
  fi

  pm2 restart "$PM2_APP" >/dev/null 2>&1
  wait_for_app >/dev/null 2>&1

  health_check ROLLBACK_LOCAL "$LOCAL_URL" >/dev/null 2>&1 \
    && log 'ROLLBACK_LOCAL_HEALTH=OK' \
    || log 'ROLLBACK_LOCAL_HEALTH=FAILED'

  health_check ROLLBACK_PUBLIC "$PUBLIC_URL" >/dev/null 2>&1 \
    && log 'ROLLBACK_PUBLIC_HEALTH=OK' \
    || log 'ROLLBACK_PUBLIC_HEALTH=FAILED'

  log "ROLLBACK_PM2_PROCESS=$PM2_APP"
  log "ROLLBACK_WORKER_ONLINE_COUNT=$(count_workers 2>/dev/null || printf UNKNOWN)"
  log 'ROLLBACK=FINISHED'
}

finish() {
  local rc=$?
  trap - EXIT
  if (( rc != 0 && ROLLBACK_ARMED == 1 )); then
    rollback
  fi
  rm -rf "$TMP_DIR"
  exit "$rc"
}
trap finish EXIT

for command_name in node pnpm pm2 curl sha256sum find grep cp cmp sort flock; do
  command -v "$command_name" >/dev/null 2>&1 || fail "${command_name}_missing"
done

exec 9>"/var/lock/stockdeploy-auth-recovery.lock"
flock -n 9 || fail 'another_recovery_is_running'

[[ -d "$APP" && -d "$SRC" && -d "$DIST" ]] || fail 'app_source_or_dist_missing'
[[ -f "$DIST/index.mjs" ]] || fail 'existing_dist_bundle_missing'
[[ "$(count_app)" == '1' ]] || fail 'stock_app_not_single_online_before'

WORKERS_BEFORE="$(count_workers)"
log "WORKER_ONLINE_COUNT_BEFORE=$WORKERS_BEFORE"
[[ "$WORKERS_BEFORE" == '0' ]] || fail 'worker_or_auto_trade_online_before'

health_check PRE_LOCAL "$LOCAL_URL" || fail 'pre_local_health_failed'
health_check PRE_PUBLIC "$PUBLIC_URL" || fail 'pre_public_health_failed'
validate_source

mkdir -p "$BACKUP_DIR"
cp -a "$SRC" "$BACKUP_DIR/src"
cp -a "$DIST" "$BACKUP_DIR/dist"
: > "$BACKUP_DIR/source.sha256"
hash_tree "$SRC" "$BACKUP_DIR/source.sha256"
snapshot_protected "$BACKUP_DIR/protected.sha256"
log "BACKUP_DIR=$BACKUP_DIR"
log 'BACKUP=OK'
ROLLBACK_ARMED=1

pnpm --dir "$API" run build:server
[[ -f "$DIST/index.mjs" ]] || fail 'new_dist_bundle_missing'
node --check "$DIST/index.mjs"
grep -Fq 'INVALID_CREDENTIALS' "$DIST/index.mjs" || fail 'invalid_credentials_missing_in_new_dist'
grep -Eq '(/api/auth/login|/auth/login|/login)' "$DIST/index.mjs" || fail 'login_route_missing_in_new_dist'
log 'BUILD_COMMAND=build:server'
log 'BUILD_SERVER_ONLY=OK'
log 'NODE_CHECK=OK'
log 'LOGIN_ROUTE_IN_DIST=OK'

: > "$TMP_DIR/source.after.sha256"
hash_tree "$SRC" "$TMP_DIR/source.after.sha256"
cmp -s "$BACKUP_DIR/source.sha256" "$TMP_DIR/source.after.sha256" || fail 'source_changed_during_build'

snapshot_protected "$TMP_DIR/protected.after.sha256"
cmp -s "$BACKUP_DIR/protected.sha256" "$TMP_DIR/protected.after.sha256" || fail 'frontend_caddy_db_or_env_changed'
log 'SOURCE_UNCHANGED_DURING_BUILD=OK'
log 'FRONTEND_CADDY_DB_ENV_UNCHANGED=OK'

pm2 restart "$PM2_APP" >/dev/null
wait_for_app || fail 'stock_app_restart_timeout'
log "PM2_RESTARTED=$PM2_APP"

[[ "$(count_workers)" == '0' ]] || fail 'worker_started_after_restart'
health_check LOCAL "$LOCAL_URL" || fail 'local_health_failed'
health_check PUBLIC "$PUBLIC_URL" || fail 'public_health_failed'
fake_login_check LOCAL "$LOCAL_URL"
fake_login_check PUBLIC "$PUBLIC_URL"

WORKERS_AFTER="$(count_workers)"
[[ "$WORKERS_AFTER" == '0' ]] || fail 'worker_or_auto_trade_online_after'
[[ "$(count_app)" == '1' ]] || fail 'stock_app_not_single_online_after'

ROLLBACK_ARMED=0
log "WORKER_ONLINE_COUNT_AFTER=$WORKERS_AFTER"
log 'PM2_SAVE=NOT_RUN'
log 'CADDY_CHANGED=NO'
log 'FRONTEND_BUILD_RUN=NO'
log 'DB_OR_ENV_CHANGED=NO'
log 'REAL_LOGIN_TEST=NOT_STORED_NOT_RUN'
log 'BROWSER_LOGIN_CHECK=REQUIRED'
log 'GIT_PERSISTENCE=DEFERRED_UNTIL_BROWSER_LOGIN_SUCCESS'
log 'AUTH_RECOVERY=PASSED'
