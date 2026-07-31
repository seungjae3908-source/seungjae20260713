#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

APP="${APP:-/opt/stock-app}"
FRONT="$APP/stock-analyzer"
FRONT_SRC="$FRONT/src"
PUBLIC_DIST="$FRONT/dist/public"
API="$APP/api-server"
LOCAL_URL="${LOCAL_URL:-http://127.0.0.1:8080}"
PUBLIC_URL="${PUBLIC_URL:-https://lsj119.duckdns.org}"
PM2_APP="${PM2_APP:-stock-app}"
BACKUP_ROOT="${BACKUP_ROOT:-/opt/stock-app-backups}"
RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)-$$"
BACKUP_DIR="$BACKUP_ROOT/frontend-auth-v2-$RUN_ID"
TMP_DIR="$(mktemp -d)"
ROLLBACK_ARMED=0

log() { printf '%s\n' "$*"; }
fail() { printf 'FRONTEND_AUTH_DEPLOY=FAILED\nREASON=%s\n' "$1" >&2; exit 1; }

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

count_named_app() {
  pm2_json | node -e '
let s="";
process.stdin.on("data", d => s += d).on("end", () => {
  const list = JSON.parse(s || "[]");
  process.stdout.write(String(list.filter((p) => String(p?.name || "") === process.argv[1]).length));
});' "$PM2_APP"
}

count_online_app() {
  pm2_json | node -e '
let s="";
process.stdin.on("data", d => s += d).on("end", () => {
  const list = JSON.parse(s || "[]");
  process.stdout.write(String(list.filter((p) =>
    String(p?.name || "") === process.argv[1] && p?.pm2_env?.status === "online"
  ).length));
});' "$PM2_APP"
}

wait_for_app_status() {
  local attempt
  for attempt in $(seq 1 90); do
    [[ "$(count_online_app)" == "1" ]] && return 0
    sleep 1
  done
  return 1
}

health_once() {
  local base="$1"
  local output="$2"
  local code

  code="$(curl -sS --connect-timeout 2 --max-time 5 \
    -o "$output" -w '%{http_code}' \
    -H 'Cache-Control: no-cache' \
    "$base/api/health?frontend_auth_v2=$RUN_ID")" || return 1
  [[ "$code" == "200" ]] || return 1

  node - "$output" <<'NODE'
const fs = require('fs');
let body;
try { body = JSON.parse(fs.readFileSync(process.argv[2], 'utf8')); }
catch { process.exit(1); }
if (!(body && (body.ok === true || body.status === 'ok' || body.status === 'healthy'))) process.exit(1);
NODE
}

wait_health() {
  local label="$1"
  local base="$2"
  local attempts="${3:-90}"
  local attempt output="$TMP_DIR/${label}.health.json"

  for attempt in $(seq 1 "$attempts"); do
    if health_once "$base" "$output"; then
      log "${label}_HEALTH_HTTP=200"
      log "${label}_HEALTH=OK"
      return 0
    fi
    sleep 1
  done
  return 1
}

hash_tree() {
  local root="$1"
  local output="$2"
  if [[ -f "$root" ]]; then
    sha256sum "$root" >> "$output"
  elif [[ -d "$root" ]]; then
    while IFS= read -r -d '' file; do sha256sum "$file" >> "$output"; done \
      < <(find "$root" -type f -print0 | sort -z)
  fi
}

snapshot_front_source() {
  local output="$1"
  : > "$output"
  hash_tree "$FRONT_SRC" "$output"
  for file in package.json vite.config.ts tsconfig.json index.html; do
    [[ -f "$FRONT/$file" ]] && sha256sum "$FRONT/$file" >> "$output"
  done
}

