#!/usr/bin/env bash
set -Eeuo pipefail

umask 077

TARGET_SHA="${TARGET_SHA:-${1:-}}"
ACTIVATION_RECEIPT_COMMENT_ID="${ACTIVATION_RECEIPT_COMMENT_ID:-${2:-}}"
ACTIVATION_BINDING_DIGEST="${ACTIVATION_BINDING_DIGEST:-${3:-}}"
SOURCE_DIR="${SOURCE_DIR:-$(pwd)}"

RUNTIME_ROOT=/opt/stock-app-server-evidence-shadow-v1
RELEASE_ROOT="$RUNTIME_ROOT/releases"
RELEASE_DIR="$RELEASE_ROOT/$TARGET_SHA"
CURRENT_LINK="$RUNTIME_ROOT/current"
STATE_ROOT=/var/lib/stock-app-server-evidence-shadow-v1
ENV_DIR=/etc/stock-app
ENV_FILE="$ENV_DIR/server-evidence-shadow-v1.env"
SERVICE_NAME=public-forward-liquidity-server-shadow-worker-v1.service
TIMER_NAME=public-forward-liquidity-server-shadow-worker-v1.timer
SYSTEMD_DIR=/etc/systemd/system
SERVICE_SOURCE="$SOURCE_DIR/market-intelligence-sidecar/deploy/$SERVICE_NAME"
TIMER_SOURCE="$SOURCE_DIR/market-intelligence-sidecar/deploy/$TIMER_NAME"
RUNNER_REL=market-intelligence-sidecar/scripts/run-public-forward-liquidity-server-shadow-worker-v1.mjs
RUNNER_SOURCE="$SOURCE_DIR/$RUNNER_REL"
ACTIVATION_PATH="$RUNTIME_ROOT/activation.json"

PREVIOUS_CURRENT=""
PREVIOUS_ENV=""
PREVIOUS_SERVICE=""
PREVIOUS_TIMER=""
TIMER_WAS_ENABLED=false
MUTATION_STARTED=false
BACKUP_DIR=""

fail() {
  echo "[server-evidence-shadow-activate] $1" >&2
  exit "${2:-1}"
}

cleanup_backup() {
  [[ -z "$BACKUP_DIR" ]] || rm -rf -- "$BACKUP_DIR"
}

restore_on_error() {
  local status=$?
  trap - EXIT
  if (( status != 0 )) && [[ "$MUTATION_STARTED" == true ]]; then
    systemctl disable --now "$TIMER_NAME" >/dev/null 2>&1 || true
    if [[ -n "$PREVIOUS_SERVICE" && -f "$PREVIOUS_SERVICE" ]]; then
      install -m 0644 "$PREVIOUS_SERVICE" "$SYSTEMD_DIR/$SERVICE_NAME" || true
    else
      rm -f -- "$SYSTEMD_DIR/$SERVICE_NAME"
    fi
    if [[ -n "$PREVIOUS_TIMER" && -f "$PREVIOUS_TIMER" ]]; then
      install -m 0644 "$PREVIOUS_TIMER" "$SYSTEMD_DIR/$TIMER_NAME" || true
    else
      rm -f -- "$SYSTEMD_DIR/$TIMER_NAME"
    fi
    if [[ -n "$PREVIOUS_ENV" && -f "$PREVIOUS_ENV" ]]; then
      install -m 0644 "$PREVIOUS_ENV" "$ENV_FILE" || true
    else
      rm -f -- "$ENV_FILE"
    fi
    if [[ -n "$PREVIOUS_CURRENT" ]]; then
      ln -sfn "$PREVIOUS_CURRENT" "$CURRENT_LINK.tmp" || true
      mv -Tf "$CURRENT_LINK.tmp" "$CURRENT_LINK" || true
    else
      rm -f -- "$CURRENT_LINK"
    fi
    systemctl daemon-reload >/dev/null 2>&1 || true
    if [[ "$TIMER_WAS_ENABLED" == true ]]; then
      systemctl enable --now "$TIMER_NAME" >/dev/null 2>&1 || true
    fi
  fi
  cleanup_backup
  exit "$status"
}
trap restore_on_error EXIT

[[ "$TARGET_SHA" =~ ^[0-9a-f]{40}$ ]] || fail "exact lowercase 40-character target SHA required" 2
[[ "$ACTIVATION_RECEIPT_COMMENT_ID" =~ ^[1-9][0-9]*$ ]] || fail "positive activation receipt comment ID required" 2
[[ "$ACTIVATION_BINDING_DIGEST" =~ ^[0-9a-f]{64}$ ]] || fail "exact lowercase 64-character activation binding digest required" 2

