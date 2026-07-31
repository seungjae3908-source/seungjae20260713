#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

APP="${APP:-/opt/stock-app}"
API="$APP/api-server"
DIST="$API/dist"
PUBLIC="${PUBLIC:-https://lsj119.duckdns.org}"
LOCAL="${LOCAL:-http://127.0.0.1:8080}"
PM2_APP="${PM2_APP:-stock-app}"
BACKUPS="${BACKUPS:-/opt/stock-app-backups}"
REAL_LOGIN_TEST="${REAL_LOGIN_TEST:-1}"
RUN="$(date -u +%Y%m%dT%H%M%SZ)-$$"
BK="$BACKUPS/auth-repair-$RUN"
TMP="$(mktemp -d)"
ARMED=0

log(){ printf '%s\n' "$*"; }
fail(){ printf 'AUTH_REPAIR=FAILED\nREASON=%s\n' "$1" >&2; exit 1; }
pm2_json(){ pm2 jlist; }
count_workers(){ pm2_json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const a=JSON.parse(s||"[]");process.stdout.write(String(a.filter(p=>/signal-worker|alert-worker|auto.?trade|order-worker/i.test(String(p.name||""))&&p.pm2_env?.status==="online").length))})'; }
count_app(){ pm2_json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const a=JSON.parse(s||"[]");process.stdout.write(String(a.filter(p=>String(p.name||"")===process.argv[1]&&p.pm2_env?.status==="online").length))})' "$PM2_APP"; }
wait_app(){ for _ in $(seq 1 30); do [[ "$(count_app)" == 1 ]] && return 0; sleep 1; done; return 1; }

health(){
  local label base out code
  label="$1"
  base="$2"
  out="$TMP/$label.health"
  code="$(curl -sS --connect-timeout 5 --max-time 15 -o "$out" -w '%{http_code}' -H 'Cache-Control: no-cache' "$base/api/health?authrepair=$RUN")" || return 1
  [[ "$code" == 200 ]] || return 1
  node -e 'const fs=require("fs");let x;try{x=JSON.parse(fs.readFileSync(process.argv[1],"utf8"))}catch{process.exit(1)};if(!(x&&(x.ok===true||x.status==="ok"||x.status==="healthy")))process.exit(1)' "$out" || return 1
  log "${label}_HEALTH=OK"
}

snapshot(){
  local out="$1"; : > "$out"
  [[ -f "$APP/stock-analyzer/dist/public/index.html" ]] && sha256sum "$APP/stock-analyzer/dist/public/index.html" >> "$out" || true
  [[ -f /etc/caddy/Caddyfile ]] && sha256sum /etc/caddy/Caddyfile >> "$out" || true
  while IFS= read -r -d '' f; do sha256sum "$f" >> "$out"; done < <(find "$APP" -maxdepth 4 -type f -name '.env*' -print0 2>/dev/null | sort -z)
}

rollback(){
  trap - EXIT; set +e; log 'ROLLBACK=STARTED'
  [[ -d "$BK/dist" ]] && { rm -rf "$DIST"; cp -a "$BK/dist" "$DIST"; }
  if [[ -f "$BK/files.list" ]]; then
    while IFS= read -r rel; do
      [[ -f "$BK/files/$rel" ]] || continue
      mkdir -p "$(dirname "$APP/$rel")"
      cp -a "$BK/files/$rel" "$APP/$rel"
    done < "$BK/files.list"
  fi
  pm2 restart "$PM2_APP" >/dev/null 2>&1
  wait_app >/dev/null 2>&1
  health ROLLBACK_LOCAL "$LOCAL" >/dev/null 2>&1 && log 'ROLLBACK_LOCAL_HEALTH=OK' || log 'ROLLBACK_LOCAL_HEALTH=FAILED'
  health ROLLBACK_PUBLIC "$PUBLIC" >/dev/null 2>&1 && log 'ROLLBACK_PUBLIC_HEALTH=OK' || log 'ROLLBACK_PUBLIC_HEALTH=FAILED'
  log "ROLLBACK_WORKERS=$(count_workers 2>/dev/null || echo UNKNOWN)"
  log 'ROLLBACK=FINISHED'
}

finish(){ local rc=$?; trap - EXIT; ((rc!=0&&ARMED==1)) && rollback; rm -rf "$TMP"; exit "$rc"; }
trap finish EXIT

for c in node pnpm pm2 curl sha256sum find grep cp cmp sort; do command -v "$c" >/dev/null || fail "${c}_missing"; done
[[ "$REAL_LOGIN_TEST" == 0 || "$REAL_LOGIN_TEST" == 1 ]] || fail 'real_login_test_invalid'
[[ -f "$API/package.json" && -f "$API/build.mjs" && -f "$DIST/index.mjs" ]] || fail 'api_or_dist_missing'
[[ "$(count_app)" == 1 ]] || fail 'stock_app_not_single_online'
WORKERS_BEFORE="$(count_workers)"
[[ "$WORKERS_BEFORE" == 0 ]] || fail 'worker_or_auto_trade_online'
log "WORKERS_BEFORE=$WORKERS_BEFORE"
node -e 'const p=require(process.argv[1]);if(!p.scripts?.["build:server"])process.exit(1)' "$API/package.json" || fail 'build_server_missing'

