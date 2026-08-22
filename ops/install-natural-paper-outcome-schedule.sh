#!/usr/bin/env bash
set -Eeuo pipefail

umask 077

TARGET_SHA="${1:-}"
LIVE_DIR="${LIVE_DIR:-/opt/stock-app}"
STATE_ROOT="${PAPER_FORWARD_STATE_ROOT:-/opt/stock-app-data/paper-forward-v1}"
RUNTIME_STATE_ROOT="$STATE_ROOT/runtime-state"
MODE_ARCHIVE_ROOT="$STATE_ROOT/mode-archives"
MODE_CUTOVER_ROOT="$STATE_ROOT/mode-cutovers"
DEPLOY_MARKER="$LIVE_DIR/.deploy/current-sha"
INSTALLER="$LIVE_DIR/ops/install-paper-forward-schedule.sh"
TAG="# stock-app-paper-forward-v1"
EXPECTED_STRATEGY_ID="paper-forward-authoritative-account-v1"
MODE_CUTOVER="false"
ARCHIVED_STRATEGY_ID=""
ARCHIVE_PATH=""
RESTORE_ARCHIVE_ON_ERROR=0

fail() {
  echo "[natural-paper-outcome-activate] $1" >&2
  exit "${2:-1}"
}

restore_on_error() {
  local status=$?
  trap - EXIT
  if (( status != 0 )) && [[ "$RESTORE_ARCHIVE_ON_ERROR" == 1 ]] && [[ -n "$ARCHIVE_PATH" ]] && [[ -d "$ARCHIVE_PATH" ]]; then
    rm -rf -- "$RUNTIME_STATE_ROOT"
    mv "$ARCHIVE_PATH" "$RUNTIME_STATE_ROOT" || true
  fi
  exit "$status"
}
trap restore_on_error EXIT

[[ "$TARGET_SHA" =~ ^[0-9a-f]{40}$ ]] || fail "exact lowercase 40-character SHA required" 2
[[ "$STATE_ROOT" == /opt/stock-app-data/paper-forward-v1 ]] || fail "unexpected persistent state root" 3
[[ -r "$DEPLOY_MARKER" ]] || fail "production deploy marker missing" 4
DEPLOYED_SHA="$(tr -d '[:space:]' < "$DEPLOY_MARKER")"
[[ "$DEPLOYED_SHA" == "$TARGET_SHA" ]] || fail "production SHA mismatch: $DEPLOYED_SHA" 5
[[ -r "$INSTALLER" ]] || fail "canonical Paper Forward installer missing" 6

for flag_name in LIVE_TRADING AUTO_TRADING REAL_ORDER_ENABLED PRIVATE_TRADING_API_ALLOWED; do
  flag_value="${!flag_name:-false}"
  [[ "$flag_value" != "true" ]] || fail "$flag_name must remain false" 7
done

export LIVE_TRADING=false
export AUTO_TRADING=false
export REAL_ORDER_ENABLED=false
export PRIVATE_TRADING_API_ALLOWED=false
export PAPER_FORWARD_OUTCOME_ACCUMULATION_ENABLED=true

mkdir -p "$MODE_ARCHIVE_ROOT" "$MODE_CUTOVER_ROOT"
chmod 700 "$MODE_ARCHIVE_ROOT" "$MODE_CUTOVER_ROOT"

