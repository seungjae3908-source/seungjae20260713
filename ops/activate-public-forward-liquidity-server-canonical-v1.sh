#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

TARGET_SHA="${TARGET_SHA:-${1:-}}"
ACTIVATION_RECEIPT_COMMENT_ID="${ACTIVATION_RECEIPT_COMMENT_ID:-${2:-}}"
ACTIVATION_BINDING_DIGEST="${ACTIVATION_BINDING_DIGEST:-${3:-}}"
CANONICAL_AUTHORITY_COMMENT_ID="${CANONICAL_AUTHORITY_COMMENT_ID:-${4:-}}"
CANONICAL_AUTHORIZED_AT_MS="${CANONICAL_AUTHORIZED_AT_MS:-${5:-}}"
ACTIVATION_RECEIPT_MAIN_SHA="${ACTIVATION_RECEIPT_MAIN_SHA:-${6:-}}"
EXPECTED_COMPONENT_DIGEST="${EXPECTED_COMPONENT_DIGEST:-${7:-}}"
SOURCE_DIR="${SOURCE_DIR:-$(pwd)}"

RUNTIME_ROOT=/opt/stock-app-server-evidence-canonical-v1
RELEASE_ROOT="$RUNTIME_ROOT/releases"
RELEASE_DIR="$RELEASE_ROOT/$TARGET_SHA"
CURRENT_LINK="$RUNTIME_ROOT/current"
ACTIVATION_PATH="$RUNTIME_ROOT/activation.json"
STATE_ROOT=/var/lib/stock-app-server-evidence-canonical-v1
SHADOW_ROOT=/opt/stock-app-server-evidence-shadow-v1
SHADOW_STATE_ROOT=/var/lib/stock-app-server-evidence-shadow-v1
SHADOW_ENV=/etc/stock-app/server-evidence-shadow-v1.env
SHADOW_SERVICE=public-forward-liquidity-server-shadow-worker-v1.service
SHADOW_TIMER=public-forward-liquidity-server-shadow-worker-v1.timer
CANONICAL_SERVICE=public-forward-liquidity-server-canonical-worker-v1.service
CANONICAL_TIMER=public-forward-liquidity-server-canonical-worker-v1.timer
SYSTEMD_DIR=/etc/systemd/system
RUNNER_REL=market-intelligence-sidecar/scripts/run-public-forward-liquidity-server-canonical-runtime-v1.mjs
RUNNER_SOURCE="$SOURCE_DIR/$RUNNER_REL"
SERVICE_SOURCE="$SOURCE_DIR/market-intelligence-sidecar/deploy/$CANONICAL_SERVICE"
TIMER_SOURCE="$SOURCE_DIR/market-intelligence-sidecar/deploy/$CANONICAL_TIMER"
COMPONENT_CHECKER="$SOURCE_DIR/ops/check-public-forward-liquidity-server-component-equivalence-v1.sh"

PREVIOUS_CURRENT=""
PREVIOUS_SERVICE=""
PREVIOUS_TIMER=""
SHADOW_WAS_ENABLED=false
SHADOW_WAS_ACTIVE=false
MUTATION_STARTED=false
ACTIVATION_CREATED=false
BACKUP_DIR=""

fail() { echo "[server-canonical-activate] $1" >&2; exit "${2:-1}"; }
cleanup_backup() { [[ -z "$BACKUP_DIR" ]] || rm -rf -- "$BACKUP_DIR"; }

