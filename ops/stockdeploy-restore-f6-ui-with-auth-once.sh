#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

APP="${APP:-/opt/stock-app}"
FRONT="$APP/stock-analyzer"
CURRENT_AUTH="$FRONT/src/lib/auth.tsx"
CURRENT_ACCOUNT="$FRONT/src/pages/account.tsx"
PUBLIC_DIST="$FRONT/dist/public"
API="$APP/api-server"
LOCAL_URL="${LOCAL_URL:-http://127.0.0.1:8080}"
PUBLIC_URL="${PUBLIC_URL:-https://lsj119.duckdns.org}"
PM2_APP="${PM2_APP:-stock-app}"
TARGET_COMMIT="f6b2bea742a8fb8e8d239c7e477c42ce79257cc8"
BACKUP_ROOT="${BACKUP_ROOT:-/opt/stock-app-backups}"
RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)-$$"
BACKUP_DIR="$BACKUP_ROOT/restore-f6-ui-$RUN_ID"
TMP_DIR="$(mktemp -d)"
STAGE="$TMP_DIR/repo"
STAGE_FRONT="$STAGE/stock-analyzer"
ROLLBACK_ARMED=0

log() { printf '%s\n' "$*"; }
fail() { printf 'LATEST_UI_RESTORE=FAILED\nREASON=%s\n' "$1" >&2; exit 1; }

cleanup() {
  rm -rf "$TMP_DIR"
}

