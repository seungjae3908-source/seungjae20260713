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
  printf '[pm2-watch-normalize] %s\n' "$*" >&2
  exit 1
}

for command_name in pm2 ss node curl flock readlink awk sed sort tr id ps sleep; do
  command -v "$command_name" >/dev/null 2>&1 || fail "missing command: $command_name"
done

[[ "$EXPECTED_ACTIVE_SHA" =~ ^[0-9a-f]{40}$ ]] || fail 'expected active Production SHA must be exact 40-character lowercase hex'
[[ -d "$LIVE_DIR" ]] || fail "live directory missing: $LIVE_DIR"
[[ -s "$STATE_FILE" ]] || fail "deployment state marker missing: $STATE_FILE"

ACTIVE_SHA="$(tr -d '[:space:]' < "$STATE_FILE")"
[[ "$ACTIVE_SHA" == "$EXPECTED_ACTIVE_SHA" ]] || fail 'active Production marker differs from approved normalization target'

mkdir -p "$(dirname "$LOCK_FILE")"
exec 9>"$LOCK_FILE"
flock -n 9 || fail 'another Production deployment or repair is already running'

pm2_snapshot() {
  pm2 jlist | node -e '
const reject = () => process.exit(1);
let rows;
try { rows = JSON.parse(require("node:fs").readFileSync(0, "utf8")); } catch { reject(); }
if (!Array.isArray(rows)) reject();
const matches = rows.filter((row) => row?.name === process.argv[1]);
if (matches.length !== 1) reject();
const row = matches[0];
const env = row?.pm2_env;
if (!env || typeof env !== "object" || Array.isArray(env)) reject();
const bool = (key) => {
  const value = env[key];
  if (value === undefined || value === false || value === "false") return "false";
  if (value === true || value === "true") return "true";
  reject();
};
const watched = env.watch === true || (Array.isArray(env.watch) && env.watch.length > 0);
process.stdout.write([
  String(Number(row?.pid ?? 0)),
  String(env.status ?? "missing"),
  String(env.pm_cwd ?? "missing"),
  String(env.pm_exec_path ?? "missing"),
  watched ? "true" : "false",
  bool("LIVE_TELEGRAM_ACTIVATION_APPROVED"),
  bool("TELEGRAM_INTELLIGENCE_WORKER_ENABLED"),
  bool("LIVE_TRADING"),
  bool("AUTO_TRADING"),
  bool("REAL_ORDER_ENABLED"),
  bool("PRIVATE_TRADING_API_ALLOWED"),
  String(env.executionAuthority ?? "NONE"),
].join("\t") + "\n");
  ' "$PM2_NAME"
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
  output_file="$(mktemp /tmp/stock-app-pm2-watch-health.XXXXXX)"
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

read -r PM2_PID PM2_STATUS PM2_CWD PM2_EXEC WATCHED TELEGRAM_APPROVED TELEGRAM_WORKER LIVE_TRADING AUTO_TRADING REAL_ORDER PRIVATE_API EXECUTION_AUTHORITY \
  < <(pm2_snapshot | tr '\t' ' ')

[[ "$PM2_PID" =~ ^[0-9]+$ && "$PM2_PID" -gt 1 ]] || fail 'PM2 stock-app PID is missing'
[[ "$PM2_STATUS" == online ]] || fail 'PM2 stock-app is not online before normalization'
[[ "$PM2_CWD" == "$LIVE_DIR" ]] || fail 'PM2 stock-app cwd differs from canonical Production root'
[[ "$(readlink -m "$PM2_EXEC")" == "$EXPECTED_ENTRY" ]] || fail 'PM2 stock-app entrypoint differs from canonical prebuilt Production API'
[[ "$(ps -o uid= -p "$PM2_PID" | tr -d '[:space:]')" == "$(id -u)" ]] || fail 'PM2 stock-app is not owned by the Production service account'
[[ "$TELEGRAM_APPROVED" == "$TELEGRAM_WORKER" ]] || fail 'Telegram activation state is ambiguous; refusing normalization'
[[ "$LIVE_TRADING" == false && "$AUTO_TRADING" == false && "$REAL_ORDER" == false && "$PRIVATE_API" == false ]] \
  || fail 'trading authority flags are not fail-closed before normalization'
[[ "$EXECUTION_AUTHORITY" == NONE ]] || fail 'executionAuthority is not NONE before normalization'

mapfile -t PRE_LISTENERS < <(listener_pids)
[[ "${#PRE_LISTENERS[@]}" -eq 1 && "${PRE_LISTENERS[0]}" == "$PM2_PID" ]] \
  || fail 'PM2 stock-app PID is not the sole Production live-port listener before normalization'

probe_health_identity "http://127.0.0.1:$LIVE_PORT" "$ACTIVE_SHA" \
  || fail 'current local Production health identity is not exact before normalization'
if [[ -n "$PUBLIC_BASE_URL" ]]; then
  probe_health_identity "$PUBLIC_BASE_URL" "$ACTIVE_SHA" \
    || fail 'current public Production health identity is not exact before normalization'
fi

safe_restart() {
  LIVE_TELEGRAM_ACTIVATION_APPROVED="$TELEGRAM_APPROVED" \
  TELEGRAM_INTELLIGENCE_WORKER_ENABLED="$TELEGRAM_WORKER" \
  LIVE_TRADING=false AUTO_TRADING=false REAL_ORDER_ENABLED=false PRIVATE_TRADING_API_ALLOWED=false \
  executionAuthority=NONE DEPLOY_SHA="$ACTIVE_SHA" \
  pm2 restart "$PM2_NAME" --update-env >/dev/null
}

pm2_owns_live_port() {
  local snapshot pid status _rest
  snapshot="$(pm2_snapshot 2>/dev/null)" || return 1
  IFS=$'\t' read -r pid status _rest <<< "$snapshot"
  [[ "$pid" =~ ^[0-9]+$ && "$pid" -gt 1 && "$status" == online ]] || return 1
  mapfile -t current_listeners < <(listener_pids)
  [[ "${#current_listeners[@]}" -eq 1 && "${current_listeners[0]}" == "$pid" ]]
}

if [[ "$WATCHED" == false ]]; then
  pm2 save >/dev/null
  printf '[pm2-watch-normalize] SUCCESS active_sha=%s already_watch_false=true pm2_owns_port=true trading_authority=NONE\n' "$ACTIVE_SHA"
  exit 0
fi
[[ "$WATCHED" == true ]] || fail 'PM2 watch state is ambiguous'

NORMALIZATION_STARTED=0
NORMALIZATION_COMPLETE=0
normalization_failure_cleanup() {
  local status=$?
  if (( status != 0 )) && [[ "$NORMALIZATION_STARTED" == 1 && "$NORMALIZATION_COMPLETE" != 1 ]]; then
    printf '[pm2-watch-normalize] normalization failed after stop; restoring exact active service with watch disabled\n' >&2
    safe_restart || {
      printf '[pm2-watch-normalize] CRITICAL: PM2 restart failed during recovery\n' >&2
      return "$status"
    }
    for _ in {1..20}; do
      if pm2_owns_live_port && probe_health_identity "http://127.0.0.1:$LIVE_PORT" "$ACTIVE_SHA"; then
        pm2 save >/dev/null 2>&1 || true
        break
      fi
      sleep 1
    done
  fi
  return "$status"
}
trap normalization_failure_cleanup EXIT

printf '[pm2-watch-normalize] validated exact PM2-owned Production listener; disabling watch\n'
pm2 stop "$PM2_NAME" --watch >/dev/null
NORMALIZATION_STARTED=1

for _ in {1..10}; do
  mapfile -t STOP_LISTENERS < <(listener_pids)
  [[ "${#STOP_LISTENERS[@]}" -eq 0 ]] && break
  sleep 1
done
mapfile -t STOP_LISTENERS < <(listener_pids)
[[ "${#STOP_LISTENERS[@]}" -eq 0 ]] || fail 'Production live port remained occupied after PM2 stop --watch'

safe_restart

OWNERSHIP_OK=0
for _ in {1..20}; do
  if pm2_owns_live_port && probe_health_identity "http://127.0.0.1:$LIVE_PORT" "$ACTIVE_SHA"; then
    OWNERSHIP_OK=1
    break
  fi
  sleep 1
done
[[ "$OWNERSHIP_OK" == 1 ]] || fail 'PM2 did not reacquire the Production live port with exact active SHA'

read -r FINAL_PID FINAL_STATUS FINAL_CWD FINAL_EXEC FINAL_WATCH FINAL_TELEGRAM_APPROVED FINAL_TELEGRAM_WORKER FINAL_LIVE FINAL_AUTO FINAL_REAL FINAL_PRIVATE FINAL_AUTHORITY \
  < <(pm2_snapshot | tr '\t' ' ')
[[ "$FINAL_STATUS" == online && "$FINAL_CWD" == "$LIVE_DIR" ]] || fail 'final PM2 runtime metadata is invalid'
[[ "$(readlink -m "$FINAL_EXEC")" == "$EXPECTED_ENTRY" ]] || fail 'final PM2 entrypoint is not the canonical prebuilt Production API'
[[ "$FINAL_WATCH" == false ]] || fail 'final PM2 watch mode must be disabled'
[[ "$FINAL_TELEGRAM_APPROVED" == "$TELEGRAM_APPROVED" && "$FINAL_TELEGRAM_WORKER" == "$TELEGRAM_WORKER" ]] \
  || fail 'Telegram activation state changed during watch normalization'
[[ "$FINAL_LIVE" == false && "$FINAL_AUTO" == false && "$FINAL_REAL" == false && "$FINAL_PRIVATE" == false ]] \
  || fail 'trading authority changed during watch normalization'
[[ "$FINAL_AUTHORITY" == NONE ]] || fail 'executionAuthority changed during watch normalization'

if [[ -n "$PUBLIC_BASE_URL" ]]; then
  probe_health_identity "$PUBLIC_BASE_URL" "$ACTIVE_SHA" \
    || fail 'public Production health identity failed after watch normalization'
fi

pm2 reset "$PM2_NAME" >/dev/null
pm2 save >/dev/null
NORMALIZATION_COMPLETE=1

printf '[pm2-watch-normalize] SUCCESS active_sha=%s pm2_owns_port=true direct_entry=true watch=false trading_authority=NONE telegram_preserved=true\n' "$ACTIVE_SHA"