for command_name in git node systemctl timedatectl rsync install readlink sha256sum awk find sort xargs mktemp; do
  command -v "$command_name" >/dev/null 2>&1 || fail "missing command: $command_name" 3
done

[[ -d "$SOURCE_DIR/.git" ]] || fail "SOURCE_DIR must be an exact Git checkout" 4
[[ "$(git -C "$SOURCE_DIR" rev-parse HEAD)" == "$TARGET_SHA" ]] || fail "SOURCE_DIR HEAD is not exact target SHA" 4
[[ -r "$RUNNER_SOURCE" ]] || fail "shadow worker runner missing" 5
[[ -r "$SERVICE_SOURCE" && -r "$TIMER_SOURCE" ]] || fail "shadow systemd definitions missing" 5
[[ "$(timedatectl show -p NTPSynchronized --value | tr '[:upper:]' '[:lower:]')" == "yes" ]] || fail "host NTP is not synchronized" 6

grep -Fq 'Environment=SERVER_EVIDENCE_SHADOW_ONLY=true' "$SERVICE_SOURCE" || fail "service does not hard-code shadow-only mode" 7
grep -Fq 'Environment=SERVER_EVIDENCE_SERVER_CANONICAL=false' "$SERVICE_SOURCE" || fail "service does not hard-code server canonical false" 7
grep -Fq 'Persistent=false' "$TIMER_SOURCE" || fail "timer must never backfill downtime" 7
grep -Fq 'OnCalendar=*-*-* *:17:00 UTC' "$TIMER_SOURCE" || fail "timer missing :17 trigger" 7
grep -Fq 'OnCalendar=*-*-* *:27:00 UTC' "$TIMER_SOURCE" || fail "timer missing :27 trigger" 7
grep -Fq 'OnCalendar=*-*-* *:37:00 UTC' "$TIMER_SOURCE" || fail "timer missing :37 trigger" 7

mkdir -p "$RELEASE_ROOT" "$ENV_DIR"
chmod 0755 "$RUNTIME_ROOT" "$RELEASE_ROOT"
chmod 0755 "$ENV_DIR"

if [[ -L "$CURRENT_LINK" ]]; then
  PREVIOUS_CURRENT="$(readlink -f "$CURRENT_LINK" || true)"
fi
TIMER_WAS_ENABLED=false
if systemctl is-enabled --quiet "$TIMER_NAME" 2>/dev/null; then TIMER_WAS_ENABLED=true; fi

BACKUP_DIR="$(mktemp -d /tmp/server-evidence-shadow-backup.XXXXXX)"
if [[ -f "$ENV_FILE" ]]; then
  cp -a "$ENV_FILE" "$BACKUP_DIR/env"
  PREVIOUS_ENV="$BACKUP_DIR/env"
fi
if [[ -f "$SYSTEMD_DIR/$SERVICE_NAME" ]]; then
  cp -a "$SYSTEMD_DIR/$SERVICE_NAME" "$BACKUP_DIR/service"
  PREVIOUS_SERVICE="$BACKUP_DIR/service"
fi
if [[ -f "$SYSTEMD_DIR/$TIMER_NAME" ]]; then
  cp -a "$SYSTEMD_DIR/$TIMER_NAME" "$BACKUP_DIR/timer"
  PREVIOUS_TIMER="$BACKUP_DIR/timer"
fi

if [[ -e "$RELEASE_DIR" ]]; then
  [[ -f "$RELEASE_DIR/.deploy/current-sha" ]] || fail "existing release is missing SHA marker" 8
  [[ "$(tr -d '[:space:]' < "$RELEASE_DIR/.deploy/current-sha")" == "$TARGET_SHA" ]] || fail "existing release SHA marker mismatch" 8
else
  TEMP_RELEASE="$RELEASE_ROOT/.tmp-$TARGET_SHA-$$"
  rm -rf -- "$TEMP_RELEASE"
  mkdir -p "$TEMP_RELEASE/.deploy" "$TEMP_RELEASE/market-intelligence-sidecar"
  rsync -a --delete --exclude='node_modules/' "$SOURCE_DIR/market-intelligence-sidecar/" "$TEMP_RELEASE/market-intelligence-sidecar/"
  printf '%s\n' "$TARGET_SHA" > "$TEMP_RELEASE/.deploy/current-sha"
  find "$TEMP_RELEASE" -type d -exec chmod 0755 {} +
  find "$TEMP_RELEASE" -type f -exec chmod 0644 {} +
  mv "$TEMP_RELEASE" "$RELEASE_DIR"
fi