restore_on_error() {
  local status=$?
  trap - EXIT
  if (( status != 0 )); then
    systemctl disable --now "$CANONICAL_TIMER" >/dev/null 2>&1 || true
    if [[ -n "$PREVIOUS_SERVICE" && -f "$PREVIOUS_SERVICE" ]]; then
      install -m 0644 "$PREVIOUS_SERVICE" "$SYSTEMD_DIR/$CANONICAL_SERVICE" || true
    else
      rm -f -- "$SYSTEMD_DIR/$CANONICAL_SERVICE"
    fi
    if [[ -n "$PREVIOUS_TIMER" && -f "$PREVIOUS_TIMER" ]]; then
      install -m 0644 "$PREVIOUS_TIMER" "$SYSTEMD_DIR/$CANONICAL_TIMER" || true
    else
      rm -f -- "$SYSTEMD_DIR/$CANONICAL_TIMER"
    fi
    if [[ -n "$PREVIOUS_CURRENT" ]]; then
      ln -sfn "$PREVIOUS_CURRENT" "$CURRENT_LINK.tmp" || true
      mv -Tf "$CURRENT_LINK.tmp" "$CURRENT_LINK" || true
    else
      rm -f -- "$CURRENT_LINK"
    fi
    if [[ "$ACTIVATION_CREATED" == true ]]; then rm -f -- "$ACTIVATION_PATH"; fi
    systemctl daemon-reload >/dev/null 2>&1 || true
    if [[ "$SHADOW_WAS_ENABLED" == true ]]; then systemctl enable "$SHADOW_TIMER" >/dev/null 2>&1 || true; fi
    if [[ "$SHADOW_WAS_ACTIVE" == true ]]; then systemctl start "$SHADOW_TIMER" >/dev/null 2>&1 || true; fi
  fi
  cleanup_backup
  exit "$status"
}
trap restore_on_error EXIT

[[ "$TARGET_SHA" =~ ^[0-9a-f]{40}$ ]] || fail "exact target SHA required" 2
[[ "$ACTIVATION_RECEIPT_COMMENT_ID" =~ ^[1-9][0-9]*$ ]] || fail "activation receipt comment ID required" 2
[[ "$ACTIVATION_BINDING_DIGEST" =~ ^[0-9a-f]{64}$ ]] || fail "activation binding digest required" 2
[[ "$CANONICAL_AUTHORITY_COMMENT_ID" =~ ^[1-9][0-9]*$ ]] || fail "canonical authority comment ID required" 2
[[ "$CANONICAL_AUTHORIZED_AT_MS" =~ ^[1-9][0-9]*$ ]] || fail "canonical authority timestamp required" 2
[[ "$ACTIVATION_RECEIPT_MAIN_SHA" =~ ^[0-9a-f]{40}$ ]] || fail "activation receipt main SHA required" 2
[[ "$EXPECTED_COMPONENT_DIGEST" =~ ^[0-9a-f]{64}$ ]] || fail "component digest required" 2
[[ ! -e "$ACTIVATION_PATH" ]] || fail "canonical activation record already exists; explicit rollback/re-authority required" 3

for command_name in git node systemctl timedatectl rsync install readlink sha256sum awk find sort xargs mktemp; do
  command -v "$command_name" >/dev/null 2>&1 || fail "missing command: $command_name" 4
done
[[ -d "$SOURCE_DIR/.git" ]] || fail "SOURCE_DIR must be exact Git checkout" 5
[[ "$(git -C "$SOURCE_DIR" rev-parse HEAD)" == "$TARGET_SHA" ]] || fail "SOURCE_DIR HEAD mismatch" 5
[[ -r "$RUNNER_SOURCE" && -r "$SERVICE_SOURCE" && -r "$TIMER_SOURCE" && -r "$COMPONENT_CHECKER" ]] || fail "canonical runtime files missing" 6
[[ -f "$SHADOW_ROOT/current/.deploy/current-sha" ]] || fail "shadow runtime missing" 7
SHADOW_SHA="$(tr -d '[:space:]' < "$SHADOW_ROOT/current/.deploy/current-sha")"
[[ "$SHADOW_SHA" == "$ACTIVATION_RECEIPT_MAIN_SHA" ]] || fail "shadow runtime does not match activation receipt main" 7
[[ -f "$SHADOW_ENV" ]] || fail "shadow activation env missing" 7
grep -Fxq "SERVER_EVIDENCE_ACTIVATION_RECEIPT_COMMENT_ID=$ACTIVATION_RECEIPT_COMMENT_ID" "$SHADOW_ENV" || fail "shadow receipt not rebound" 7
grep -Fxq "SERVER_EVIDENCE_ACTIVATION_RECEIPT_MAIN_SHA=$ACTIVATION_RECEIPT_MAIN_SHA" "$SHADOW_ENV" || fail "shadow main not rebound" 7
grep -Fxq "SERVER_EVIDENCE_EXPECTED_BINDING_DIGEST=$ACTIVATION_BINDING_DIGEST" "$SHADOW_ENV" || fail "shadow binding not rebound" 7