pm2_json() { pm2 jlist; }
count_workers() {
  pm2_json | node -e '
let text="";
process.stdin.on("data",d=>text+=d).on("end",()=>{
 const list=JSON.parse(text||"[]");
 const n=list.filter(p=>/signal-worker|alert-worker|auto.?trade|order-worker/i.test(String(p?.name||""))&&p?.pm2_env?.status==="online").length;
 process.stdout.write(String(n));
});'
}
count_named_app() {
  pm2_json | node -e '
let text="";
process.stdin.on("data",d=>text+=d).on("end",()=>{
 const list=JSON.parse(text||"[]");
 process.stdout.write(String(list.filter(p=>String(p?.name||"")===process.argv[1]).length));
});' "$PM2_APP"
}
count_online_app() {
  pm2_json | node -e '
let text="";
process.stdin.on("data",d=>text+=d).on("end",()=>{
 const list=JSON.parse(text||"[]");
 process.stdout.write(String(list.filter(p=>String(p?.name||"")===process.argv[1]&&p?.pm2_env?.status==="online").length));
});' "$PM2_APP"
}
wait_app() {
  local attempt
  for attempt in $(seq 1 90); do
    [[ "$(count_online_app)" == "1" ]] && return 0
    sleep 1
  done
  return 1
}
health_once() {
  local base
  local output
  local code
  base="$1"
  output="$2"
  code="$(curl -sS --connect-timeout 2 --max-time 5 -o "$output" -w '%{http_code}' -H 'Cache-Control: no-cache' "$base/api/health?restore_f6_ui=$RUN_ID")" || return 1
  [[ "$code" == "200" ]] || return 1
  node - "$output" <<'NODE'
const fs=require('fs');let x;try{x=JSON.parse(fs.readFileSync(process.argv[2],'utf8'))}catch{process.exit(1)}
if(!(x&&(x.ok===true||x.status==='ok'||x.status==='healthy')))process.exit(1)
NODE
}
wait_health() {
  local label
  local base
  local attempts
  local output
  local attempt
  label="$1"
  base="$2"
  attempts="${3:-120}"
  output="$TMP_DIR/${label}.health.json"
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
  local root
  local output
  root="$1"
  output="$2"
  if [[ -f "$root" ]]; then
    sha256sum "$root" >> "$output"
  elif [[ -d "$root" ]]; then
    while IFS= read -r -d '' file; do sha256sum "$file" >> "$output"; done < <(find "$root" -type f -print0 | sort -z)
  fi
}
snapshot_protected() {
  local output
  output="$1"
  : > "$output"
  hash_tree "$API/src" "$output"
  hash_tree "$API/dist" "$output"
  hash_tree "$APP/supabase" "$output"
  hash_tree "/etc/caddy/Caddyfile" "$output"
  while IFS= read -r -d '' file; do sha256sum "$file" >> "$output"; done < <(
    find "$APP" -maxdepth 5 -type f \( -name '.env*' -o -name '*.db' -o -name '*.db-*' -o -name '*.sqlite' -o -name '*.sqlite-*' \) -print0 2>/dev/null | sort -z
  )
}
fake_login() {
  local label
  local base
  local body
  local code
  local error_name
  local fake_id
  local fake_password
  label="$1"
  base="$2"
  body="$TMP_DIR/${label}.fake.json"
  fake_id="fu$(printf '%s' "$RUN_ID" | sha256sum | cut -c1-12)"
  fake_password="Invalid!$(printf '%s' "$RUN_ID" | sha256sum | cut -c13-24)"
  code="$(node -e 'const [identifier,password]=process.argv.slice(1);process.stdout.write(JSON.stringify({identifier,password}))' "$fake_id" "$fake_password" | curl -sS --connect-timeout 5 --max-time 20 -o "$body" -w '%{http_code}' -H 'Cache-Control: no-cache' -H 'Content-Type: application/json' --data-binary @- "$base/api/auth/login")" || fail "${label}_fake_login_unreachable"
  error_name="$(node - "$body" <<'NODE'
const fs=require('fs');let x={};try{x=JSON.parse(fs.readFileSync(process.argv[2],'utf8'))}catch{};process.stdout.write(typeof x.error==='string'?x.error:'')
NODE
)"
  log "${label}_FAKE_LOGIN_HTTP=$code"
  log "${label}_FAKE_LOGIN_ERROR=${error_name:-NONE}"
  [[ "$code" == "401" && "$error_name" == "INVALID_CREDENTIALS" ]] || fail "${label}_fake_login_unexpected"
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
  wait_app >/dev/null 2>&1
  wait_health ROLLBACK_LOCAL "$LOCAL_URL" 150 >/dev/null 2>&1 && log 'ROLLBACK_LOCAL_HEALTH=OK' || log 'ROLLBACK_LOCAL_HEALTH=FAILED'
  wait_health ROLLBACK_PUBLIC "$PUBLIC_URL" 150 >/dev/null 2>&1 && log 'ROLLBACK_PUBLIC_HEALTH=OK' || log 'ROLLBACK_PUBLIC_HEALTH=FAILED'
  log "ROLLBACK_WORKER_ONLINE_COUNT=$(count_workers 2>/dev/null || printf UNKNOWN)"
  log 'ROLLBACK=FINISHED'
}
finish() {
  local rc=$?
  trap - EXIT
  if (( rc != 0 && ROLLBACK_ARMED == 1 )); then rollback; fi
  cleanup
  exit "$rc"
}
trap finish EXIT

for command_name in git tar node pnpm pm2 curl sha256sum find grep cp cmp sort flock; do
  command -v "$command_name" >/dev/null 2>&1 || fail "${command_name}_missing"
done

exec 9>"/var/lock/stockdeploy-restore-f6-ui.lock"
flock -n 9 || fail 'another_ui_restore_is_running'

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || fail 'git_repository_not_found'
cd "$REPO_ROOT"
git cat-file -e "$TARGET_COMMIT^{commit}" || fail 'target_commit_missing'
[[ -f "$CURRENT_AUTH" && -f "$CURRENT_ACCOUNT" ]] || fail 'verified_auth_source_missing'
[[ -d "$PUBLIC_DIST" && -f "$PUBLIC_DIST/index.html" ]] || fail 'current_public_dist_missing'
[[ "$(count_named_app)" == "1" ]] || fail 'stock_app_process_count_not_one'
[[ "$(count_workers)" == "0" ]] || fail 'worker_online_before'
wait_health PRE_LOCAL "$LOCAL_URL" 120 || fail 'pre_local_health_failed'
wait_health PRE_PUBLIC "$PUBLIC_URL" 120 || fail 'pre_public_health_failed'

