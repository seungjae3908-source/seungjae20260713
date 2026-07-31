#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

APP="${APP:-/opt/stock-app}"
FRONT="$APP/stock-analyzer"
ACCOUNT="$FRONT/src/pages/account.tsx"
AUTH="$FRONT/src/lib/auth.tsx"
PUBLIC_DIST="$FRONT/dist/public"
API="$APP/api-server"
LOCAL_URL="${LOCAL_URL:-http://127.0.0.1:8080}"
PUBLIC_URL="${PUBLIC_URL:-https://lsj119.duckdns.org}"
PM2_APP="${PM2_APP:-stock-app}"
BACKUP_ROOT="${BACKUP_ROOT:-/opt/stock-app-backups}"
RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)-$$"
BACKUP_DIR="$BACKUP_ROOT/login-submit-guard-$RUN_ID"
TMP_DIR="$(mktemp -d)"
ROLLBACK_ARMED=0

log(){ printf '%s\n' "$*"; }
fail(){ printf 'LOGIN_SUBMIT_GUARD=FAILED\nREASON=%s\n' "$1" >&2; exit 1; }
pm2_json(){ pm2 jlist; }
count_workers(){ pm2_json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const a=JSON.parse(s||"[]");process.stdout.write(String(a.filter(p=>/signal-worker|alert-worker|auto.?trade|order-worker/i.test(String(p?.name||""))&&p?.pm2_env?.status==="online").length))})'; }
count_named_app(){ pm2_json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const a=JSON.parse(s||"[]");process.stdout.write(String(a.filter(p=>String(p?.name||"")===process.argv[1]).length))})' "$PM2_APP"; }
count_online_app(){ pm2_json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const a=JSON.parse(s||"[]");process.stdout.write(String(a.filter(p=>String(p?.name||"")===process.argv[1]&&p?.pm2_env?.status==="online").length))})' "$PM2_APP"; }
wait_app(){ for _ in $(seq 1 90); do [[ "$(count_online_app)" == 1 ]] && return 0; sleep 1; done; return 1; }

health_once(){
  local base="$1" out="$2" code
  code="$(curl -sS --connect-timeout 2 --max-time 5 -o "$out" -w '%{http_code}' -H 'Cache-Control: no-cache' "$base/api/health?login_guard=$RUN_ID")" || return 1
  [[ "$code" == 200 ]] || return 1
  node - "$out" <<'NODE'
const fs=require('fs');let x;try{x=JSON.parse(fs.readFileSync(process.argv[2],'utf8'))}catch{process.exit(1)}
if(!(x&&(x.ok===true||x.status==='ok'||x.status==='healthy')))process.exit(1)
NODE
}

wait_health(){
  local label="$1" base="$2" attempts="${3:-120}" out="$TMP_DIR/${label}.health.json"
  for _ in $(seq 1 "$attempts"); do
    if health_once "$base" "$out"; then log "${label}_HEALTH_HTTP=200"; log "${label}_HEALTH=OK"; return 0; fi
    sleep 1
  done
  return 1
}

hash_tree(){
  local root="$1" out="$2"
  if [[ -f "$root" ]]; then sha256sum "$root" >> "$out";
  elif [[ -d "$root" ]]; then while IFS= read -r -d '' f; do sha256sum "$f" >> "$out"; done < <(find "$root" -type f -print0 | sort -z); fi
}

snapshot_protected(){
  local out="$1"; : > "$out"
  hash_tree "$API/src" "$out"
  hash_tree "$API/dist" "$out"
  hash_tree "$APP/supabase" "$out"
  hash_tree "/etc/caddy/Caddyfile" "$out"
  while IFS= read -r -d '' f; do sha256sum "$f" >> "$out"; done < <(find "$APP" -maxdepth 5 -type f \( -name '.env*' -o -name '*.db' -o -name '*.db-*' -o -name '*.sqlite' -o -name '*.sqlite-*' \) -print0 2>/dev/null | sort -z)
}

