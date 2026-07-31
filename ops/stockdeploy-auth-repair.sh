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
LOGIN_PATHS="${LOGIN_PATHS:-/api/auth/login,/api/login,/auth/login}"
SESSION_PATHS="${SESSION_PATHS:-/api/auth/session,/api/auth/me,/api/me,/api/user/me,/api/account/me,/api/profile}"
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
    while IFS= read -r rel; do [[ -f "$BK/files/$rel" ]] || continue; mkdir -p "$(dirname "$APP/$rel")"; cp -a "$BK/files/$rel" "$APP/$rel"; done < "$BK/files.list"
  fi
  pm2 restart "$PM2_APP" >/dev/null 2>&1
  wait_app >/dev/null 2>&1
  health ROLLBACK_LOCAL "$LOCAL" >/dev/null 2>&1 && log 'ROLLBACK_LOCAL_HEALTH=OK' || log 'ROLLBACK_LOCAL_HEALTH=FAILED'
  log "ROLLBACK_WORKERS=$(count_workers 2>/dev/null || echo UNKNOWN)"
  log 'ROLLBACK=FINISHED'
}

finish(){ local rc=$?; trap - EXIT; ((rc!=0&&ARMED==1)) && rollback; rm -rf "$TMP"; exit "$rc"; }
trap finish EXIT

for c in node pnpm pm2 curl sha256sum find grep cp; do command -v "$c" >/dev/null || fail "${c}_missing"; done
[[ -f "$API/package.json" && -f "$API/build.mjs" && -f "$DIST/index.mjs" ]] || fail 'api_or_dist_missing'
[[ "$(count_app)" == 1 ]] || fail 'stock_app_not_single_online'
[[ "$(count_workers)" == 0 ]] || fail 'worker_or_auto_trade_online'
node -e 'const p=require(process.argv[1]);if(!p.scripts?.["build:server"])process.exit(1)' "$API/package.json" || fail 'build_server_missing'

