#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

TARGET_SHA="${1:-}"
STATE_ROOT="${PUMP_PROSPECTIVE_STATE_ROOT:-/opt/stock-app-data/pump-reversal-v1}"
RUNTIME_STATE_ROOT="$STATE_ROOT/runtime-state"
RELEASE_ROOT="$STATE_ROOT/releases"
PINNED_RELEASE="$RELEASE_ROOT/$TARGET_SHA"
BIN_DIR="$STATE_ROOT/bin"
LOG_DIR="$STATE_ROOT/logs"
BACKUP_DIR="$STATE_ROOT/crontab-backups"
POLICY_DIR="$STATE_ROOT/policy"
INPUT_DIR="$STATE_ROOT/inputs"
POLICY_PATH="$POLICY_DIR/pump-prospective-policy-v1.json"
RUNTIME_BUNDLE_SOURCE="${PUMP_RUNTIME_BUNDLE_SOURCE:-}"
POLICY_SOURCE="${PUMP_POLICY_SOURCE:-}"
PAPER_STATE_SNAPSHOT_PATH="${PUMP_PAPER_STATE_SNAPSHOT_PATH:-/opt/stock-app-data/paper-forward-v1/publisher/paper-state-v2.json}"
SUPPLEMENTAL_COST_EVIDENCE_PATH="${PUMP_SUPPLEMENTAL_COST_EVIDENCE_PATH:-$INPUT_DIR/supplemental-cost.json}"
PRODUCTION_APP_SHA="${PRODUCTION_APP_SHA:-}"
PUMP_ALLOWED_POLICY_RESEARCH_SHA="${PUMP_ALLOWED_POLICY_RESEARCH_SHA:-}"
PUMP_OPERATIONAL_RETRY_EQUIVALENCE_VERIFIED="${PUMP_OPERATIONAL_RETRY_EQUIVALENCE_VERIFIED:-false}"
DEPLOY_MARKER=/opt/stock-app/.deploy/current-sha
RUNTIME_BUNDLE="$PINNED_RELEASE/pump-runtime.mjs"
WRAPPER="$BIN_DIR/run-pump-reversal-prospective"
CRON_LOCK="$STATE_ROOT/cron.lock"
TAG="# stock-app-pump-reversal-v1"
CRON_EXPRESSION="* * * * *"
PREVIOUS_CRONTAB=""
CRONTAB_MUTATED=0

fail() {
  printf '[pump-paper-activate] %s\n' "$1" >&2
  exit "${2:-1}"
}

mark_disabled() {
  mkdir -p "$STATE_ROOT" "$RUNTIME_STATE_ROOT"
  : > "$STATE_ROOT/DISABLED"
  chmod 600 "$STATE_ROOT/DISABLED"
}

restore_on_error() {
  local status=$?
  trap - EXIT
  if (( status != 0 )) && [[ "$CRONTAB_MUTATED" == 1 ]]; then
    printf '%s' "$PREVIOUS_CRONTAB" | crontab - || true
  fi
  if (( status != 0 )); then
    mark_disabled
  fi
  exit "$status"
}
trap restore_on_error EXIT

