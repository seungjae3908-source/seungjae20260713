#!/usr/bin/env bash
# Dormant protected systemd ExecStart, never a generic stock-app deploy.
# Trading/Paper/PM2/DB/Secrets are not changed by this script.
set -Eeuo pipefail
umask 077
readonly LIVE_APP=/opt/stock-app
readonly RELEASE=/opt/stock-app-data/telegram-isolated-v1/release/current
readonly OWNER_ROOT=/opt/stock-app-data/telegram-isolated-v1
readonly LOCK_FILE=/opt/stock-app-data/telegram-isolated-v1/telegram-owner.lock
readonly DEPLOY_LOCK=/var/lock/stock-app-deploy.lock
readonly HEALTH_PORT="${TELEGRAM_LEGACY_HEALTH_PORT:-8080}"

for cmd in node pm2 flock sha256sum curl grep; do
  command -v "$cmd" >/dev/null || { echo "TELEGRAM_ISOLATED_REQUIRED_COMMAND_MISSING" >&2; exit 10; }
done
[[ "$TELEGRAM_ISOLATED_CUTOVER_APPROVED" == "true" ]] || {
  echo "TELEGRAM_ISOLATED_OWNER_APPROVAL_REQUIRED" >&2; exit 11;
}
[[ "$TELEGRAM_WORKER_OWNER" == "isolated" ]] || {
  echo "TELEGRAM_ISOLATED_OWNER_MISMATCH" >&2; exit 11;
}
[[ "$TELEGRAM_TARGET_SHA" =~ ^[0-9a-f]{40}$ ]] || {
  echo "TELEGRAM_ISOLATED_EXACT_SHA_REQUIRED" >&2; exit 11;
}
[[ -d "$RELEASE" && ! -L "$RELEASE" && -d "$OWNER_ROOT" && ! -L "$OWNER_ROOT" ]] || {
  echo "TELEGRAM_ISOLATED_RELEASE_DIRECTORY_INVALID" >&2; exit 12;
}
[[ -f "$RELEASE/.deploy/current-sha" && ! -L "$RELEASE/.deploy/current-sha" ]] || {
  echo "TELEGRAM_ISOLATED_IMMUTABLE_RELEASE_MISSING" >&2; exit 12;
}
[[ "$(cat "$RELEASE/.deploy/current-sha")" == "$TELEGRAM_TARGET_SHA" ]] || {
  echo "TELEGRAM_ISOLATED_RELEASE_IDENTITY_MISMATCH" >&2; exit 12;
}
[[ -f "$RELEASE/ops/telegram-legacy-owner-runtime-proof.mjs" &&
   ! -L "$RELEASE/ops/telegram-legacy-owner-runtime-proof.mjs" &&
   -f "$RELEASE/api-server/dist/telegram-isolated-worker.mjs" &&
   ! -L "$RELEASE/api-server/dist/telegram-isolated-worker.mjs" &&
   -f "$RELEASE/.deploy/telegram-sha256.manifest" &&
   ! -L "$RELEASE/.deploy/telegram-sha256.manifest" ]] || {
  echo "TELEGRAM_ISOLATED_SEALED_BINARY_MISSING" >&2; exit 12;
}
(
  cd "$RELEASE"
  # Require both executable and owner proof to be covered by the sealed manifest.
  grep -Eq '^[0-9a-f]{64}  api-server/dist/telegram-isolated-worker[.]mjs$' .deploy/telegram-sha256.manifest
  grep -Eq '^[0-9a-f]{64}  ops/telegram-legacy-owner-runtime-proof[.]mjs$' .deploy/telegram-sha256.manifest
  sha256sum --check --quiet .deploy/telegram-sha256.manifest
) || {
  echo "TELEGRAM_ISOLATED_BINARY_HASH_INVALID" >&2; exit 12;
}
legacy_inactive() {
  pm2 jlist | node -e '
const fs=require("node:fs");
const fail=()=>{console.error("TELEGRAM_LEGACY_WRITER_NOT_QUIESCED");process.exit(13)};
let list;
try {list=JSON.parse(fs.readFileSync(0,"utf8"))}catch{fail()}
if(!Array.isArray(list)) fail();
const rows=list.filter(x=>x.name==="stock-app");
if(rows.length!==1 || rows[0].pm2_env?.status!=="online") fail();
const env=rows[0].pm2_env;
if(env.TELEGRAM_WORKER_OWNER!=="isolated") fail();
if(!/^[0-9a-f]{40}$/.test(String(env.DEPLOY_SHA ?? ""))) fail();
console.log("TELEGRAM_LEGACY_PROCESS_OWNER_ISOLATED");
'
}
legacy_health_inactive() {
  local previous_sha
  [[ -f "$LIVE_APP/.deploy/current-sha" && ! -L "$LIVE_APP/.deploy/current-sha" ]] || {
    echo "TELEGRAM_LEGACY_RUNTIME_IDENTITY_MISSING" >&2; return 13;
  }
  previous_sha="$(cat "$LIVE_APP/.deploy/current-sha")"
  [[ "$previous_sha" =~ ^[0-9a-f]{40}$ ]] || {
    echo "TELEGRAM_LEGACY_RUNTIME_IDENTITY_INVALID" >&2; return 13;
  }
  # This must prove actual live worker state, not only stale PM2 env flags.
  curl --fail --silent --show-error --max-time 6 --max-filesize 32768 \
    "http://127.0.0.1:${HEALTH_PORT}/api/health" |
    node "$RELEASE/ops/telegram-legacy-owner-runtime-proof.mjs" "$previous_sha" || {
      echo "TELEGRAM_LEGACY_RUNTIME_HEALTH_UNPROVEN" >&2; return 13;
    }
}
[[ "$HEALTH_PORT" =~ ^[0-9]{2,5}$ ]] || {
  echo "TELEGRAM_LEGACY_HEALTH_PORT_INVALID" >&2; exit 13;
}
(( 10#$HEALTH_PORT >= 1024 && 10#$HEALTH_PORT <= 65535 )) || {
  echo "TELEGRAM_LEGACY_HEALTH_PORT_INVALID" >&2; exit 13;
}
[[ ! -L "$DEPLOY_LOCK" ]] || {
  echo "TELEGRAM_SHARED_DEPLOY_LOCK_UNSAFE" >&2; exit 13;
}
# The fd persists across exec; generic deployments cannot restart PM2 while
# an isolated Telegram writer is active. Fail closed instead of racing a swap.
exec 8>"$DEPLOY_LOCK"
flock -n 8 || { echo "TELEGRAM_SHARED_DEPLOY_LOCK_BUSY" >&2; exit 13; }
# A false setting inferred from a new candidate is NEVER equivalent to old
# process being disabled. Read the actual PM2 worker flags twice.
legacy_inactive
legacy_health_inactive
[[ -d "$LIVE_APP/.runtime" && ! -L "$LIVE_APP/.runtime" && -w "$LIVE_APP/.runtime" ]] || {
  echo "TELEGRAM_EXISTING_LEDGER_ROOT_NOT_WRITABLE" >&2; exit 13;
}
[[ -d "$OWNER_ROOT/state" && ! -L "$OWNER_ROOT/state" && ! -L "$LOCK_FILE" ]] || {
  echo "TELEGRAM_ISOLATED_STATE_DIRECTORY_INVALID" >&2; exit 13;
}
exec 9>"$LOCK_FILE"
flock -n 9 || { echo "TELEGRAM_ISOLATED_OWNER_LEASE_BUSY" >&2; exit 13; }
legacy_inactive
legacy_health_inactive
# The protected installer must hold the shared deployment/operator exclusion
# lease until this owner has started and read back. It must NEVER restart PM2.
export TELEGRAM_SINGLE_WRITER_LEASE=LOCK_HELD_V1
export TELEGRAM_INTELLIGENCE_STATE_PATH="$LIVE_APP/.runtime/telegram-intelligence-delivery-state.json"
export SIGNAL_INTELLIGENCE_TELEGRAM_STATE_PATH="$LIVE_APP/.runtime/signal-intelligence-telegram-state.json"
export SIGNAL_INTELLIGENCE_AI_WATCH_STATE_PATH="$LIVE_APP/.runtime/signal-ai-watch-delivery-state.json"
export NODE_OPTIONS="--dns-result-order=ipv4first --no-network-family-autoselection"
exec node --enable-source-maps "$RELEASE/api-server/dist/telegram-isolated-worker.mjs"