grep -Fq "fetch('/api/auth/login'" "$CURRENT_AUTH" || fail 'current_api_login_flow_missing'
grep -Fq 'auth.setSession' "$CURRENT_AUTH" || fail 'current_set_session_missing'
grep -Fq 'auth.getUser' "$CURRENT_AUTH" || fail 'current_get_user_missing'
grep -Fq 'LOGIN_SUBMIT_GUARD_V1' "$CURRENT_ACCOUNT" || fail 'current_submit_guard_missing'
log 'CURRENT_AUTH_FIX=VERIFIED'

mkdir -p "$STAGE"
git archive "$TARGET_COMMIT" | tar -x -C "$STAGE"
[[ -f "$STAGE_FRONT/package.json" && -d "$STAGE_FRONT/src" ]] || fail 'target_frontend_missing'

cp -a "$CURRENT_AUTH" "$STAGE_FRONT/src/lib/auth.tsx"
cp -a "$CURRENT_ACCOUNT" "$STAGE_FRONT/src/pages/account.tsx"
while IFS= read -r -d '' env_file; do
  cp -a "$env_file" "$STAGE_FRONT/$(basename "$env_file")"
done < <(find "$FRONT" -maxdepth 1 -type f -name '.env*' -print0)

mkdir -p "$STAGE_FRONT/public"
printf '{"uiSourceCommit":"%s","authFlow":"api-session","buildId":"%s"}\n' "$TARGET_COMMIT" "$RUN_ID" > "$STAGE_FRONT/public/ui-build-meta.json"

if [[ -d "$FRONT/node_modules" ]]; then
  rm -rf "$STAGE_FRONT/node_modules"
  ln -s "$FRONT/node_modules" "$STAGE_FRONT/node_modules"
elif [[ -d "$APP/node_modules" ]]; then
  ln -s "$APP/node_modules" "$STAGE/node_modules"
else
  fail 'frontend_node_modules_missing'
fi

mkdir -p "$BACKUP_DIR"
cp -a "$PUBLIC_DIST" "$BACKUP_DIR/public"
snapshot_protected "$BACKUP_DIR/protected.sha256"
log "BACKUP_DIR=$BACKUP_DIR"
log 'CURRENT_UI_BACKUP=OK'
ROLLBACK_ARMED=1

pnpm --dir "$STAGE_FRONT" run typecheck
NODE_ENV=production pnpm --dir "$STAGE_FRONT" run build

STAGE_DIST="$STAGE_FRONT/dist/public"
[[ -f "$STAGE_DIST/index.html" && -f "$STAGE_DIST/sw.js" && -f "$STAGE_DIST/ui-build-meta.json" ]] || fail 'target_build_output_missing'
grep -RIlF --include='*.js' '/api/auth/login' "$STAGE_DIST/assets" > "$TMP_DIR/auth-assets.list"
[[ -s "$TMP_DIR/auth-assets.list" ]] || fail 'api_login_missing_in_target_assets'
grep -RIlF --include='*.js' 'LOGIN_SUBMIT_GUARD_V1' "$STAGE_DIST/assets" > "$TMP_DIR/guard-assets.list"
[[ -s "$TMP_DIR/guard-assets.list" ]] || fail 'submit_guard_missing_in_target_assets'
grep -Fq "$TARGET_COMMIT" "$STAGE_DIST/ui-build-meta.json" || fail 'target_commit_meta_missing'