mapfile -t AUTH_FILES < <(grep -RIl --exclude-dir=node_modules --exclude-dir=dist --include='auth.ts' --include='auth.tsx' -E 'INVALID_CREDENTIALS|LOGIN_REQUIRED|signInWithPassword' "$APP/api-server/src" "$APP/stock-analyzer/src" 2>/dev/null | sort -u)
mapfile -t ROUTE_FILES < <(find "$APP/api-server/src" -maxdepth 6 -type f -path '*/routes/index.ts' -print 2>/dev/null | sort -u)
((${#AUTH_FILES[@]}>=1)) || fail 'auth_file_not_found'
((${#ROUTE_FILES[@]}>=1)) || fail 'routes_index_not_found'
FILES=("${AUTH_FILES[@]}" "${ROUTE_FILES[@]}")

mkdir -p "$BK/files"; cp -a "$DIST" "$BK/dist"; : > "$BK/files.list"; : > "$BK/files.sha256"
for f in "${FILES[@]}"; do rel="${f#"$APP"/}"; [[ "$rel" != "$f" ]] || fail 'file_outside_app'; printf '%s\n' "$rel" >> "$BK/files.list"; mkdir -p "$BK/files/$(dirname "$rel")"; cp -a "$f" "$BK/files/$rel"; sha256sum "$f" >> "$BK/files.sha256"; done
snapshot "$BK/protected.sha256"
log "BACKUP_DIR=$BK"; log 'BACKUP=OK'; ARMED=1

pnpm --dir "$API" run build:server
node --check "$DIST/index.mjs"
grep -Fq 'INVALID_CREDENTIALS' "$DIST/index.mjs" || fail 'invalid_credentials_missing_in_bundle'
grep -Eq '(/api/auth/login|/api/login|/auth/login|/login)' "$DIST/index.mjs" || fail 'login_route_missing_in_bundle'
sha256sum -c "$BK/files.sha256" >/dev/null || fail 'source_changed_during_build'
snapshot "$TMP/protected.after"; cmp -s "$BK/protected.sha256" "$TMP/protected.after" || fail 'frontend_env_or_caddy_changed'
log 'BUILD_SERVER_ONLY=OK'; log 'NODE_CHECK=OK'; log 'PROTECTED_FILES_UNCHANGED=OK'

pm2 restart "$PM2_APP" >/dev/null
wait_app || fail 'stock_app_restart_timeout'
[[ "$(count_workers)" == 0 ]] || fail 'worker_started_after_restart'
health LOCAL "$LOCAL" || fail 'local_health_failed'
health PUBLIC "$PUBLIC" || fail 'public_health_failed'

payload(){ local kind="$1" id="$2" pw="$3"; printf '%s\0%s' "$id" "$pw" | node -e 'const fs=require("fs"),k=process.argv[1],b=fs.readFileSync(0),i=b.indexOf(0);if(i<0)process.exit(1);const x={password:b.subarray(i+1).toString()};x[k]=b.subarray(0,i).toString();process.stdout.write(JSON.stringify(x))' "$kind"; }
has(){ node -e 'const fs=require("fs"),s=fs.readFileSync(process.argv[1],"utf8");process.exit(s.includes(process.argv[2])?0:1)' "$1" "$2"; }

FAKE_ID="stockdeploy-$RUN@example.invalid"; FAKE_PW="Invalid-$RUN"; PATH_OK=''; KIND_OK=''
IFS=',' read -r -a PATH_ARR <<< "$LOGIN_PATHS"
for p in "${PATH_ARR[@]}"; do for k in email username identifier; do body="$TMP/fake"; code="$(payload "$k" "$FAKE_ID" "$FAKE_PW" | curl -sS --connect-timeout 5 --max-time 20 -o "$body" -w '%{http_code}' -H 'Content-Type: application/json' --data-binary @- "$LOCAL$p")" || continue; has "$body" LOGIN_REQUIRED && continue; if has "$body" INVALID_CREDENTIALS; then PATH_OK="$p"; KIND_OK="$k"; log "LOCAL_FAKE_LOGIN_HTTP=$code"; break 2; fi; done; done
[[ -n "$PATH_OK" ]] || fail 'local_fake_login_not_invalid_credentials'
body="$TMP/public-fake"; code="$(payload "$KIND_OK" "$FAKE_ID" "$FAKE_PW" | curl -sS --connect-timeout 5 --max-time 20 -o "$body" -w '%{http_code}' -H 'Content-Type: application/json' --data-binary @- "$PUBLIC$PATH_OK")" || fail 'public_fake_login_unreachable'
has "$body" LOGIN_REQUIRED && fail 'public_login_required_still_present'; has "$body" INVALID_CREDENTIALS || fail 'public_fake_login_not_invalid_credentials'
log "LOGIN_PATH=$PATH_OK"; log "PUBLIC_FAKE_LOGIN_HTTP=$code"; log 'LOGIN_REQUIRED_REMOVED=OK'

if [[ "$REAL_LOGIN_TEST" == 1 ]]; then
  [[ -t 0 ]] || fail 'interactive_terminal_required'
  printf 'Login ID: ' >&2; IFS= read -r RID
  printf 'Password (hidden): ' >&2; IFS= read -rs RPW; printf '\n' >&2
  [[ -n "$RID" && -n "$RPW" ]] || fail 'real_credentials_empty'
  RBODY="$TMP/real"; CJAR="$TMP/cookies"; RHTTP="$(payload "$KIND_OK" "$RID" "$RPW" | curl -sS --connect-timeout 5 --max-time 25 -c "$CJAR" -o "$RBODY" -w '%{http_code}' -H 'Content-Type: application/json' --data-binary @- "$PUBLIC$PATH_OK")" || fail 'real_login_unreachable'; unset RID RPW
  [[ "$RHTTP" =~ ^2 ]] || fail "real_login_http_$RHTTP"; has "$RBODY" LOGIN_REQUIRED && fail 'real_login_required'; has "$RBODY" INVALID_CREDENTIALS && fail 'real_invalid_credentials'
  TOKEN="$TMP/token"; CFG="$TMP/curl.conf"
  node -e 'const fs=require("fs");let x;try{x=JSON.parse(fs.readFileSync(process.argv[1],"utf8"))}catch{process.exit(0)};let t="";const w=v=>{if(t||!v)return;if(Array.isArray(v))return v.forEach(w);if(typeof v==="object")for(const[k,z]of Object.entries(v)){if((k==="access_token"||k==="accessToken")&&typeof z==="string"){t=z;break}w(z)}};w(x);if(t)fs.writeFileSync(process.argv[2],t,{mode:0o600})' "$RBODY" "$TOKEN"
  if [[ -s "$TOKEN" ]]; then node -e 'const fs=require("fs"),t=fs.readFileSync(process.argv[1],"utf8").trim().replace(/["\\]/g,m=>"\\"+m);fs.writeFileSync(process.argv[2],`header = "Authorization: Bearer ${t}"\n`,{mode:0o600})' "$TOKEN" "$CFG"; else : > "$CFG"; fi
  OK=0; IFS=',' read -r -a SARR <<< "$SESSION_PATHS"
  for s in "${SARR[@]}"; do SB="$TMP/session"; SH="$(curl -sS --connect-timeout 5 --max-time 20 --config "$CFG" -b "$CJAR" -o "$SB" -w '%{http_code}' "$PUBLIC$s")" || continue; if [[ "$SH" =~ ^2 ]] && ! has "$SB" LOGIN_REQUIRED; then OK=1; log "SESSION_PATH=$s"; log "SESSION_RELOAD_HTTP=$SH"; break; fi; done
  if ((OK==0)) && [[ -s "$TOKEN" ]]; then
    ANON="$(pm2_json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{for(const p of JSON.parse(s||"[]")){const e=p.pm2_env||{};for(const k of ["SUPABASE_ANON_KEY","VITE_SUPABASE_ANON_KEY"]){const v=e[k]??e.env?.[k];if(typeof v==="string"&&v.length>20){process.stdout.write(v);return}}}})')"
    if [[ -n "$ANON" ]]; then
      node -e 'const fs=require("fs"),a=process.argv[1].replace(/["\\]/g,m=>"\\"+m);fs.appendFileSync(process.argv[2],`header = "apikey: ${a}"\n`,{mode:0o600})' "$ANON" "$CFG"; unset ANON
      SB="$TMP/supabase-user"; SH="$(curl -sS --connect-timeout 5 --max-time 20 --config "$CFG" -o "$SB" -w '%{http_code}' "$PUBLIC/auth/v1/user")" || true
      if [[ "$SH" == 200 ]]; then OK=1; log 'SESSION_PATH=/auth/v1/user'; log 'SESSION_RELOAD_HTTP=200'; fi
    fi
  fi
  ((OK==1)) || fail 'session_reload_failed'; log 'REAL_LOGIN_AND_SESSION_RELOAD=OK'
fi

[[ "$(count_workers)" == 0 ]] || fail 'worker_online_at_end'
ARMED=0
log 'PM2_SAVE=NOT_RUN'; log 'AUTH_REPAIR=PASSED'