fake_login(){
  local label="$1" base="$2" body="$TMP_DIR/${label}.fake.json" code err
  local id="lg$(printf '%s' "$RUN_ID"|sha256sum|cut -c1-12)" pw="Invalid!$(printf '%s' "$RUN_ID"|sha256sum|cut -c13-24)"
  code="$(node -e 'const [identifier,password]=process.argv.slice(1);process.stdout.write(JSON.stringify({identifier,password}))' "$id" "$pw" | curl -sS --connect-timeout 5 --max-time 20 -o "$body" -w '%{http_code}' -H 'Cache-Control: no-cache' -H 'Content-Type: application/json' --data-binary @- "$base/api/auth/login")" || fail "${label}_fake_login_unreachable"
  err="$(node - "$body" <<'NODE'
const fs=require('fs');let x={};try{x=JSON.parse(fs.readFileSync(process.argv[2],'utf8'))}catch{};process.stdout.write(typeof x.error==='string'?x.error:'')
NODE
)"
  log "${label}_FAKE_LOGIN_HTTP=$code"
  log "${label}_FAKE_LOGIN_ERROR=${err:-NONE}"
  [[ "$err" != LOGIN_REQUIRED ]] || fail "${label}_login_required_present"
  [[ "$code" == 401 && "$err" == INVALID_CREDENTIALS ]] || fail "${label}_fake_login_unexpected"
}

rollback(){
  trap - EXIT; set +e; log 'ROLLBACK=STARTED'
  [[ -f "$BACKUP_DIR/account.tsx" ]] && cp -a "$BACKUP_DIR/account.tsx" "$ACCOUNT"
  if [[ -d "$BACKUP_DIR/public" ]]; then rm -rf "$PUBLIC_DIST"; mkdir -p "$(dirname "$PUBLIC_DIST")"; cp -a "$BACKUP_DIR/public" "$PUBLIC_DIST"; fi
  pm2 restart "$PM2_APP" >/dev/null 2>&1
  wait_app >/dev/null 2>&1
  wait_health ROLLBACK_LOCAL "$LOCAL_URL" 150 >/dev/null 2>&1 && log 'ROLLBACK_LOCAL_HEALTH=OK' || log 'ROLLBACK_LOCAL_HEALTH=FAILED'
  wait_health ROLLBACK_PUBLIC "$PUBLIC_URL" 150 >/dev/null 2>&1 && log 'ROLLBACK_PUBLIC_HEALTH=OK' || log 'ROLLBACK_PUBLIC_HEALTH=FAILED'
  log "ROLLBACK_WORKER_ONLINE_COUNT=$(count_workers 2>/dev/null || printf UNKNOWN)"
  log 'ROLLBACK=FINISHED'
}

finish(){ local rc=$?; trap - EXIT; ((rc!=0&&ROLLBACK_ARMED==1)) && rollback; rm -rf "$TMP_DIR"; exit "$rc"; }
trap finish EXIT

for c in node pnpm pm2 curl sha256sum find grep cp cmp sort flock; do command -v "$c" >/dev/null 2>&1 || fail "${c}_missing"; done
exec 9>"/var/lock/stockdeploy-login-submit-guard.lock"
flock -n 9 || fail 'another_login_guard_is_running'

[[ -f "$ACCOUNT" && -f "$AUTH" && -f "$FRONT/package.json" ]] || fail 'frontend_source_missing'
[[ -d "$PUBLIC_DIST" && -f "$PUBLIC_DIST/index.html" ]] || fail 'frontend_dist_missing'
[[ "$(count_named_app)" == 1 ]] || fail 'stock_app_process_count_not_one'
[[ "$(count_workers)" == 0 ]] || fail 'worker_online_before'
wait_health PRE_LOCAL "$LOCAL_URL" 120 || fail 'pre_local_health_failed'
wait_health PRE_PUBLIC "$PUBLIC_URL" 120 || fail 'pre_public_health_failed'
grep -Fq "fetch('/api/auth/login'" "$AUTH" || fail 'api_login_flow_missing'
grep -Fq 'auth.setSession' "$AUTH" || fail 'set_session_missing'

mkdir -p "$BACKUP_DIR"
cp -a "$ACCOUNT" "$BACKUP_DIR/account.tsx"
cp -a "$PUBLIC_DIST" "$BACKUP_DIR/public"
snapshot_protected "$BACKUP_DIR/protected.sha256"
log "BACKUP_DIR=$BACKUP_DIR"
log 'BACKUP=OK'
ROLLBACK_ARMED=1