git -C "$SOURCE_DIR" fetch --quiet --depth 1 origin "$ACTIVATION_RECEIPT_MAIN_SHA"
COMPONENT_JSON="$(
  SOURCE_DIR="$SOURCE_DIR" BASE_SHA="$ACTIVATION_RECEIPT_MAIN_SHA" HEAD_SHA="$TARGET_SHA" bash "$COMPONENT_CHECKER"
)" || fail "shadow/current-main component equivalence rejected" 7
COMPONENT_DIGEST="$(node -e 'const v=JSON.parse(process.argv[1]); if(v.componentEquivalentCurrentMain!==true||v.evidenceSha!==process.env.ACTIVATION_RECEIPT_MAIN_SHA||v.currentMainSha!==process.env.TARGET_SHA||!/^[a-f0-9]{64}$/.test(String(v.currentComponentDigest||""))) process.exit(1); process.stdout.write(v.currentComponentDigest);' "$COMPONENT_JSON")" || fail "component equivalence evidence invalid" 7
[[ "$COMPONENT_DIGEST" == "$EXPECTED_COMPONENT_DIGEST" ]] || fail "component digest mismatch" 7

systemctl is-enabled --quiet "$SHADOW_TIMER" || fail "shadow timer not enabled" 7
systemctl is-active --quiet "$SHADOW_TIMER" || fail "shadow timer not active" 7
[[ "$(timedatectl show -p NTPSynchronized --value | tr '[:upper:]' '[:lower:]')" == "yes" ]] || fail "host NTP not synchronized" 7

grep -Fq 'Environment=SERVER_EVIDENCE_SHADOW_ONLY=false' "$SERVICE_SOURCE" || fail "canonical service shadow flag invalid" 8
grep -Fq 'Environment=SERVER_EVIDENCE_SERVER_CANONICAL=true' "$SERVICE_SOURCE" || fail "canonical service canonical flag missing" 8
grep -Fq 'Persistent=false' "$TIMER_SOURCE" || fail "canonical timer must not backfill" 8
grep -Fq 'OnCalendar=*-*-* *:17:00 UTC' "$TIMER_SOURCE" || fail "canonical timer missing :17" 8
grep -Fq 'OnCalendar=*-*-* *:27:00 UTC' "$TIMER_SOURCE" || fail "canonical timer missing :27" 8
grep -Fq 'OnCalendar=*-*-* *:37:00 UTC' "$TIMER_SOURCE" || fail "canonical timer missing :37" 8
! grep -Eq 'LIVE_TRADING=true|AUTO_TRADING=true|REAL_ORDER_ENABLED=true|PRIVATE_TRADING_API_ALLOWED=true' "$SERVICE_SOURCE" || fail "forbidden trading authority" 8

mkdir -p "$RUNTIME_ROOT" "$RELEASE_ROOT"
chmod 0755 "$RUNTIME_ROOT" "$RELEASE_ROOT"
if [[ -L "$CURRENT_LINK" ]]; then PREVIOUS_CURRENT="$(readlink -f "$CURRENT_LINK" || true)"; fi
SHADOW_WAS_ENABLED=false; systemctl is-enabled --quiet "$SHADOW_TIMER" 2>/dev/null && SHADOW_WAS_ENABLED=true
SHADOW_WAS_ACTIVE=false; systemctl is-active --quiet "$SHADOW_TIMER" 2>/dev/null && SHADOW_WAS_ACTIVE=true
BACKUP_DIR="$(mktemp -d /tmp/server-canonical-backup.XXXXXX)"
if [[ -f "$SYSTEMD_DIR/$CANONICAL_SERVICE" ]]; then cp -a "$SYSTEMD_DIR/$CANONICAL_SERVICE" "$BACKUP_DIR/service"; PREVIOUS_SERVICE="$BACKUP_DIR/service"; fi
if [[ -f "$SYSTEMD_DIR/$CANONICAL_TIMER" ]]; then cp -a "$SYSTEMD_DIR/$CANONICAL_TIMER" "$BACKUP_DIR/timer"; PREVIOUS_TIMER="$BACKUP_DIR/timer"; fi

if [[ -e "$RELEASE_DIR" ]]; then
  [[ -f "$RELEASE_DIR/.deploy/current-sha" ]] || fail "existing canonical release missing SHA marker" 9
  [[ "$(tr -d '[:space:]' < "$RELEASE_DIR/.deploy/current-sha")" == "$TARGET_SHA" ]] || fail "existing canonical release SHA mismatch" 9
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