SELF_CHECK="$(
  SERVER_EVIDENCE_EXPECTED_BINDING_DIGEST="$ACTIVATION_BINDING_DIGEST"     node "$RELEASE_DIR/$RUNNER_REL" self-check
)" || fail "shadow worker self-check failed" 9
node - "$SELF_CHECK" <<'NODE'
const value = JSON.parse(process.argv[2]);
if (value?.contractValid !== true
  || value?.activationBound !== true
  || value?.runtimeActivated !== false
  || value?.networkRequestPerformed !== false
  || value?.safety?.shadowOnly !== true
  || value?.safety?.serverCanonical !== false
  || value?.safety?.prospectiveSlotCredit !== 0
  || value?.safety?.canonicalEconomicCredit !== 0
  || value?.safety?.executionAuthority !== 'NONE') process.exit(1);
NODE

MUTATION_STARTED=true

TEMP_ENV="$ENV_FILE.tmp-$$"
cat > "$TEMP_ENV" <<ENV
SERVER_EVIDENCE_ACTIVATION_RECEIPT_COMMENT_ID=$ACTIVATION_RECEIPT_COMMENT_ID
SERVER_EVIDENCE_ACTIVATION_RECEIPT_MAIN_SHA=$TARGET_SHA
SERVER_EVIDENCE_EXPECTED_BINDING_DIGEST=$ACTIVATION_BINDING_DIGEST
ENV
chmod 0644 "$TEMP_ENV"
mv -f "$TEMP_ENV" "$ENV_FILE"

install -m 0644 "$RELEASE_DIR/market-intelligence-sidecar/deploy/$SERVICE_NAME" "$SYSTEMD_DIR/$SERVICE_NAME"
install -m 0644 "$RELEASE_DIR/market-intelligence-sidecar/deploy/$TIMER_NAME" "$SYSTEMD_DIR/$TIMER_NAME"

ln -sfn "$RELEASE_DIR" "$CURRENT_LINK.tmp"
mv -Tf "$CURRENT_LINK.tmp" "$CURRENT_LINK"

systemctl daemon-reload
systemctl enable --now "$TIMER_NAME"
systemctl is-enabled --quiet "$TIMER_NAME"
systemctl is-active --quiet "$TIMER_NAME"
! systemctl is-failed --quiet "$SERVICE_NAME"

[[ "$(tr -d '[:space:]' < "$CURRENT_LINK/.deploy/current-sha")" == "$TARGET_SHA" ]] || fail "activated runtime marker mismatch" 10

RUNTIME_DIGEST="$(
  find "$RELEASE_DIR/market-intelligence-sidecar" -type f -print0     | sort -z     | xargs -0 -r sha256sum     | sha256sum     | awk '{print $1}'
)"
[[ "$RUNTIME_DIGEST" =~ ^[0-9a-f]{64}$ ]] || fail "runtime digest invalid" 10
NEXT_ELAPSE="$(systemctl show "$TIMER_NAME" -p NextElapseUSecRealtime --value || true)"
ACTIVATED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

node - "$ACTIVATION_PATH" "$TARGET_SHA" "$ACTIVATION_RECEIPT_COMMENT_ID" "$ACTIVATION_BINDING_DIGEST" "$RUNTIME_DIGEST" "$ACTIVATED_AT" "$NEXT_ELAPSE" <<'NODE'
const fs = require('node:fs');
const [path, targetSha, receiptCommentId, bindingDigest, runtimeDigest, activatedAt, nextElapse] = process.argv.slice(2);
const value = {
  schemaVersion: 'public-forward-liquidity-server-shadow-activation-v1',
  status: 'ACTIVE_SHADOW_ONLY',
  targetSha,
  activationReceiptCommentId: Number(receiptCommentId),
  activationBindingDigest: bindingDigest,
  runtimeDigest,
  activatedAt,
  nextElapse: nextElapse || null,
  schedule: ['17 * * * *', '27 * * * *', '37 * * * *'],
  persistentBackfill: false,
  shadowOnly: true,
  serverCanonical: false,
  prospectiveSlotCredit: 0,
  canonicalEconomicCredit: 0,
  profitabilityCredit: 0,
  fullCostReady: false,
  evidenceComplete: 0,
  profitabilityProven: false,
  liveTrading: false,
  autoTrading: false,
  realOrderEnabled: false,
  privateTradingApiAllowed: false,
  executionAuthority: 'NONE',
  productionAppDeployPerformed: false,
  productionAppMutationAllowed: false,
  databaseMutationCount: 0,
  secretMutationCount: 0,
  realOrderCount: 0,
  replitUsed: false,
};
const temp = `${path}.tmp-${process.pid}`;
fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
fs.renameSync(temp, path);
process.stdout.write(`${JSON.stringify(value)}\n`);
NODE

MUTATION_STARTED=false
cleanup_backup
trap - EXIT