snapshot_protected() {
  local output="$1"
  : > "$output"
  hash_tree "$API/src" "$output"
  hash_tree "$API/dist" "$output"
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

validate_login_source() {
  local auth="$FRONT_SRC/lib/auth.tsx"
  [[ -f "$auth" ]] || fail 'frontend_auth_source_missing'

  grep -Fq "fetch('/api/auth/login'" "$auth" || fail 'api_login_fetch_missing'
  grep -Fq 'JSON.stringify({ identifier, password })' "$auth" || fail 'login_request_shape_missing'
  grep -Fq 'auth.setSession' "$auth" || fail 'session_apply_missing'
  grep -Fq 'auth.getUser' "$auth" || fail 'session_verification_missing'
  grep -Fq 'signInThroughApi' "$auth" || fail 'api_signin_function_missing'

  node -e '
const pkg = require(process.argv[1]);
for (const name of ["typecheck", "build"]) {
  if (typeof pkg.scripts?.[name] !== "string" || !pkg.scripts[name].trim()) process.exit(1);
}
' "$FRONT/package.json" || fail 'frontend_scripts_missing'

  log 'FRONTEND_LOGIN_SOURCE=API_SESSION_FLOW'
  log 'FRONTEND_SOURCE_VALIDATION=OK'
}

fake_login_check() {
  local label="$1"
  local base="$2"
  local body="$TMP_DIR/${label}.fake-login.json"
  local code error_name
  local fake_id="fd$(printf '%s' "$RUN_ID" | sha256sum | cut -c1-12)"
  local fake_password="Invalid!$(printf '%s' "$RUN_ID" | sha256sum | cut -c13-24)"

  code="$(node -e '
const [identifier, password] = process.argv.slice(1);
process.stdout.write(JSON.stringify({ identifier, password }));
' "$fake_id" "$fake_password" | curl -sS --connect-timeout 5 --max-time 20 \
    -o "$body" -w '%{http_code}' \
    -H 'Cache-Control: no-cache' -H 'Content-Type: application/json' \
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
  [[ "$code" == '401' && "$error_name" == 'INVALID_CREDENTIALS' ]] \
    || fail "${label}_fake_login_not_expected_invalid_credentials"
}

recover_runtime_if_needed() {
  if health_once "$LOCAL_URL" "$TMP_DIR/pre.local.json" && \
     health_once "$PUBLIC_URL" "$TMP_DIR/pre.public.json"; then
    log 'PRE_RUNTIME_HEALTH=OK'
    return 0
  fi

  log "PRE_RUNTIME_RECOVERY_RESTART=$PM2_APP"
  pm2 restart "$PM2_APP" >/dev/null
  wait_for_app_status || fail 'pre_runtime_pm2_start_timeout'
  wait_health PRE_LOCAL "$LOCAL_URL" 120 || fail 'pre_runtime_local_health_failed'
  wait_health PRE_PUBLIC "$PUBLIC_URL" 120 || fail 'pre_runtime_public_health_failed'
}

rollback() {
  trap - EXIT
  set +e
  log 'ROLLBACK=STARTED'

  if [[ -d "$BACKUP_DIR/public" ]]; then
    rm -rf "$PUBLIC_DIST"
    mkdir -p "$(dirname "$PUBLIC_DIST")"
    cp -a "$BACKUP_DIR/public" "$PUBLIC_DIST"
  fi

  pm2 restart "$PM2_APP" >/dev/null 2>&1
  wait_for_app_status >/dev/null 2>&1

  wait_health ROLLBACK_LOCAL "$LOCAL_URL" 150 \
    && log 'ROLLBACK_LOCAL_READY=OK' || log 'ROLLBACK_LOCAL_READY=FAILED'
  wait_health ROLLBACK_PUBLIC "$PUBLIC_URL" 150 \
    && log 'ROLLBACK_PUBLIC_READY=OK' || log 'ROLLBACK_PUBLIC_READY=FAILED'

  log "ROLLBACK_PM2_PROCESS=$PM2_APP"
  log "ROLLBACK_WORKER_ONLINE_COUNT=$(count_workers 2>/dev/null || printf UNKNOWN)"
  log 'ROLLBACK=FINISHED'
}

finish() {
  local rc=$?
  trap - EXIT
  if (( rc != 0 && ROLLBACK_ARMED == 1 )); then rollback; fi
  rm -rf "$TMP_DIR"
  exit "$rc"
}
trap finish EXIT

for command_name in node pnpm pm2 curl sha256sum find grep cp cmp sort flock; do
  command -v "$command_name" >/dev/null 2>&1 || fail "${command_name}_missing"
done

exec 9>"/var/lock/stockdeploy-frontend-auth.lock"
flock -n 9 || fail 'another_frontend_deploy_is_running'

[[ -d "$FRONT_SRC" && -f "$FRONT/package.json" ]] || fail 'frontend_source_missing'
[[ -d "$PUBLIC_DIST" && -f "$PUBLIC_DIST/index.html" ]] || fail 'current_frontend_dist_missing'
[[ "$(count_named_app)" == '1' ]] || fail 'stock_app_process_count_not_one'

WORKERS_BEFORE="$(count_workers)"
log "WORKER_ONLINE_COUNT_BEFORE=$WORKERS_BEFORE"
[[ "$WORKERS_BEFORE" == '0' ]] || fail 'worker_or_auto_trade_online_before'
recover_runtime_if_needed
validate_login_source

mkdir -p "$BACKUP_DIR"
cp -a "$PUBLIC_DIST" "$BACKUP_DIR/public"
snapshot_front_source "$BACKUP_DIR/frontend-source.sha256"
snapshot_protected "$BACKUP_DIR/protected.sha256"
log "BACKUP_DIR=$BACKUP_DIR"
log 'FRONTEND_BACKUP=OK'
ROLLBACK_ARMED=1

pnpm --dir "$FRONT" run typecheck
NODE_ENV=production pnpm --dir "$FRONT" run build

[[ -f "$PUBLIC_DIST/index.html" ]] || fail 'new_index_missing'
[[ -f "$PUBLIC_DIST/sw.js" ]] || fail 'new_service_worker_missing'
[[ -d "$PUBLIC_DIST/assets" ]] || fail 'new_assets_missing'
grep -RIlF --include='*.js' '/api/auth/login' "$PUBLIC_DIST/assets" > "$TMP_DIR/login-assets.list"
[[ -s "$TMP_DIR/login-assets.list" ]] || fail 'api_login_missing_in_built_assets'
grep -RIlF --include='*.js' '로그인 응답에 Supabase session token이 없습니다' "$PUBLIC_DIST/assets" \
  > "$TMP_DIR/session-assets.list"
[[ -s "$TMP_DIR/session-assets.list" ]] || fail 'session_token_validation_missing_in_built_assets'

snapshot_front_source "$TMP_DIR/frontend-source.after.sha256"
cmp -s "$BACKUP_DIR/frontend-source.sha256" "$TMP_DIR/frontend-source.after.sha256" \
  || fail 'frontend_source_changed_during_build'
snapshot_protected "$TMP_DIR/protected.after.sha256"
cmp -s "$BACKUP_DIR/protected.sha256" "$TMP_DIR/protected.after.sha256" \
  || fail 'backend_caddy_db_or_env_changed'

log 'FRONTEND_TYPECHECK=OK'
log 'FRONTEND_BUILD=OK'
log 'API_LOGIN_IN_BUILT_ASSETS=OK'
log 'SESSION_VALIDATION_IN_BUILT_ASSETS=OK'
log 'BACKEND_CADDY_DB_ENV_UNCHANGED=OK'

pm2 restart "$PM2_APP" >/dev/null
wait_for_app_status || fail 'stock_app_pm2_start_timeout'
log "PM2_RESTARTED=$PM2_APP"
wait_health LOCAL "$LOCAL_URL" 120 || fail 'local_health_failed_after_wait'
wait_health PUBLIC "$PUBLIC_URL" 120 || fail 'public_health_failed_after_wait'
[[ "$(count_workers)" == '0' ]] || fail 'worker_started_after_restart'
fake_login_check LOCAL "$LOCAL_URL"
fake_login_check PUBLIC "$PUBLIC_URL"

curl -fsS --connect-timeout 5 --max-time 20 -H 'Cache-Control: no-cache' \
  "$PUBLIC_URL/?frontend_auth_v2=$RUN_ID" -o "$TMP_DIR/public.index.html"
cmp -s "$PUBLIC_DIST/index.html" "$TMP_DIR/public.index.html" || fail 'public_index_not_updated'

curl -fsS --connect-timeout 5 --max-time 20 -H 'Cache-Control: no-cache' \
  "$PUBLIC_URL/sw.js?frontend_auth_v2=$RUN_ID" -o "$TMP_DIR/public.sw.js"
cmp -s "$PUBLIC_DIST/sw.js" "$TMP_DIR/public.sw.js" || fail 'public_service_worker_not_updated'

WORKERS_AFTER="$(count_workers)"
[[ "$WORKERS_AFTER" == '0' ]] || fail 'worker_or_auto_trade_online_after'
[[ "$(count_online_app)" == '1' ]] || fail 'stock_app_not_online_after'

ROLLBACK_ARMED=0
log "WORKER_ONLINE_COUNT_AFTER=$WORKERS_AFTER"
log 'PUBLIC_INDEX_UPDATED=OK'
log 'PUBLIC_SERVICE_WORKER_UPDATED=OK'
log 'PM2_SAVE=NOT_RUN'
log 'CADDY_CHANGED=NO'
log 'BACKEND_BUILD_RUN=NO'
log 'DB_OR_ENV_CHANGED=NO'
log 'APP_CREDENTIALS_REQUESTED=NO'
log 'BROWSER_CACHE_REFRESH_REQUIRED=YES'
log 'GIT_PERSISTENCE=DEFERRED_UNTIL_BROWSER_LOGIN_SUCCESS'
log 'FRONTEND_AUTH_DEPLOY=PASSED'