SELF_CHECK="$(node "$RELEASE_DIR/$RUNNER_REL" self-check)" || fail "canonical runtime self-check failed" 10
node - "$SELF_CHECK" <<'NODE'
const value = JSON.parse(process.argv[2]);
if (value?.defaultEnabled !== false
  || value?.activationApplied !== false
  || value?.canonicalEconomicCredit !== 0
  || value?.privateTradingApiAllowed !== false
  || value?.executionAuthority !== 'NONE'
  || value?.protectedActivationRecordRequired !== true) process.exit(1);
NODE

SERVER_EVIDENCE_TARGET_SHA="$TARGET_SHA" \
SERVER_EVIDENCE_ACTIVATION_RECEIPT_COMMENT_ID="$ACTIVATION_RECEIPT_COMMENT_ID" \
SERVER_EVIDENCE_EXPECTED_BINDING_DIGEST="$ACTIVATION_BINDING_DIGEST" \
SERVER_EVIDENCE_CANONICAL_AUTHORITY_COMMENT_ID="$CANONICAL_AUTHORITY_COMMENT_ID" \
SERVER_EVIDENCE_CANONICAL_AUTHORIZED_AT_MS="$CANONICAL_AUTHORIZED_AT_MS" \
SERVER_EVIDENCE_ACTIVATION_RECEIPT_MAIN_SHA="$ACTIVATION_RECEIPT_MAIN_SHA" \
SERVER_EVIDENCE_COMPONENT_DIGEST="$COMPONENT_DIGEST" \
SERVER_EVIDENCE_COMPONENT_EQUIVALENT_CURRENT_MAIN=true \
SERVER_EVIDENCE_CANONICAL_ACTIVATION_PATH="$ACTIVATION_PATH" \
SERVER_EVIDENCE_STATE_ROOT="$STATE_ROOT" \
SERVER_EVIDENCE_SHADOW_STATE_ROOT="$SHADOW_STATE_ROOT" \
node "$RELEASE_DIR/$RUNNER_REL" prepare-activation
ACTIVATION_CREATED=true
# The activation record contains only public provenance/safety metadata. The
# DynamicUser service must be able to read it, while root remains the only writer.
chmod 0644 "$ACTIVATION_PATH"

MUTATION_STARTED=true
install -m 0644 "$RELEASE_DIR/market-intelligence-sidecar/deploy/$CANONICAL_SERVICE" "$SYSTEMD_DIR/$CANONICAL_SERVICE"
install -m 0644 "$RELEASE_DIR/market-intelligence-sidecar/deploy/$CANONICAL_TIMER" "$SYSTEMD_DIR/$CANONICAL_TIMER"
ln -sfn "$RELEASE_DIR" "$CURRENT_LINK.tmp"
mv -Tf "$CURRENT_LINK.tmp" "$CURRENT_LINK"
systemctl daemon-reload
systemctl disable --now "$SHADOW_TIMER"
systemctl enable --now "$CANONICAL_TIMER"
systemctl is-enabled --quiet "$CANONICAL_TIMER"
systemctl is-active --quiet "$CANONICAL_TIMER"
! systemctl is-active --quiet "$SHADOW_TIMER"
! systemctl is-failed --quiet "$CANONICAL_SERVICE"
[[ "$(tr -d '[:space:]' < "$CURRENT_LINK/.deploy/current-sha")" == "$TARGET_SHA" ]] || fail "canonical runtime marker mismatch" 11

STATUS="$(SERVER_EVIDENCE_CANONICAL_ACTIVATION_PATH="$ACTIVATION_PATH" SERVER_EVIDENCE_STATE_ROOT="$STATE_ROOT" node "$CURRENT_LINK/$RUNNER_REL" status)" || fail "canonical runtime status failed" 12
node - "$STATUS" <<'NODE'
const value = JSON.parse(process.argv[2]);
if (value?.status !== 'ACTIVE_PROTECTED_CANONICAL_RUNTIME'
  || value?.canonicalEconomicCredit !== 0
  || value?.canonicalIngestPerformed !== false
  || value?.executionAuthority !== 'NONE') process.exit(1);
NODE

MUTATION_STARTED=false
cleanup_backup
trap - EXIT
printf '%s\n' "$STATUS"