mapfile -t AUTH_FILES < <(grep -RIl --exclude-dir=node_modules --exclude-dir=dist --include='auth.ts' --include='auth.tsx' -E 'INVALID_CREDENTIALS|LOGIN_REQUIRED|signInWithPassword' "$APP/api-server/src" "$APP/stock-analyzer/src" 2>/dev/null | sort -u)
mapfile -t ROUTE_FILES < <(find "$APP/api-server/src" -maxdepth 6 -type f -path '*/routes/index.ts' -print 2>/dev/null | sort -u)
((${#AUTH_FILES[@]}>=1)) || fail 'auth_file_not_found'
((${#ROUTE_FILES[@]}>=1)) || fail 'routes_index_not_found'
FILES=("${AUTH_FILES[@]}" "${ROUTE_FILES[@]}")

mkdir -p "$BK/files"
cp -a "$DIST" "$BK/dist"
: > "$BK/files.list"
: > "$BK/files.sha256"
for f in "${FILES[@]}"; do
  rel="${f#"$APP"/}"
  [[ "$rel" != "$f" ]] || fail 'file_outside_app'
  printf '%s\n' "$rel" >> "$BK/files.list"
  mkdir -p "$BK/files/$(dirname "$rel")"
  cp -a "$f" "$BK/files/$rel"
  sha256sum "$f" >> "$BK/files.sha256"
done
snapshot "$BK/protected.sha256"
log "BACKUP_DIR=$BK"
log 'BACKUP=OK'
ARMED=1

pnpm --dir "$API" run build:server
node --check "$DIST/index.mjs"
grep -Fq 'INVALID_CREDENTIALS' "$DIST/index.mjs" || fail 'invalid_credentials_missing_in_bundle'
grep -Eq '(/api/auth/login|/api/login|/auth/login|/login)' "$DIST/index.mjs" || fail 'login_route_missing_in_bundle'
sha256sum -c "$BK/files.sha256" >/dev/null || fail 'source_changed_during_build'
snapshot "$TMP/protected.after"
cmp -s "$BK/protected.sha256" "$TMP/protected.after" || fail 'frontend_env_or_caddy_changed'
log 'BUILD_SERVER_ONLY=OK'
log 'NODE_CHECK=OK'
log 'PROTECTED_FILES_UNCHANGED=OK'

pm2 restart "$PM2_APP" >/dev/null
wait_app || fail 'stock_app_restart_timeout'
[[ "$(count_workers)" == 0 ]] || fail 'worker_started_after_restart'
log "PM2_RESTARTED=$PM2_APP"
health LOCAL "$LOCAL" || fail 'local_health_failed'
health PUBLIC "$PUBLIC" || fail 'public_health_failed'

payload(){ local id="$1" pw="$2"; printf '%s\0%s' "$id" "$pw" | node -e 'const fs=require("fs"),b=fs.readFileSync(0),i=b.indexOf(0);if(i<0)process.exit(1);process.stdout.write(JSON.stringify({identifier:b.subarray(0,i).toString(),password:b.subarray(i+1).toString()}))'; }
has(){ node -e 'const fs=require("fs"),s=fs.readFileSync(process.argv[1],"utf8");process.exit(s.includes(process.argv[2])?0:1)' "$1" "$2"; }

FAKE_ID="stockdeploy-$RUN@example.invalid"
FAKE_PW="Invalid-$RUN"
for label in LOCAL PUBLIC; do
  [[ "$label" == LOCAL ]] && base="$LOCAL" || base="$PUBLIC"
  body="$TMP/${label,,}-fake"
  code="$(payload "$FAKE_ID" "$FAKE_PW" | curl -sS --connect-timeout 5 --max-time 20 -o "$body" -w '%{http_code}' -H 'Cache-Control: no-cache' -H 'Content-Type: application/json' --data-binary @- "$base/api/auth/login")" || fail "${label,,}_fake_login_unreachable"
  has "$body" LOGIN_REQUIRED && fail "${label,,}_login_required_still_present"
  [[ "$code" == 401 ]] || fail "${label,,}_fake_login_http_$code"
  has "$body" INVALID_CREDENTIALS || fail "${label,,}_fake_login_not_invalid_credentials"
  log "${label}_FAKE_LOGIN_HTTP=$code"
  log "${label}_FAKE_LOGIN_ERROR=INVALID_CREDENTIALS"
done

if [[ "$REAL_LOGIN_TEST" == 1 ]]; then
  [[ -t 0 ]] || fail 'interactive_terminal_required'
  printf 'Login ID: ' >&2
  IFS= read -r RID
  printf 'Password (hidden): ' >&2
  IFS= read -rs RPW
  printf '\n' >&2
  [[ -n "$RID" && -n "$RPW" ]] || fail 'real_credentials_empty'

  REAL_RESPONSE="$(payload "$RID" "$RPW" | curl -sS --connect-timeout 5 --max-time 25 -H 'Cache-Control: no-cache' -H 'Content-Type: application/json' --data-binary @- "$PUBLIC/api/auth/login")" || { unset RID RPW; fail 'real_login_unreachable'; }
  unset RID RPW

  read -r ACCESS_TOKEN REFRESH_TOKEN < <(printf '%s' "$REAL_RESPONSE" | node -e '
const fs=require("fs");let x;try{x=JSON.parse(fs.readFileSync(0,"utf8"))}catch{process.exit(1)};
let a="",r="";const w=v=>{if(!v||typeof v!=="object")return;if(Array.isArray(v)){for(const z of v)w(z);return;}for(const[k,z]of Object.entries(v)){if(!a&&(k==="access_token"||k==="accessToken")&&typeof z==="string")a=z;else if(!r&&(k==="refresh_token"||k==="refreshToken")&&typeof z==="string")r=z;else w(z)}};w(x);if(!a||!r)process.exit(2);process.stdout.write(`${a} ${r}\n`);') || { unset REAL_RESPONSE; fail 'real_login_tokens_missing'; }
  unset REAL_RESPONSE

  ANON="$(pm2_json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{for(const p of JSON.parse(s||"[]")){if(String(p.name||"")!==process.argv[1])continue;const e=p.pm2_env||{};for(const k of ["SUPABASE_ANON_KEY","VITE_SUPABASE_ANON_KEY"]){const v=e[k]??e.env?.[k];if(typeof v==="string"&&v.length>20){process.stdout.write(v);return}}}})' "$PM2_APP")"
  [[ -n "$ANON" ]] || { unset ACCESS_TOKEN REFRESH_TOKEN; fail 'supabase_anon_key_missing'; }

  USER_CODE="$(printf '%s\0%s' "$ANON" "$ACCESS_TOKEN" | node -e 'const fs=require("fs"),b=fs.readFileSync(0),i=b.indexOf(0),q=v=>v.replace(/\\/g,"\\\\").replace(/"/g,"\\\"");if(i<0)process.exit(1);process.stdout.write(`header = "apikey: ${q(b.subarray(0,i).toString())}"\nheader = "Authorization: Bearer ${q(b.subarray(i+1).toString())}"\n`)' | curl -sS --connect-timeout 5 --max-time 20 --config - -o /dev/null -w '%{http_code}' "$PUBLIC/auth/v1/user")" || { unset ANON ACCESS_TOKEN REFRESH_TOKEN; fail 'session_user_unreachable'; }
  [[ "$USER_CODE" == 200 ]] || { unset ANON ACCESS_TOKEN REFRESH_TOKEN; fail "session_user_http_$USER_CODE"; }

  REFRESH_RESPONSE="$(printf '%s' "$REFRESH_TOKEN" | node -e 'const fs=require("fs"),r=fs.readFileSync(0,"utf8");process.stdout.write(JSON.stringify({refresh_token:r}))' | curl -sS --connect-timeout 5 --max-time 25 -H "apikey: $ANON" -H 'Content-Type: application/json' --data-binary @- "$PUBLIC/auth/v1/token?grant_type=refresh_token")" || { unset ANON ACCESS_TOKEN REFRESH_TOKEN; fail 'session_refresh_unreachable'; }
  unset ANON ACCESS_TOKEN REFRESH_TOKEN
  printf '%s' "$REFRESH_RESPONSE" | node -e 'const fs=require("fs");let x;try{x=JSON.parse(fs.readFileSync(0,"utf8"))}catch{process.exit(1)};if(typeof x.access_token!=="string"||typeof x.refresh_token!=="string")process.exit(2)' || { unset REFRESH_RESPONSE; fail 'session_refresh_invalid'; }
  unset REFRESH_RESPONSE
  log 'REAL_LOGIN=OK'
  log 'SESSION_USER_AFTER_RELOAD=OK'
  log 'SESSION_REFRESH=OK'
else
  log 'REAL_LOGIN_TEST=SKIPPED'
fi

WORKERS_AFTER="$(count_workers)"
[[ "$WORKERS_AFTER" == 0 ]] || fail 'worker_online_at_end'
[[ "$(count_app)" == 1 ]] || fail 'stock_app_not_single_online_at_end'
log "WORKERS_AFTER=$WORKERS_AFTER"
ARMED=0
log 'PM2_SAVE=NOT_RUN'
log 'AUTH_REPAIR=PASSED'
