#!/usr/bin/env bash
set -Eeuo pipefail

umask 077

EXPECTED_ACTIVE_SHA="${1:-}"
LIVE_DIR="${LIVE_DIR:-/opt/stock-app}"
PM2_NAME="${PM2_NAME:-stock-app}"
LIVE_PORT="${LIVE_PORT:-8080}"
PUBLIC_BASE_URL="${PUBLIC_BASE_URL:-}"
LOCK_FILE="${LOCK_FILE:-/var/lock/stock-app-deploy.lock}"
STATE_FILE="${STATE_FILE:-$LIVE_DIR/.deploy/current-sha}"
EXPECTED_ENTRY="${EXPECTED_ENTRY:-$LIVE_DIR/api-server/dist/index.mjs}"

fail() {
  printf '[pm2-orphan-repair] %s\n' "$*" >&2
  exit 1
}

for command_name in pm2 ss node curl flock readlink awk sed sort tr kill id grep ps mktemp sleep; do
  command -v "$command_name" >/dev/null 2>&1 || fail "missing command: $command_name"
done

[[ "$EXPECTED_ACTIVE_SHA" =~ ^[0-9a-f]{40}$ ]] || fail 'expected active Production SHA must be exact 40-character lowercase hex'
[[ -d "$LIVE_DIR" ]] || fail "live directory missing: $LIVE_DIR"
[[ -s "$STATE_FILE" ]] || fail "deployment state marker missing: $STATE_FILE"

ACTIVE_SHA="$(tr -d '[:space:]' < "$STATE_FILE")"
[[ "$ACTIVE_SHA" == "$EXPECTED_ACTIVE_SHA" ]] || fail 'active Production marker differs from approved repair target'

mkdir -p "$(dirname "$LOCK_FILE")"
exec 9>"$LOCK_FILE"
flock -n 9 || fail 'another Production deployment or repair is already running'

pm2_metadata() {
  pm2 jlist | node -e '
let input="";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => input += chunk);
process.stdin.on("end", () => {
  const rows = JSON.parse(input);
  const matches = rows.filter(row => row?.name === process.argv[1]);
  if (matches.length !== 1) process.exit(2);
  const row = matches[0];
  const env = row?.pm2_env;
  if (!env || typeof env !== "object" || Array.isArray(env)) process.exit(3);
  const bool = key => {
    const value = env[key];
    if (value === undefined || value === false || value === "false") return "false";
    if (value === true || value === "true") return "true";
    process.exit(4);
  };
  const executionAuthority = String(env.executionAuthority ?? "NONE");
  process.stdout.write([
    String(Number(row?.pid ?? 0)),
    String(env.status ?? "missing"),
    String(env.pm_cwd ?? "missing"),
    bool("LIVE_TELEGRAM_ACTIVATION_APPROVED"),
    bool("TELEGRAM_INTELLIGENCE_WORKER_ENABLED"),
    bool("LIVE_TRADING"),
    bool("AUTO_TRADING"),
    bool("REAL_ORDER_ENABLED"),
    bool("PRIVATE_TRADING_API_ALLOWED"),
    executionAuthority,
  ].join("\t") + "\n");
});
  ' "$PM2_NAME"
}

all_pm2_pids() {
  pm2 jlist | node -e '
let input="";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => input += chunk);
process.stdin.on("end", () => {
  const rows = JSON.parse(input);
  for (const row of rows) {
    const pid = Number(row?.pid ?? 0);
    if (Number.isInteger(pid) && pid > 0) process.stdout.write(`${pid}\n`);
  }
});
  '
}

listener_pids() {
  ss -H -ltnp 2>/dev/null \
    | awk -v port="$LIVE_PORT" '$4 ~ (":" port "$") { print }' \
    | sed -nE 's/.*pid=([0-9]+).*/\1/p' \
    | sort -u
}

probe_health_identity() {
  local base_url="$1"
  local expected_sha="$2"
  local output_file
  output_file="$(mktemp /tmp/stock-app-pm2-repair-health.XXXXXX)"
  if ! curl --fail --silent --show-error --max-time 20 "${base_url%/}/api/health" -o "$output_file"; then
    rm -f "$output_file"
    return 1
  fi
  if ! node - "$output_file" "$expected_sha" <<'NODE'
const fs = require('node:fs');
const [file, expectedSha] = process.argv.slice(2);
const value = JSON.parse(fs.readFileSync(file, 'utf8'));
const ok = value?.ok === true
  && value?.deploySha === expectedSha
  && value?.processDeploySha === expectedSha
  && value?.deployMarkerSha === expectedSha
  && value?.identityMatch === true
  && value?.identityStatus === 'match';
if (!ok) process.exit(1);
NODE
  then
    rm -f "$output_file"
    return 1
  fi
  rm -f "$output_file"
}

