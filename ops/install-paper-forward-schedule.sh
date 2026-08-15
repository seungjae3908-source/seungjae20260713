#!/usr/bin/env bash
set -Eeuo pipefail

umask 077

TARGET_SHA="${1:-}"
LIVE_DIR="${LIVE_DIR:-/opt/stock-app}"
STATE_ROOT="${PAPER_FORWARD_STATE_ROOT:-/opt/stock-app-data/paper-forward-v1}"
DEPLOY_MARKER="$LIVE_DIR/.deploy/current-sha"
SOURCE_LAB="$LIVE_DIR/market-prediction-lab"
RELEASE_ROOT="$STATE_ROOT/releases"
RUNTIME_RELEASE="$RELEASE_ROOT/$TARGET_SHA/market-prediction-lab"
CURRENT_LINK="$STATE_ROOT/current"
BIN_DIR="$STATE_ROOT/bin"
LOG_DIR="$STATE_ROOT/logs"
BACKUP_DIR="$STATE_ROOT/crontab-backups"
WRAPPER="$BIN_DIR/run-paper-forward-schedule"
CRON_LOCK="$STATE_ROOT/cron.lock"
TAG="# stock-app-paper-forward-v1"
CRON_EXPRESSION="*/15 * * * *"
CANONICAL_CYCLE_MS="14400000"
PREVIOUS_CRONTAB=""
CRONTAB_MUTATED=0
BACKUP_PATH=""

fail() {
  echo "[paper-forward-activate] $1" >&2
  exit "${2:-1}"
}

restore_on_error() {
  local status=$?
  trap - EXIT
  if (( status != 0 )) && [[ "$CRONTAB_MUTATED" == 1 ]]; then
    printf '%s' "$PREVIOUS_CRONTAB" | crontab - || true
    : > "$STATE_ROOT/DISABLED"
  fi
  exit "$status"
}
trap restore_on_error EXIT

[[ "$TARGET_SHA" =~ ^[0-9a-f]{40}$ ]] || fail "exact lowercase 40-character SHA required" 2
[[ -r "$DEPLOY_MARKER" ]] || fail "production deploy marker missing" 3
DEPLOYED_SHA="$(tr -d '[:space:]' < "$DEPLOY_MARKER")"
[[ "$DEPLOYED_SHA" == "$TARGET_SHA" ]] || fail "production SHA mismatch: $DEPLOYED_SHA" 4
[[ -r "$SOURCE_LAB/scripts/run-paper-forward-schedule.js" ]] || fail "Paper Forward schedule runner missing" 5
[[ -r "$SOURCE_LAB/src/paper-forward-schedule-runtime-v1.js" ]] || fail "Paper Forward schedule runtime missing" 6
[[ "$STATE_ROOT" == /opt/stock-app-data/paper-forward-v1 ]] || fail "unexpected persistent state root" 7
[[ "$STATE_ROOT" != "$LIVE_DIR" && "$STATE_ROOT" != "$LIVE_DIR/"* ]] || fail "state root must remain outside deploy tree" 8

for command_name in node flock crontab mkdir cp rm mv ln date sha256sum awk grep sed wc pgrep find sort xargs chmod tr; do
  command -v "$command_name" >/dev/null 2>&1 || fail "missing command: $command_name" 9
done

if command -v systemctl >/dev/null 2>&1; then
  systemctl is-active --quiet cron || pgrep -x cron >/dev/null || fail "cron daemon is not active" 10
else
  pgrep -x cron >/dev/null || fail "cron daemon is not active" 10
fi

NODE_BIN="$(command -v node)"
FLOCK_BIN="$(command -v flock)"
mkdir -p "$RELEASE_ROOT" "$BIN_DIR" "$LOG_DIR" "$BACKUP_DIR" "$STATE_ROOT/runtime-state"
chmod 700 "$STATE_ROOT" "$RELEASE_ROOT" "$BIN_DIR" "$LOG_DIR" "$BACKUP_DIR" "$STATE_ROOT/runtime-state"

TEMP_RELEASE="$RELEASE_ROOT/.tmp-$TARGET_SHA-$$"
rm -rf -- "$TEMP_RELEASE"
mkdir -p "$TEMP_RELEASE/market-prediction-lab"
cp -a "$SOURCE_LAB/." "$TEMP_RELEASE/market-prediction-lab/"
find "$TEMP_RELEASE/market-prediction-lab" -type f -exec chmod go-rwx {} +
find "$TEMP_RELEASE/market-prediction-lab" -type d -exec chmod 700 {} +

if [[ -e "$RUNTIME_RELEASE" ]]; then
  EXISTING_DIGEST="$(find "$RUNTIME_RELEASE" -type f -print0 | sort -z | xargs -0 -r sha256sum | sha256sum | awk '{print $1}')"
  NEW_DIGEST="$(find "$TEMP_RELEASE/market-prediction-lab" -type f -print0 | sort -z | xargs -0 -r sha256sum | sha256sum | awk '{print $1}')"
  [[ "$EXISTING_DIGEST" == "$NEW_DIGEST" ]] || fail "existing pinned runtime differs for target SHA" 11
  rm -rf -- "$TEMP_RELEASE"
else
  mv "$TEMP_RELEASE" "$RELEASE_ROOT/$TARGET_SHA"
fi

ln -sfn "$RUNTIME_RELEASE" "$CURRENT_LINK.tmp"
mv -Tf "$CURRENT_LINK.tmp" "$CURRENT_LINK"