[[ "$TARGET_SHA" =~ ^[0-9a-f]{40}$ ]] || fail "exact lowercase 40-character SHA required" 2
[[ "$STATE_ROOT" == /opt/stock-app-data/pump-reversal-v1 ]] || fail "unexpected persistent state root" 3
[[ "$STATE_ROOT" != /opt/stock-app && "$STATE_ROOT" != /opt/stock-app/* ]] || fail "state root must remain outside application deploy tree" 3
[[ "$RUNTIME_BUNDLE_SOURCE" == /* && -r "$RUNTIME_BUNDLE_SOURCE" ]] || fail "exact Pump runtime bundle source required" 4
[[ "$POLICY_SOURCE" == /* && -r "$POLICY_SOURCE" ]] || fail "frozen Pump policy source required" 4
[[ "$PAPER_STATE_SNAPSHOT_PATH" == /* ]] || fail "Paper snapshot path must be absolute" 4
[[ "$SUPPLEMENTAL_COST_EVIDENCE_PATH" == /* ]] || fail "supplemental cost path must be absolute" 4
[[ -r "$DEPLOY_MARKER" ]] || fail "production application deploy marker missing" 5
DEPLOYED_SHA="$(tr -d '[:space:]' < "$DEPLOY_MARKER")"
[[ "$DEPLOYED_SHA" =~ ^[0-9a-f]{40}$ ]] || fail "production application SHA invalid" 5
[[ -z "$PRODUCTION_APP_SHA" || "$PRODUCTION_APP_SHA" == "$DEPLOYED_SHA" ]] || fail "production application SHA changed before activation" 5

for command_name in node flock crontab mkdir rm mv cp date sha256sum grep sed wc pgrep chmod tr awk; do
  command -v "$command_name" >/dev/null 2>&1 || fail "missing command: $command_name" 6
done
if command -v systemctl >/dev/null 2>&1; then
  systemctl is-active --quiet cron || pgrep -x cron >/dev/null || fail "cron daemon is not active" 7
else
  pgrep -x cron >/dev/null || fail "cron daemon is not active" 7
fi

mkdir -p "$STATE_ROOT" "$RUNTIME_STATE_ROOT" "$RELEASE_ROOT" "$PINNED_RELEASE" "$BIN_DIR" "$LOG_DIR" "$BACKUP_DIR" "$POLICY_DIR" "$INPUT_DIR"
chmod 700 "$STATE_ROOT" "$RUNTIME_STATE_ROOT" "$RELEASE_ROOT" "$PINNED_RELEASE" "$BIN_DIR" "$LOG_DIR" "$BACKUP_DIR" "$POLICY_DIR" "$INPUT_DIR"

SOURCE_BUNDLE_DIGEST="$(sha256sum "$RUNTIME_BUNDLE_SOURCE" | awk '{print $1}')"
if [[ -e "$RUNTIME_BUNDLE" ]]; then
  EXISTING_BUNDLE_DIGEST="$(sha256sum "$RUNTIME_BUNDLE" | awk '{print $1}')"
  [[ "$EXISTING_BUNDLE_DIGEST" == "$SOURCE_BUNDLE_DIGEST" ]] || fail "existing Pump runtime differs for exact target SHA" 8
else
  cp "$RUNTIME_BUNDLE_SOURCE" "$RUNTIME_BUNDLE.tmp-$$"
  chmod 600 "$RUNTIME_BUNDLE.tmp-$$"
  mv "$RUNTIME_BUNDLE.tmp-$$" "$RUNTIME_BUNDLE"
fi

policy_summary_for_path() {
  node --input-type=module - "$1" <<'NODE'
import fs from 'node:fs';
const [path] = process.argv.slice(2);
const value = JSON.parse(fs.readFileSync(path, 'utf8'));
const valid = value?.schemaVersion === 'crypto-pump-reversal-prospective-policy-v1'
  && value?.status === 'FROZEN_PROSPECTIVE_RESEARCH_ONLY'
  && /^[0-9a-f]{40}$/u.test(String(value?.candidate?.researchCodeSha ?? ''))
  && value?.candidate?.strategyId === 'CRYPTO_PUMP_REVERSAL_SHORT_CLEAN_V1'
  && value?.candidate?.market === 'CRYPTO_FUTURES'
  && value?.candidate?.direction === 'SHORT'
  && typeof value?.candidate?.candidateId === 'string'
  && typeof value?.candidate?.parameterHash === 'string'
  && Number.isSafeInteger(value?.policyFrozenAtMs)
  && Number.isSafeInteger(value?.eligibleAfterMs)
  && value.eligibleAfterMs >= value.policyFrozenAtMs + 86400000
  && value?.bootstrap?.rawProspectiveSampleEconomicCredit === 0
  && value?.safety?.profitabilityProven === false
  && value?.safety?.executionAuthority === 'NONE'
  && value?.safety?.liveTrading === false
  && value?.safety?.autoTrading === false
  && value?.safety?.realOrderEnabled === false
  && value?.safety?.privateTradingApiAllowed === false;
if (!valid) process.exit(1);
process.stdout.write(JSON.stringify({
  policyFrozenAtMs: value.policyFrozenAtMs,
  eligibleAfterMs: value.eligibleAfterMs,
  candidateId: value.candidate.candidateId,
  parameterHash: value.candidate.parameterHash,
  researchCodeSha: value.candidate.researchCodeSha,
  strategyId: value.candidate.strategyId,
  market: value.candidate.market,
  direction: value.candidate.direction,
  policyDigest: value.policyDigest,
}));
NODE
}

SOURCE_POLICY_SUMMARY="$(policy_summary_for_path "$POLICY_SOURCE")"   || fail "frozen Pump policy invalid" 9
SOURCE_RESEARCH_SHA="$(node -e 'const v=JSON.parse(process.argv[1]); process.stdout.write(String(v.researchCodeSha))' "$SOURCE_POLICY_SUMMARY")"
[[ "$SOURCE_RESEARCH_SHA" == "$TARGET_SHA" ]] || fail "source Pump policy is not bound to exact target SHA" 9

if [[ -e "$POLICY_PATH" ]]; then
  POLICY_SUMMARY="$(policy_summary_for_path "$POLICY_PATH")"     || fail "existing Pump policy invalid" 9
  SOURCE_CANDIDATE_ID="$(node -e 'const v=JSON.parse(process.argv[1]); process.stdout.write(String(v.candidateId))' "$SOURCE_POLICY_SUMMARY")"
  EXISTING_CANDIDATE_ID="$(node -e 'const v=JSON.parse(process.argv[1]); process.stdout.write(String(v.candidateId))' "$POLICY_SUMMARY")"
  SOURCE_PARAMETER_HASH="$(node -e 'const v=JSON.parse(process.argv[1]); process.stdout.write(String(v.parameterHash))' "$SOURCE_POLICY_SUMMARY")"
  EXISTING_PARAMETER_HASH="$(node -e 'const v=JSON.parse(process.argv[1]); process.stdout.write(String(v.parameterHash))' "$POLICY_SUMMARY")"
  EXISTING_RESEARCH_SHA="$(node -e 'const v=JSON.parse(process.argv[1]); process.stdout.write(String(v.researchCodeSha))' "$POLICY_SUMMARY")"
  SOURCE_STRATEGY_ID="$(node -e 'const v=JSON.parse(process.argv[1]); process.stdout.write(String(v.strategyId))' "$SOURCE_POLICY_SUMMARY")"
  EXISTING_STRATEGY_ID="$(node -e 'const v=JSON.parse(process.argv[1]); process.stdout.write(String(v.strategyId))' "$POLICY_SUMMARY")"
  SOURCE_MARKET="$(node -e 'const v=JSON.parse(process.argv[1]); process.stdout.write(String(v.market))' "$SOURCE_POLICY_SUMMARY")"
  EXISTING_MARKET="$(node -e 'const v=JSON.parse(process.argv[1]); process.stdout.write(String(v.market))' "$POLICY_SUMMARY")"
  SOURCE_DIRECTION="$(node -e 'const v=JSON.parse(process.argv[1]); process.stdout.write(String(v.direction))' "$SOURCE_POLICY_SUMMARY")"
  EXISTING_DIRECTION="$(node -e 'const v=JSON.parse(process.argv[1]); process.stdout.write(String(v.direction))' "$POLICY_SUMMARY")"

  [[ "$EXISTING_PARAMETER_HASH" == "$SOURCE_PARAMETER_HASH"     && "$EXISTING_STRATEGY_ID" == "$SOURCE_STRATEGY_ID"     && "$EXISTING_MARKET" == "$SOURCE_MARKET"     && "$EXISTING_DIRECTION" == "$SOURCE_DIRECTION" ]]     || fail "existing Pump policy strategy identity mismatch; refusing retry" 9

  if [[ "$EXISTING_RESEARCH_SHA" == "$TARGET_SHA" ]]; then
    [[ "$EXISTING_CANDIDATE_ID" == "$SOURCE_CANDIDATE_ID" ]]       || fail "existing Pump policy candidate identity mismatch; refusing retry" 9
  else
    [[ "$PUMP_OPERATIONAL_RETRY_EQUIVALENCE_VERIFIED" == true       && "$PUMP_ALLOWED_POLICY_RESEARCH_SHA" == "$EXISTING_RESEARCH_SHA" ]]       || fail "cross-SHA Pump policy reuse requires verified operational-only retry" 9
  fi
else
  cp "$POLICY_SOURCE" "$POLICY_PATH.tmp-$"
  chmod 600 "$POLICY_PATH.tmp-$"
  mv "$POLICY_PATH.tmp-$" "$POLICY_PATH"
  POLICY_SUMMARY="$SOURCE_POLICY_SUMMARY"
fi

POLICY_FROZEN_AT_MS="$(node -e 'const v=JSON.parse(process.argv[1]); process.stdout.write(String(v.policyFrozenAtMs))' "$POLICY_SUMMARY")"
ELIGIBLE_AFTER_MS="$(node -e 'const v=JSON.parse(process.argv[1]); process.stdout.write(String(v.eligibleAfterMs))' "$POLICY_SUMMARY")"
CANDIDATE_ID="$(node -e 'const v=JSON.parse(process.argv[1]); process.stdout.write(String(v.candidateId))' "$POLICY_SUMMARY")"
POLICY_DIGEST="$(node -e 'const v=JSON.parse(process.argv[1]); process.stdout.write(String(v.policyDigest))' "$POLICY_SUMMARY")"
POLICY_RESEARCH_SHA="$(node -e 'const v=JSON.parse(process.argv[1]); process.stdout.write(String(v.researchCodeSha))' "$POLICY_SUMMARY")"
OPERATIONAL_RETRY_EQUIVALENCE_VERIFIED=false
[[ "$POLICY_RESEARCH_SHA" == "$TARGET_SHA" ]] || OPERATIONAL_RETRY_EQUIVALENCE_VERIFIED=true

NODE_BIN="$(command -v node)"
FLOCK_BIN="$(command -v flock)"
TEMP_WRAPPER="$WRAPPER.tmp-$$"
cat > "$TEMP_WRAPPER" <<WRAPPER
#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
STATE_ROOT='$STATE_ROOT'
LOG_FILE='$LOG_DIR/cron.log'
[[ ! -e "\$STATE_ROOT/DISABLED" ]] || exit 0
if [[ -f "\$LOG_FILE" && "\$(wc -c < "\$LOG_FILE")" -gt 5242880 ]]; then
  mv -f "\$LOG_FILE" '$LOG_DIR/cron.previous.log'
fi
exec >>"\$LOG_FILE" 2>&1
printf '[pump-paper-cron] invoked_at=%s\n' "\$(date -u +%Y-%m-%dT%H:%M:%SZ)"
exec /usr/bin/env -i \
  HOME="\${HOME:-/tmp}" \
  PATH='/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin' \
  NODE_ENV='production' \
  PUMP_PROSPECTIVE_STATE_ROOT='$RUNTIME_STATE_ROOT' \
  PUMP_PROSPECTIVE_POLICY_PATH='$POLICY_PATH' \
  PUMP_PAPER_STATE_SNAPSHOT_PATH='$PAPER_STATE_SNAPSHOT_PATH' \
  PUMP_SUPPLEMENTAL_COST_EVIDENCE_PATH='$SUPPLEMENTAL_COST_EVIDENCE_PATH' \
  PUMP_PROSPECTIVE_OWNER_ID='pump-cron:$TARGET_SHA' \
  PUMP_PROSPECTIVE_SCHEDULE_ACTIVE='true' \
  LIVE_TRADING='false' \
  LIVE_TRADING_ENABLED='false' \
  AUTO_TRADING='false' \
  REAL_ORDER_ENABLED='false' \
  PRIVATE_API_ENABLED='false' \
  PRIVATE_ACCOUNT_ACCESS='false' \
  PRIVATE_TRADING_API_ALLOWED='false' \
  '$NODE_BIN' '$RUNTIME_BUNDLE'
WRAPPER
chmod 700 "$TEMP_WRAPPER"
mv "$TEMP_WRAPPER" "$WRAPPER"

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
[[ "$MATCH_COUNT" == 1 ]] || fail "exactly one Pump Paper cron entry is required" 10

ACTIVATION_AT_MS="$("$NODE_BIN" -e 'process.stdout.write(String(Date.now()))')"
PAPER_STATE_AVAILABLE=false
SUPPLEMENTAL_COST_AVAILABLE=false
[[ -r "$PAPER_STATE_SNAPSHOT_PATH" ]] && PAPER_STATE_AVAILABLE=true
[[ -r "$SUPPLEMENTAL_COST_EVIDENCE_PATH" ]] && SUPPLEMENTAL_COST_AVAILABLE=true
"$NODE_BIN" --input-type=module - "$STATE_ROOT/activation.json" "$TARGET_SHA" "$POLICY_RESEARCH_SHA" "$OPERATIONAL_RETRY_EQUIVALENCE_VERIFIED" "$DEPLOYED_SHA" "$ACTIVATION_AT_MS" "$POLICY_FROZEN_AT_MS" "$ELIGIBLE_AFTER_MS" "$CANDIDATE_ID" "$POLICY_DIGEST" "$SOURCE_BUNDLE_DIGEST" "$BACKUP_PATH" "$PAPER_STATE_AVAILABLE" "$SUPPLEMENTAL_COST_AVAILABLE" <<'NODE'
import fs from 'node:fs';
const [
  path, targetSha, policyResearchCodeSha, operationalRetryEquivalenceVerifiedRaw,
  productionAppSha, activationAtMsRaw, policyFrozenAtMsRaw,
  eligibleAfterMsRaw, candidateId, policyDigest, runtimeDigest, backupPath,
  paperStateAvailableRaw, supplementalCostAvailableRaw,
] = process.argv.slice(2);
const value = {
  schemaVersion: 'pump-reversal-prospective-schedule-activation-v1',
  status: Number(activationAtMsRaw) >= Number(eligibleAfterMsRaw)
    ? 'ACTIVE_GENUINE_PROSPECTIVE_ELIGIBLE'
    : 'ACTIVE_WAITING_FOR_24H_FUTURE_BOUNDARY',
  targetSha,
  paperRuntimeSourceSha: targetSha,
  policyResearchCodeSha,
  operationalRetryEquivalenceVerified:
    policyResearchCodeSha === targetSha ? false : operationalRetryEquivalenceVerifiedRaw === 'true',
  productionAppShaBefore: productionAppSha,
  productionAppDeployPerformed: false,
  productionAppMutationAllowed: false,
  activationAtMs: Number(activationAtMsRaw),
  policyFrozenAtMs: Number(policyFrozenAtMsRaw),
  eligibleAfterMs: Number(eligibleAfterMsRaw),
  candidateId,
  policyDigest,
  runtimeDigest,
  crontabBackupPath: backupPath,
  scheduleActive: true,
  pollCadence: 'EVERY_1_MINUTE',
  signalUniverseScanCadence: 'ONCE_PER_CLOSED_1H_BAR',
  positionMonitoringCadence: 'INCREMENTAL_CLOSED_1M',
  rawProspectiveCollectionActive: true,
  rawProspectiveCreditBeforeEligibleAfterMs: 0,
  paperStateSnapshotAvailableAtActivation: paperStateAvailableRaw === 'true',
  supplementalCostEvidenceAvailableAtActivation: supplementalCostAvailableRaw === 'true',
  economicSizingReadyAtActivation: paperStateAvailableRaw === 'true' && supplementalCostAvailableRaw === 'true',
  economicSizingRequiresAuthoritativeEvidence: true,
  fullCostRequiresEightComponents: true,
  missingEconomicEvidenceMayBecomeZero: false,
  publicDataOnly: true,
  simulatedOnly: true,
  liveTrading: false,
  autoTrading: false,
  realOrderEnabled: false,
  privateAccountAccess: false,
  privateTradingApiAllowed: false,
  financialMutationAllowed: false,
  executionAuthority: 'NONE',
  profitabilityProven: false,
  currentValidatedChampion: 'NONE',
};
const temp = `${path}.tmp-${process.pid}`;
fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
fs.renameSync(temp, path);
process.stdout.write(`${JSON.stringify(value)}\n`);
NODE

CRONTAB_MUTATED=0
trap - EXIT