STATE_FILE="$RUNTIME_STATE_ROOT/state/recurring-paper-loop.json"
if [[ -r "$STATE_FILE" ]]; then
  readarray -t STATE_IDENTITY < <(node - "$STATE_FILE" <<'NODE'
const fs = require('node:fs');
const state = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const strategyId = String(state?.identity?.strategyId ?? '').trim();
const researchCodeSha = String(state?.identity?.researchCodeSha ?? '').trim().toLowerCase();
if (!strategyId || !/^[0-9a-f]{40}$/.test(researchCodeSha)) process.exit(1);
process.stdout.write(`${strategyId}\n${researchCodeSha}\n`);
NODE
  )
  [[ "${#STATE_IDENTITY[@]}" == 2 ]] || fail "existing Paper runtime identity is invalid" 8
  EXISTING_STRATEGY_ID="${STATE_IDENTITY[0]:-}"
  EXISTING_RESEARCH_SHA="${STATE_IDENTITY[1]:-}"
  [[ -n "$EXISTING_STRATEGY_ID" && "$EXISTING_RESEARCH_SHA" =~ ^[0-9a-f]{40}$ ]] \
    || fail "existing Paper runtime identity is invalid" 8

  if [[ "$EXISTING_RESEARCH_SHA" == "$TARGET_SHA" && "$EXISTING_STRATEGY_ID" != "$EXPECTED_STRATEGY_ID" ]]; then
    EXISTING_MANAGED_CRON_COUNT="$(crontab -l 2>/dev/null | grep -Fc "$TAG" || true)"
    [[ "$EXISTING_MANAGED_CRON_COUNT" == 0 ]] || fail "Natural Paper mode cutover requires the prior schedule to be disabled" 9

    CUTOVER_STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
    ARCHIVE_PATH="$MODE_ARCHIVE_ROOT/${TARGET_SHA}-${EXISTING_STRATEGY_ID}-to-${EXPECTED_STRATEGY_ID}-$CUTOVER_STAMP"
    [[ ! -e "$ARCHIVE_PATH" ]] || fail "mode archive path already exists" 10
    mv "$RUNTIME_STATE_ROOT" "$ARCHIVE_PATH"
    mkdir -p "$RUNTIME_STATE_ROOT"
    chmod 700 "$RUNTIME_STATE_ROOT"
    MODE_CUTOVER="true"
    ARCHIVED_STRATEGY_ID="$EXISTING_STRATEGY_ID"
    RESTORE_ARCHIVE_ON_ERROR=1
  fi
fi

set +e
ACTIVATION_OUTPUT="$(PAPER_FORWARD_OUTCOME_ACCUMULATION_ENABLED=true bash "$INSTALLER" "$TARGET_SHA")"
INSTALL_STATUS=$?
set -e
[[ "$INSTALL_STATUS" == 0 ]] || exit "$INSTALL_STATUS"

if [[ "$MODE_CUTOVER" == "true" ]]; then
  node - "$MODE_CUTOVER_ROOT/$TARGET_SHA.json" "$TARGET_SHA" "$ARCHIVED_STRATEGY_ID" "$EXPECTED_STRATEGY_ID" "$ARCHIVE_PATH" <<'NODE'
const fs = require('node:fs');
const [path, targetSha, archivedStrategyId, targetStrategyId, archivePath] = process.argv.slice(2);
const value = {
  schemaVersion: 'paper-forward-mode-clean-cutover-v1',
  targetSha,
  archivedStrategyId,
  targetStrategyId,
  archivePath,
  predecessorStatePreserved: true,
  predecessorPerformanceMixed: false,
  newIdentityStartsFromZero: true,
  executionAuthority: 'NONE',
  privateRequestCount: 0,
  financialMutationCount: 0,
  orderCount: 0,
  liveTrading: false,
};
const temp = `${path}.tmp-${process.pid}`;
fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
fs.renameSync(temp, path);
NODE
  chmod 600 "$MODE_CUTOVER_ROOT/$TARGET_SHA.json"
fi

RESTORE_ARCHIVE_ON_ERROR=0
trap - EXIT

printf '%s' "$ACTIVATION_OUTPUT" | node - "$MODE_CUTOVER" "$ARCHIVED_STRATEGY_ID" <<'NODE'
const fs = require('node:fs');
const [modeCutoverRaw, archivedStrategyIdRaw] = process.argv.slice(2);
const input = fs.readFileSync(0, 'utf8').trim();
const value = JSON.parse(input);
const enriched = {
  ...value,
  schemaVersion: 'natural-paper-outcome-schedule-activation-v1',
  activationMode: 'NATURAL_PAPER_OUTCOME',
  paperTradeOutcomeAccumulationEnabled: true,
  simulatedFinancialAdaptersEnabled: true,
  externalFinancialMutationAllowed: false,
  modeCutover: modeCutoverRaw === 'true',
  archivedStrategyId: archivedStrategyIdRaw || null,
  executionAuthority: 'NONE',
  privateRequestCount: 0,
  financialMutationCount: 0,
  orderCount: 0,
  liveTrading: false,
};
process.stdout.write(`${JSON.stringify(enriched)}\n`);
NODE
