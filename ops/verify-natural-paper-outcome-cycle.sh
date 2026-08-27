#!/usr/bin/env bash
set -Eeuo pipefail

TARGET_SHA="${1:-}"
ACTIVATION_AT_MS="${2:-}"
ROOT="${PAPER_FORWARD_STATE_ROOT:-/opt/stock-app-data/paper-forward-v1}"
INVOCATIONS="$ROOT/runtime-state/status/invocations.jsonl"
STATE="$ROOT/runtime-state/state/recurring-paper-loop.json"
STATUS="$ROOT/runtime-state/status/runtime-status.json"
ACTIVATION="$ROOT/activation.json"
MARKER="${LIVE_DIR:-/opt/stock-app}/.deploy/current-sha"
TAG="# stock-app-paper-forward-v1"

[[ "$TARGET_SHA" =~ ^[0-9a-f]{40}$ ]] || exit 2
[[ "$ACTIVATION_AT_MS" =~ ^[0-9]+$ ]] || exit 2
[[ "$ROOT" == /opt/stock-app-data/paper-forward-v1 ]] || exit 3
[[ -r "$INVOCATIONS" && -r "$STATE" && -r "$STATUS" && -r "$ACTIVATION" && -r "$MARKER" ]] || exit 75
[[ "$(tr -d '[:space:]' < "$MARKER")" == "$TARGET_SHA" ]] || exit 76

node - "$INVOCATIONS" "$STATE" "$STATUS" "$ACTIVATION" "$ACTIVATION_AT_MS" "$TARGET_SHA" "$TAG" <<'NODE'
const fs = require('node:fs');
const cp = require('node:child_process');
const [invocationsPath, statePath, statusPath, activationPath, activationAtRaw, targetSha, tag] = process.argv.slice(2);

const lines = fs.readFileSync(invocationsPath, 'utf8').trim().split(/\r?\n/).filter(Boolean);
const candidates = lines.map((line) => JSON.parse(line)).filter((row) =>
  row.triggerSource === 'cron' && Number(row.invokedAtMs) >= Number(activationAtRaw));
const invocation = candidates.at(-1);
if (!invocation) process.exit(75);

const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
const status = JSON.parse(fs.readFileSync(statusPath, 'utf8'));
const activation = JSON.parse(fs.readFileSync(activationPath, 'utf8'));
const cronText = cp.execFileSync('crontab', ['-l'], { encoding: 'utf8' });
const cronMatches = cronText.split(/\r?\n/).filter((line) => line.includes(tag)).length;
const positions = Array.isArray(state.positions) ? state.positions : null;
const settlements = Array.isArray(state.settlements) ? state.settlements : null;
const account = invocation.authoritativeAccount;

const checks = {
  targetShaExact: state?.identity?.researchCodeSha === targetSha,
  naturalCron: invocation.naturalScheduleInvocation === true,
  completed: invocation.status === 'COMPLETED',
  oneCanonicalMutation: invocation.mutationCount === 1,
  publicForwardEvidenceAccumulating: invocation.publicForwardEvidenceAccumulating === true,
  outcomeCapabilityEnabled: invocation.paperTradeOutcomeAccumulationEnabled === true,
  financialAdaptersEnabled: invocation.financialMutationAdaptersEnabled === true
    && invocation.simulatedFinancialAdaptersEnabled === true,
  authoritativeAccountRequired: invocation.authoritativeAccountRequired === true
    && status.authoritativeAccountRequired === true,
  authoritativeAccountBound: account?.accountBindingVerified === true
    && account?.schemaVersion === 'authoritative-natural-paper-accounting-summary-v1',
  authoritativeLedgerPersisted: state?.ledger?.schemaVersion === 'authoritative-natural-paper-account-ledger-v1',
  fourReadyProviders: Array.isArray(invocation.providerLanes)
    && invocation.providerLanes.length === 4
    && invocation.providerLanes.every((lane) => lane.status === 'READY'),
  scheduleActive: status.scheduleActive === true,
  persistedOutcomeCapability: status.paperTradeOutcomeAccumulationEnabled === true
    && status.financialMutationAdaptersEnabled === true
    && status.simulatedFinancialAdaptersEnabled === true,
  stateCyclePersisted: Array.isArray(state.cycles) && state.cycles.length >= 1,
  positionCollectionPresent: positions !== null,
  settlementCollectionPresent: settlements !== null,
  activationContractEnabled: activation.paperTradeOutcomeAccumulationEnabled === true
    && activation.simulatedFinancialAdaptersEnabled === true
    && activation.externalFinancialMutationAllowed === false,
  noPrivate: invocation.privateRequestCount === 0,
  noExternalFinancialMutation: invocation.financialMutationCount === 0
    && invocation.externalFinancialMutationAllowed === false,
  noOrders: invocation.orderCount === 0,
  liveOff: invocation.liveTrading === false && invocation.orderAuthority === false,
  oneCronEntry: cronMatches === 1,
  disableSentinelAbsent: !fs.existsSync('/opt/stock-app-data/paper-forward-v1/DISABLED'),
};

const failed = Object.entries(checks).filter(([, value]) => value !== true).map(([key]) => key);
if (failed.length) {
  console.error(`Natural Paper outcome-capable cycle failed: ${failed.join(', ')}`);
  process.exit(77);
}

const sanitized = {
  schemaVersion: 'natural-paper-outcome-cycle-evidence-v1',
  status: 'passed',
  targetSha,
  activationAtMs: Number(activationAtRaw),
  observedAtMs: Date.now(),
  checks,
  invocation: {
    cycleId: invocation.cycleId,
    invokedAtMs: invocation.invokedAtMs,
    completedAtMs: invocation.completedAtMs,
    status: invocation.status,
    mutationCount: invocation.mutationCount,
    providerLanes: invocation.providerLanes,
  },
  state: {
    cycleCount: state.cycles.length,
    positionCount: positions.length,
    settlementCount: settlements.length,
  },
  authoritativeAccount: {
    schemaVersion: account.schemaVersion,
    currency: account.currency,
    accountBindingVerified: account.accountBindingVerified,
  },
  scheduleActive: true,
  publicForwardEvidenceAccumulating: true,
  paperTradeOutcomeAccumulationEnabled: true,
  paperTradeOutcomeAccumulating: invocation.paperTradeOutcomeAccumulating === true,
  zeroOutcomeFirstCycleAllowed: true,
  profitabilityClaimed: false,
  privateRequestCount: 0,
  financialMutationCount: 0,
  orderCount: 0,
  liveTrading: false,
  executionAuthority: 'NONE',
};
process.stdout.write(`${JSON.stringify(sanitized, null, 2)}\n`);
NODE
