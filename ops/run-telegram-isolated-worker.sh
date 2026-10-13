#!/usr/bin/env bash
# Dormant protected systemd ExecStart, never a generic stock-app deploy.
# Trading/Paper/PM2/DB/Secrets are not changed by this script.
set -Eeuo pipefail
umask 077
readonly LIVE_APP=/opt/stock-app
readonly RELEASE=/opt/stock-app-data/telegram-isolated-v1/release/current
readonly OWNER_ROOT=/opt/stock-app-data/telegram-isolated-v1
readonly LOCK_FILE=/opt/stock-app-data/telegram-isolated-v1/telegram-owner.lock

for cmd in node pm2 flock sha256sum; do
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
[[ -f "$RELEASE/api-server/dist/telegram-isolated-worker.mjs" &&
   ! -L "$RELEASE/api-server/dist/telegram-isolated-worker.mjs" &&
   -f "$RELEASE/.deploy/telegram-sha256.manifest" &&
   ! -L "$RELEASE/.deploy/telegram-sha256.manifest" ]] || {
  echo "TELEGRAM_ISOLATED_SEALED_BINARY_MISSING" >&2; exit 12;
}
(
  cd "$RELEASE"
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
for(const key of [
  "LIVE_TELEGRAM_ACTIVATION_APPROVED",
  "TELEGRAM_INTELLIGENCE_WORKER_ENABLED",
  "PERSONAL_TELEGRAM_WORKER_ENABLED",
]) if(String(env[key]??"").toLowerCase()!=="false") fail();
console.log("TELEGRAM_LEGACY_WRITER_DISABLED_PROVEN");
'
}
# A false setting inferred from a new candidate is NEVER equivalent to old
# process being disabled. Read the actual PM2 worker flags twice.
legacy_inactive
[[ -d "$LIVE_APP/.runtime" && ! -L "$LIVE_APP/.runtime" && -w "$LIVE_APP/.runtime" ]] || {
  echo "TELEGRAM_EXISTING_LEDGER_ROOT_NOT_WRITABLE" >&2; exit 13;
}
[[ -d "$OWNER_ROOT/state" && ! -L "$OWNER_ROOT/state" && ! -L "$LOCK_FILE" ]] || {
  echo "TELEGRAM_ISOLATED_STATE_DIRECTORY_INVALID" >&2; exit 13;
}
exec 9>"$LOCK_FILE"
flock -n 9 || { echo "TELEGRAM_ISOLATED_OWNER_LEASE_BUSY" >&2; exit 13; }
legacy_inactive
# The protected installer must hold the shared deployment/operator exclusion
# lease until this owner has started and read back. It must NEVER restart PM2.
export TELEGRAM_SINGLE_WRITER_LEASE=LOCK_HELD_V1
export TELEGRAM_INTELLIGENCE_STATE_PATH="$LIVE_APP/.runtime/telegram-intelligence-delivery-state.json"
export SIGNAL_INTELLIGENCE_TELEGRAM_STATE_PATH="$LIVE_APP/.runtime/signal-intelligence-telegram-state.json"
export NODE_OPTIONS="--dns-result-order=ipv4first --no-network-family-autoselection"
exec node --enable-source-maps "$RELEASE/api-server/dist/telegram-isolated-worker.mjs"
