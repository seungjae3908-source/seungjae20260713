#!/usr/bin/env bash
set -Eeuo pipefail

EXPECTED_SHA="${1:-}"
APP_ROOT="${APP_ROOT:-/opt/stock-app}"
PUBLIC_URL="${PUBLIC_URL:-https://lsj119.duckdns.org}"
LOCAL_URL="${LOCAL_URL:-http://127.0.0.1:8080}"
MIN_FREE_MB="${MIN_FREE_MB:-2048}"

fail() {
  printf 'PREFLIGHT=FAILED\nREASON=%s\n' "$1" >&2
  exit 1
}

pass() {
  printf '%s=OK\n' "$1"
}

command -v git >/dev/null 2>&1 || fail "git_missing"
command -v curl >/dev/null 2>&1 || fail "curl_missing"
command -v node >/dev/null 2>&1 || fail "node_missing"
command -v pnpm >/dev/null 2>&1 || fail "pnpm_missing"
command -v pm2 >/dev/null 2>&1 || fail "pm2_missing"
pass "TOOLS"

[[ -n "$EXPECTED_SHA" ]] || fail "expected_sha_required"
[[ -d "$APP_ROOT/.git" ]] || fail "app_root_not_git_repo:$APP_ROOT"

ACTUAL_SHA="$(git -C "$APP_ROOT" rev-parse HEAD)"
printf 'EXPECTED_SHA=%s\nACTUAL_SHA=%s\n' "$EXPECTED_SHA" "$ACTUAL_SHA"
[[ "$ACTUAL_SHA" == "$EXPECTED_SHA" ]] || fail "git_sha_mismatch"
pass "GIT_SHA"

DIRTY_COUNT="$(git -C "$APP_ROOT" status --porcelain | wc -l | tr -d ' ')"
printf 'DIRTY_COUNT=%s\n' "$DIRTY_COUNT"

FREE_MB="$(df -Pm "$APP_ROOT" | awk 'NR==2 {print $4}')"
printf 'FREE_MB=%s\nMIN_FREE_MB=%s\n' "$FREE_MB" "$MIN_FREE_MB"
[[ "$FREE_MB" =~ ^[0-9]+$ ]] || fail "disk_check_invalid"
(( FREE_MB >= MIN_FREE_MB )) || fail "disk_space_low"
pass "DISK"

WORKER_ONLINE_COUNT="$(pm2 jlist | node -e '
let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{
  const a=JSON.parse(s||"[]");
  const n=a.filter(p=>/signal-worker|alert-worker/i.test(String(p.name||""))&&p.pm2_env?.status==="online").length;
  process.stdout.write(String(n));
});
')"
printf 'WORKER_ONLINE_COUNT=%s\n' "$WORKER_ONLINE_COUNT"
[[ "$WORKER_ONLINE_COUNT" == "0" ]] || fail "order_related_worker_online"
pass "WORKERS_DISABLED"

check_json_health() {
  local name="$1"
  local url="$2"
  local body
  body="$(curl -fsS --connect-timeout 5 --max-time 15 -H 'Cache-Control: no-cache' "$url/api/health")" || fail "${name}_health_unreachable"
  printf '%s_HEALTH=%s\n' "$name" "$body"
  node -e '
const raw=process.argv[1];
let x;try{x=JSON.parse(raw)}catch{process.exit(2)}
if(!(x && (x.ok===true || x.status==="ok" || x.status==="healthy"))) process.exit(3)
' "$body" || fail "${name}_health_invalid"
}

check_json_health "LOCAL" "$LOCAL_URL"
check_json_health "PUBLIC" "$PUBLIC_URL"
pass "HEALTH"

AUTH_HEALTH="$(curl -fsS --connect-timeout 5 --max-time 15 -H 'Cache-Control: no-cache' "$PUBLIC_URL/auth/v1/health")" || fail "supabase_auth_health_unreachable"
printf 'SUPABASE_AUTH_HEALTH=%s\n' "$AUTH_HEALTH"
pass "SUPABASE_AUTH"

printf 'PREFLIGHT=PASSED\n'