node - "$ACCOUNT" <<'NODE'
const fs=require('fs');const p=process.argv[2];let s=fs.readFileSync(p,'utf8');
if(s.includes('LOGIN_SUBMIT_GUARD_V1')){process.exit(0)}
const before=s;
s=s.replace("import { useState, type FormEvent } from 'react';","import { useState } from 'react';");
s=s.replace(/async function submit\(event: FormEvent\) \{\s*event\.preventDefault\(\);/,"async function submit() {");
s=s.replace('<form onSubmit={submit} className="mt-5 space-y-4">','<form data-login-submit-guard="LOGIN_SUBMIT_GUARD_V1" onSubmit={(event) => { event.preventDefault(); void submit(); }} className="mt-5 space-y-4">');
s=s.replace('<button disabled={busy} className="flex w-full items-center justify-center gap-2 rounded-2xl bg-primary px-4 py-3.5 text-sm font-extrabold text-primary-foreground disabled:opacity-50">','<button type="button" onClick={() => void submit()} disabled={busy} className="flex w-full items-center justify-center gap-2 rounded-2xl bg-primary px-4 py-3.5 text-sm font-extrabold text-primary-foreground disabled:opacity-50">');
if(s===before||!s.includes('LOGIN_SUBMIT_GUARD_V1')||!s.includes('type="button" onClick={() => void submit()}'))process.exit(2);
fs.writeFileSync(p,s);
NODE

grep -Fq 'LOGIN_SUBMIT_GUARD_V1' "$ACCOUNT" || fail 'submit_guard_patch_missing'
grep -Fq 'type="button" onClick={() => void submit()}' "$ACCOUNT" || fail 'login_button_guard_missing'
log 'LOGIN_NATIVE_SUBMIT_BLOCKED=OK'

pnpm --dir "$FRONT" run typecheck
NODE_ENV=production pnpm --dir "$FRONT" run build
[[ -f "$PUBLIC_DIST/index.html" && -f "$PUBLIC_DIST/sw.js" ]] || fail 'new_frontend_build_missing'
grep -RIlF --include='*.js' 'LOGIN_SUBMIT_GUARD_V1' "$PUBLIC_DIST/assets" > "$TMP_DIR/guard-assets.list"
[[ -s "$TMP_DIR/guard-assets.list" ]] || fail 'submit_guard_missing_in_assets'
grep -RIlF --include='*.js' '/api/auth/login' "$PUBLIC_DIST/assets" > "$TMP_DIR/auth-assets.list"
[[ -s "$TMP_DIR/auth-assets.list" ]] || fail 'api_login_missing_in_assets'
snapshot_protected "$TMP_DIR/protected.after.sha256"
cmp -s "$BACKUP_DIR/protected.sha256" "$TMP_DIR/protected.after.sha256" || fail 'backend_caddy_db_or_env_changed'
log 'FRONTEND_TYPECHECK=OK'
log 'FRONTEND_BUILD=OK'
log 'SUBMIT_GUARD_IN_ASSETS=OK'
log 'BACKEND_CADDY_DB_ENV_UNCHANGED=OK'

pm2 restart "$PM2_APP" >/dev/null
wait_app || fail 'stock_app_start_timeout'
wait_health LOCAL "$LOCAL_URL" 120 || fail 'local_health_failed'
wait_health PUBLIC "$PUBLIC_URL" 120 || fail 'public_health_failed'
[[ "$(count_workers)" == 0 ]] || fail 'worker_online_after_restart'
fake_login LOCAL "$LOCAL_URL"
fake_login PUBLIC "$PUBLIC_URL"

curl -fsS --connect-timeout 5 --max-time 20 -H 'Cache-Control: no-cache' "$PUBLIC_URL/?login_guard=$RUN_ID" -o "$TMP_DIR/public.index.html"
cmp -s "$PUBLIC_DIST/index.html" "$TMP_DIR/public.index.html" || fail 'public_index_not_updated'
curl -fsS --connect-timeout 5 --max-time 20 -H 'Cache-Control: no-cache' "$PUBLIC_URL/sw.js?login_guard=$RUN_ID" -o "$TMP_DIR/public.sw.js"
cmp -s "$PUBLIC_DIST/sw.js" "$TMP_DIR/public.sw.js" || fail 'public_sw_not_updated'

[[ "$(count_online_app)" == 1 ]] || fail 'stock_app_not_online_after'
[[ "$(count_workers)" == 0 ]] || fail 'worker_online_at_end'
ROLLBACK_ARMED=0
log 'PUBLIC_INDEX_UPDATED=OK'
log 'PUBLIC_SERVICE_WORKER_UPDATED=OK'
log 'WORKER_ONLINE_COUNT_AFTER=0'
log 'PM2_SAVE=NOT_RUN'
log 'CADDY_CHANGED=NO'
log 'BACKEND_BUILD_RUN=NO'
log 'DB_OR_ENV_CHANGED=NO'
log 'APP_CREDENTIALS_REQUESTED=NO'
log 'BROWSER_LOGIN_RETEST_REQUIRED=YES'
log 'GIT_PERSISTENCE=DEFERRED_UNTIL_BROWSER_LOGIN_SUCCESS'
log 'LOGIN_SUBMIT_GUARD=PASSED'