assert_expected_orphan() {
  local pid="$1"
  local pm2_pid="$2"
  local process_cwd process_exe resolved_arg found_entry=0 arg

  [[ "$pid" =~ ^[0-9]+$ && "$pid" -gt 1 ]] || fail 'invalid live-port listener PID'
  [[ "$pid" != "$pm2_pid" ]] || fail 'live port is already owned by the PM2 stock-app process; no orphan repair is needed'
  [[ -r "/proc/$pid/cmdline" && -e "/proc/$pid/cwd" && -e "/proc/$pid/exe" ]] || fail 'listener disappeared before validation'
  [[ "$(ps -o uid= -p "$pid" | tr -d '[:space:]')" == "$(id -u)" ]] || fail 'listener is not owned by the Production service account'

  process_exe="$(readlink -f "/proc/$pid/exe")"
  [[ "${process_exe##*/}" == node ]] || fail 'live-port listener is not the expected Node runtime'
  process_cwd="$(readlink -f "/proc/$pid/cwd")"
  [[ "$process_cwd" == "$LIVE_DIR" || "$process_cwd" == "$LIVE_DIR/"* ]] || fail 'live-port listener cwd is outside the Production application root'

  while IFS= read -r -d '' arg; do
    case "$arg" in
      /*) resolved_arg="$(readlink -m "$arg")" ;;
      *) resolved_arg="$(readlink -m "$process_cwd/$arg")" ;;
    esac
    if [[ "$resolved_arg" == "$EXPECTED_ENTRY" ]]; then
      found_entry=1
      break
    fi
  done < "/proc/$pid/cmdline"
  [[ "$found_entry" == 1 ]] || fail 'live-port listener command does not resolve to the canonical Production API entrypoint'

  if all_pm2_pids | grep -Fx "$pid" >/dev/null; then
    fail 'live-port listener is managed by a PM2 process; refusing orphan termination'
  fi
}

restart_pm2_with_safe_authority() {
  local target_sha="$1"
  local telegram_approved="$2"
  local telegram_worker="$3"
  LIVE_TELEGRAM_ACTIVATION_APPROVED="$telegram_approved" \
  TELEGRAM_INTELLIGENCE_WORKER_ENABLED="$telegram_worker" \
  LIVE_TRADING=false AUTO_TRADING=false REAL_ORDER_ENABLED=false PRIVATE_TRADING_API_ALLOWED=false \
  executionAuthority=NONE DEPLOY_SHA="$target_sha" \
    pm2 restart "$PM2_NAME" --update-env >/dev/null
}

read -r PM2_PID PM2_STATUS PM2_CWD TELEGRAM_APPROVED TELEGRAM_WORKER LIVE_TRADING AUTO_TRADING REAL_ORDER PRIVATE_API EXECUTION_AUTHORITY \
  < <(pm2_metadata | tr '\t' ' ')
[[ "$PM2_PID" =~ ^[0-9]+$ && "$PM2_PID" -gt 1 ]] || fail 'PM2 stock-app PID is missing'
[[ "$PM2_STATUS" == online ]] || fail 'PM2 stock-app is not online before repair'
[[ "$PM2_CWD" == "$LIVE_DIR" ]] || fail 'PM2 stock-app cwd differs from canonical Production root'
[[ "$TELEGRAM_APPROVED" == "$TELEGRAM_WORKER" ]] || fail 'Telegram activation state is ambiguous; refusing repair'
[[ "$LIVE_TRADING" == false && "$AUTO_TRADING" == false && "$REAL_ORDER" == false && "$PRIVATE_API" == false ]] \
  || fail 'trading authority flags are not fail-closed before repair'
[[ "$EXECUTION_AUTHORITY" == NONE ]] || fail 'executionAuthority is not NONE before repair'

mapfile -t PRE_LISTENERS < <(listener_pids)
[[ "${#PRE_LISTENERS[@]}" -eq 1 ]] || fail 'expected exactly one listener on the Production live port'
ORPHAN_PID="${PRE_LISTENERS[0]}"
assert_expected_orphan "$ORPHAN_PID" "$PM2_PID"

probe_health_identity "http://127.0.0.1:$LIVE_PORT" "$ACTIVE_SHA" || fail 'current local Production health identity is not exact before repair'
if [[ -n "$PUBLIC_BASE_URL" ]]; then
  probe_health_identity "$PUBLIC_BASE_URL" "$ACTIVE_SHA" || fail 'current public Production health identity is not exact before repair'
fi

printf '[pm2-orphan-repair] validated stale listener; stopping PM2 restart loop\n'
pm2 stop "$PM2_NAME" >/dev/null

mapfile -t STOP_LISTENERS < <(listener_pids)
if [[ "${#STOP_LISTENERS[@]}" -ne 1 || "${STOP_LISTENERS[0]}" != "$ORPHAN_PID" ]]; then
  restart_pm2_with_safe_authority "$ACTIVE_SHA" "$TELEGRAM_APPROVED" "$TELEGRAM_WORKER" || true
  pm2 save >/dev/null 2>&1 || true
  fail 'listener ownership changed after PM2 stop; repair aborted without terminating a process'
fi
probe_health_identity "http://127.0.0.1:$LIVE_PORT" "$ACTIVE_SHA" || {
  restart_pm2_with_safe_authority "$ACTIVE_SHA" "$TELEGRAM_APPROVED" "$TELEGRAM_WORKER" || true
  pm2 save >/dev/null 2>&1 || true
  fail 'orphan listener stopped serving the exact active SHA after PM2 stop'
}

printf '[pm2-orphan-repair] terminating validated orphan listener\n'
kill -TERM "$ORPHAN_PID"
for _ in {1..15}; do
  kill -0 "$ORPHAN_PID" 2>/dev/null || break
  sleep 1
done
if kill -0 "$ORPHAN_PID" 2>/dev/null; then
  assert_expected_orphan "$ORPHAN_PID" "0"
  kill -KILL "$ORPHAN_PID"
  for _ in {1..5}; do
    kill -0 "$ORPHAN_PID" 2>/dev/null || break
    sleep 1
  done
fi
if kill -0 "$ORPHAN_PID" 2>/dev/null; then
  restart_pm2_with_safe_authority "$ACTIVE_SHA" "$TELEGRAM_APPROVED" "$TELEGRAM_WORKER" || true
  pm2 save >/dev/null 2>&1 || true
  fail 'validated orphan listener could not be terminated'
fi

restart_pm2_with_safe_authority "$ACTIVE_SHA" "$TELEGRAM_APPROVED" "$TELEGRAM_WORKER"

OWNERSHIP_OK=0
for _ in {1..20}; do
  read -r NEW_PM2_PID NEW_PM2_STATUS _REST < <(pm2_metadata | tr '\t' ' ')
  mapfile -t POST_LISTENERS < <(listener_pids)
  if [[ "$NEW_PM2_STATUS" == online && "${#POST_LISTENERS[@]}" -eq 1 && "${POST_LISTENERS[0]}" == "$NEW_PM2_PID" ]] \
    && probe_health_identity "http://127.0.0.1:$LIVE_PORT" "$ACTIVE_SHA"; then
    OWNERSHIP_OK=1
    break
  fi
  sleep 1
done
[[ "$OWNERSHIP_OK" == 1 ]] || fail 'PM2 did not acquire the Production live port with the exact active SHA'

if [[ -n "$PUBLIC_BASE_URL" ]]; then
  probe_health_identity "$PUBLIC_BASE_URL" "$ACTIVE_SHA" || fail 'public Production health identity failed after PM2 ownership repair'
fi

read -r FINAL_PM2_PID FINAL_PM2_STATUS FINAL_PM2_CWD FINAL_TELEGRAM_APPROVED FINAL_TELEGRAM_WORKER FINAL_LIVE_TRADING FINAL_AUTO_TRADING FINAL_REAL_ORDER FINAL_PRIVATE_API FINAL_EXECUTION_AUTHORITY \
  < <(pm2_metadata | tr '\t' ' ')
[[ "$FINAL_PM2_STATUS" == online && "$FINAL_PM2_CWD" == "$LIVE_DIR" ]] || fail 'final PM2 runtime metadata is invalid'
[[ "$FINAL_TELEGRAM_APPROVED" == "$TELEGRAM_APPROVED" && "$FINAL_TELEGRAM_WORKER" == "$TELEGRAM_WORKER" ]] \
  || fail 'Telegram activation state changed during repair'
[[ "$FINAL_LIVE_TRADING" == false && "$FINAL_AUTO_TRADING" == false && "$FINAL_REAL_ORDER" == false && "$FINAL_PRIVATE_API" == false ]] \
  || fail 'trading authority changed during repair'
[[ "$FINAL_EXECUTION_AUTHORITY" == NONE ]] || fail 'executionAuthority changed during repair'

pm2 reset "$PM2_NAME" >/dev/null
pm2 save >/dev/null

printf '[pm2-orphan-repair] SUCCESS active_sha=%s pm2_owns_port=true trading_authority=NONE telegram_state_preserved=true\n' "$ACTIVE_SHA"