ACTIVATION_AT_MS="$("$NODE_BIN" -e 'process.stdout.write(String(Date.now()))')"
TEMP_WRAPPER="$WRAPPER.tmp-$$"
cat > "$TEMP_WRAPPER" <<WRAPPER
#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
STATE_ROOT='$STATE_ROOT'
RUNTIME_DIR='$RUNTIME_RELEASE'
NODE_BIN='$NODE_BIN'
[[ ! -e "\$STATE_ROOT/DISABLED" ]] || exit 0
[[ -r "\$RUNTIME_DIR/scripts/run-paper-forward-schedule.js" ]] || {
  echo '[paper-forward-cron] pinned runner missing' >&2
  exit 66
}
LOG_FILE="\$STATE_ROOT/logs/cron.log"
if [[ -f "\$LOG_FILE" ]] && [[ "\$(wc -c < "\$LOG_FILE")" -gt 5242880 ]]; then
  mv -f "\$LOG_FILE" "\$STATE_ROOT/logs/cron.previous.log"
fi
exec >>"\$LOG_FILE" 2>&1
printf '[paper-forward-cron] invoked_at=%s\n' "\$(date -u +%Y-%m-%dT%H:%M:%SZ)"
exec /usr/bin/env -i \
  HOME="\${HOME:-/tmp}" \
  PATH='/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin' \
  NODE_ENV='production' \
  PAPER_FORWARD_SCHEDULE_ACTIVE='true' \
  PAPER_FORWARD_TRIGGER_SOURCE='cron' \
  PAPER_FORWARD_ROOT='$STATE_ROOT/runtime-state' \
  PAPER_FORWARD_RESEARCH_SHA='$TARGET_SHA' \
  PAPER_FORWARD_ACTIVATION_AT_MS='$ACTIVATION_AT_MS' \
  LIVE_TRADING='false' \
  LIVE_TRADING_ENABLED='false' \
  REAL_ORDER_ENABLED='false' \
  PRIVATE_API_ENABLED='false' \
  PRIVATE_ACCOUNT_ACCESS='false' \
  PRIVATE_TRADING_API_ALLOWED='false' \
  "\$NODE_BIN" "\$RUNTIME_DIR/scripts/run-paper-forward-schedule.js"
WRAPPER
chmod 700 "$TEMP_WRAPPER"
mv -f "$TEMP_WRAPPER" "$WRAPPER"

PREVIOUS_CRONTAB="$(crontab -l 2>/dev/null || true)"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BACKUP_PATH="$BACKUP_DIR/$STAMP.crontab"
printf '%s' "$PREVIOUS_CRONTAB" > "$BACKUP_PATH"
chmod 600 "$BACKUP_PATH"

FILTERED="$(printf '%s\n' "$PREVIOUS_CRONTAB" | grep -vF "$TAG" || true)"
CRON_LINE="$CRON_EXPRESSION $FLOCK_BIN -n $CRON_LOCK $WRAPPER $TAG"
{
  printf '%s\n' "$FILTERED"
  printf '%s\n' "$CRON_LINE"
} | sed '/^[[:space:]]*$/d' | crontab -
CRONTAB_MUTATED=1
rm -f "$STATE_ROOT/DISABLED"

MATCH_COUNT="$(crontab -l | grep -Fxc "$CRON_LINE" || true)"
[[ "$MATCH_COUNT" == 1 ]] || fail "exactly one Paper Forward cron entry is required" 12

RUNTIME_DIGEST="$(find "$RUNTIME_RELEASE" -type f -print0 | sort -z | xargs -0 -r sha256sum | sha256sum | awk '{print $1}')"
CRON_HASH="$(printf '%s' "$CRON_LINE" | sha256sum | awk '{print $1}')"
"$NODE_BIN" - "$STATE_ROOT/activation.json" "$TARGET_SHA" "$DEPLOYED_SHA" "$ACTIVATION_AT_MS" "$RUNTIME_DIGEST" "$CRON_HASH" "$BACKUP_PATH" <<'NODE'
const fs = require('node:fs');
const [path, targetSha, deployedSha, activationAtMs, runtimeDigest, cronHash, backupPath] = process.argv.slice(2);
const value = {
  schemaVersion: 'paper-forward-schedule-activation-v1',
  status: 'ACTIVE_WAITING_FOR_NATURAL_CYCLE',
  targetSha,
  deployedSha,
  activationAtMs: Number(activationAtMs),
  installedAt: new Date(Number(activationAtMs)).toISOString(),
  pollCadence: 'EVERY_15_MINUTES',
  canonicalCycleIntervalMs: 14400000,
  runtimeDigest,
  cronHash,
  crontabBackupPath: backupPath,
  scheduleActive: true,
  publicDataOnly: true,
  liveTrading: false,
  privateAccountAccess: false,
  orderAuthority: false,
};
const temp = `${path}.tmp-${process.pid}`;
fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
fs.renameSync(temp, path);
NODE

CRONTAB_MUTATED=0
trap - EXIT
printf '{"status":"ACTIVE_WAITING_FOR_NATURAL_CYCLE","targetSha":"%s","activationAtMs":%s,"scheduleActive":true,"pollCadence":"EVERY_15_MINUTES","canonicalCycleIntervalMs":%s,"privateRequestCount":0,"financialMutationCount":0,"liveTrading":false}\n' \
  "$TARGET_SHA" "$ACTIVATION_AT_MS" "$CANONICAL_CYCLE_MS"
