#!/usr/bin/env bash
set -Eeuo pipefail

EXPECTED_SHA="${1:-}"
SOURCE_REPO="${SOURCE_REPO:-/root/stock-app-staging/work-backup-20260721/seungjae20260713}"
SHORT_SHA="${EXPECTED_SHA:0:7}"
DEPLOY_ROOT="${DEPLOY_ROOT:-/opt/stock-app-releases/${SHORT_SHA}/production}"
PUBLIC_URL="${PUBLIC_URL:-https://lsj119.duckdns.org}"
LOCAL_URL="${LOCAL_URL:-http://127.0.0.1:8080}"
MIN_FREE_MB="${MIN_FREE_MB:-2048}"
TMP_AUTH="$(mktemp)"
trap 'rm -f "$TMP_AUTH"' EXIT

fail() {
  printf 'PREFLIGHT=FAILED\nREASON=%s\n' "$1" >&2
  exit 1
}

pass() {
  printf '%s=OK\n' "$1"
}

[[ -n "$EXPECTED_SHA" ]] || fail "expected_sha_required"
[[ "$EXPECTED_SHA" =~ ^[0-9a-fA-F]{40}$ ]] || fail "expected_sha_invalid"

for tool in git curl node pnpm pm2; do
  command -v "$tool" >/dev/null 2>&1 || fail "${tool}_missing"
done
pass "TOOLS"

[[ -d "$SOURCE_REPO/.git" ]] || fail "source_repo_not_git:$SOURCE_REPO"
git -C "$SOURCE_REPO" cat-file -e "${EXPECTED_SHA}^{commit}" 2>/dev/null || fail "expected_commit_missing_in_source_repo"
printf 'SOURCE_REPO=%s\nEXPECTED_SHA=%s\nSOURCE_HEAD=%s\nSOURCE_BRANCH=%s\n' \
  "$SOURCE_REPO" \
  "$EXPECTED_SHA" \
  "$(git -C "$SOURCE_REPO" rev-parse HEAD)" \
  "$(git -C "$SOURCE_REPO" branch --show-current)"
SOURCE_DIRTY_COUNT="$(git -C "$SOURCE_REPO" status --porcelain | wc -l | tr -d ' ')"
printf 'SOURCE_DIRTY_COUNT=%s\n' "$SOURCE_DIRTY_COUNT"
pass "SOURCE_COMMIT"

[[ -d "$DEPLOY_ROOT" ]] || fail "deploy_root_missing:$DEPLOY_ROOT"
[[ -f "$DEPLOY_ROOT/api-server/dist/index.mjs" ]] || fail "deploy_api_build_missing"
[[ -f "$DEPLOY_ROOT/stock-analyzer/dist/public/index.html" ]] || fail "deploy_frontend_build_missing"
printf 'DEPLOY_ROOT=%s\n' "$DEPLOY_ROOT"
pass "DEPLOY_ARTIFACTS"

FREE_MB="$(df -Pm "$DEPLOY_ROOT" | awk 'NR==2 {print $4}')"
printf 'FREE_MB=%s\nMIN_FREE_MB=%s\n' "$FREE_MB" "$MIN_FREE_MB"
[[ "$FREE_MB" =~ ^[0-9]+$ ]] || fail "disk_check_invalid"
(( FREE_MB >= MIN_FREE_MB )) || fail "disk_space_low"
pass "DISK"

PM2_JSON="$(pm2 jlist)" || fail "pm2_jlist_failed"
WORKER_ONLINE_COUNT="$(printf '%s' "$PM2_JSON" | node -e '
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
const expected=process.argv[2];
let x;try{x=JSON.parse(raw)}catch{process.exit(2)}
if(!(x && (x.ok===true || x.status==="ok" || x.status==="healthy"))) process.exit(3)
const sha=x.commitSha ?? x.commit_sha ?? x.build?.commitSha ?? x.version?.commitSha;
if(typeof sha!=="string" || sha!==expected) process.exit(4)
' "$body" "$EXPECTED_SHA" || fail "${name}_health_or_commit_invalid"
}

check_json_health "LOCAL" "$LOCAL_URL"
check_json_health "PUBLIC" "$PUBLIC_URL"
pass "HEALTH_AND_RUNTIME_COMMIT"

SUPABASE_KEY="$(printf '%s' "$PM2_JSON" | node -e '
let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{
  const a=JSON.parse(s||"[]");
  const keys=["SUPABASE_ANON_KEY","VITE_SUPABASE_ANON_KEY"];
  for(const p of a){
    const env=p?.pm2_env||{};
    for(const k of keys){
      const v=env[k] ?? env.env?.[k];
      if(typeof v==="string" && v.length>20){process.stdout.write(v);return;}
    }
  }
});
')"
[[ -n "$SUPABASE_KEY" ]] || fail "supabase_anon_key_not_found_in_pm2"
AUTH_CODE="$(curl -sS --connect-timeout 5 --max-time 15 \
  -o "$TMP_AUTH" -w '%{http_code}' \
  -H 'Cache-Control: no-cache' \
  -H "apikey: $SUPABASE_KEY" \
  "$PUBLIC_URL/auth/v1/health")" || fail "supabase_auth_health_unreachable"
printf 'SUPABASE_AUTH_HTTP=%s\n' "$AUTH_CODE"
[[ "$AUTH_CODE" == "200" ]] || fail "supabase_auth_health_http_${AUTH_CODE}"
pass "SUPABASE_AUTH"

printf 'PREFLIGHT=PASSED\n'