snapshot_protected "$TMP_DIR/protected.after-build.sha256"
cmp -s "$BACKUP_DIR/protected.sha256" "$TMP_DIR/protected.after-build.sha256" || fail 'backend_caddy_db_or_env_changed_during_build'
log 'TARGET_UI_TYPECHECK=OK'
log 'TARGET_UI_BUILD=OK'
log 'AUTH_FIX_IN_TARGET_ASSETS=OK'
log 'TARGET_UI_COMMIT_VERIFIED=OK'

rm -rf "$PUBLIC_DIST"
mkdir -p "$(dirname "$PUBLIC_DIST")"
cp -a "$STAGE_DIST" "$PUBLIC_DIST"

pm2 restart "$PM2_APP" >/dev/null
wait_app || fail 'stock_app_start_timeout'
wait_health LOCAL "$LOCAL_URL" 120 || fail 'local_health_failed'
wait_health PUBLIC "$PUBLIC_URL" 120 || fail 'public_health_failed'
[[ "$(count_workers)" == "0" ]] || fail 'worker_online_after_restart'
fake_login LOCAL "$LOCAL_URL"
fake_login PUBLIC "$PUBLIC_URL"

curl -fsS --connect-timeout 5 --max-time 20 -H 'Cache-Control: no-cache' "$PUBLIC_URL/?restore_f6_ui=$RUN_ID" -o "$TMP_DIR/public.index.html"
cmp -s "$PUBLIC_DIST/index.html" "$TMP_DIR/public.index.html" || fail 'public_index_not_updated'
curl -fsS --connect-timeout 5 --max-time 20 -H 'Cache-Control: no-cache' "$PUBLIC_URL/sw.js?restore_f6_ui=$RUN_ID" -o "$TMP_DIR/public.sw.js"
cmp -s "$PUBLIC_DIST/sw.js" "$TMP_DIR/public.sw.js" || fail 'public_service_worker_not_updated'
curl -fsS --connect-timeout 5 --max-time 20 -H 'Cache-Control: no-cache' "$PUBLIC_URL/ui-build-meta.json?restore_f6_ui=$RUN_ID" -o "$TMP_DIR/public.meta.json"
cmp -s "$PUBLIC_DIST/ui-build-meta.json" "$TMP_DIR/public.meta.json" || fail 'public_ui_meta_not_updated'
grep -Fq "$TARGET_COMMIT" "$TMP_DIR/public.meta.json" || fail 'public_target_commit_not_verified'

snapshot_protected "$TMP_DIR/protected.final.sha256"
cmp -s "$BACKUP_DIR/protected.sha256" "$TMP_DIR/protected.final.sha256" || fail 'backend_caddy_db_or_env_changed'
[[ "$(count_online_app)" == "1" ]] || fail 'stock_app_not_online_after'
[[ "$(count_workers)" == "0" ]] || fail 'worker_online_at_end'

ROLLBACK_ARMED=0
log "DEPLOYED_UI_SOURCE_COMMIT=$TARGET_COMMIT"
log 'PUBLIC_INDEX_UPDATED=OK'
log 'PUBLIC_SERVICE_WORKER_UPDATED=OK'
log 'PUBLIC_UI_META_UPDATED=OK'
log 'LOGIN_API_PRESERVED=YES'
log 'LOGIN_SUBMIT_GUARD_PRESERVED=YES'
log 'ACCOUNT_DATA_PRESERVED=YES'
log 'OPERATING_FRONTEND_SOURCE_CHANGED=NO'
log 'BACKEND_CADDY_DB_ENV_UNCHANGED=OK'
log 'WORKER_ONLINE_COUNT_AFTER=0'
log 'PM2_SAVE=NOT_RUN'
log 'CADDY_CHANGED=NO'
log 'BACKEND_BUILD_RUN=NO'
log 'DB_OR_ENV_CHANGED=NO'
log 'BROWSER_UI_AND_LOGIN_RETEST_REQUIRED=YES'
log 'GIT_PERSISTENCE=DEFERRED_UNTIL_LATEST_UI_VALIDATION'
log 'LATEST_UI_RESTORE=PASSED'
