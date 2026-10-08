import { readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const SHA40 = /^[0-9a-f]{40}$/u;
const SHA64 = /^[0-9a-f]{64}$/u;
const MARKETS = Object.freeze(['CRYPTO_FUTURES', 'CRYPTO_SPOT', 'KR_STOCK', 'US_STOCK']);

function assert(condition, code) {
  if (!condition) throw new Error(`[production-paper-forward-readiness] ${code}`);
}

function readJson(file) {
  return JSON.parse(readFileSync(path.resolve(file), 'utf8'));
}

function assertZeroAuthority(value, prefix) {
  assert(value?.privateRequestCount === 0, `${prefix}_PRIVATE_REQUEST_NOT_ZERO`);
  assert(value?.financialMutationCount === 0, `${prefix}_FINANCIAL_MUTATION_NOT_ZERO`);
  assert(value?.orderCount === 0, `${prefix}_ORDER_COUNT_NOT_ZERO`);
  assert(value?.liveTrading === false, `${prefix}_LIVE_TRADING_NOT_FALSE`);
}

function assertFourReadyLanes(lanes, prefix) {
  assert(Array.isArray(lanes) && lanes.length === 4, `${prefix}_LANE_COUNT_INVALID`);
  const markets = lanes.map((lane) => String(lane?.market ?? '')).sort();
  assert(JSON.stringify(markets) === JSON.stringify(MARKETS), `${prefix}_MARKETS_INVALID`);
  assert(lanes.every((lane) => lane?.status === 'READY'), `${prefix}_LANE_NOT_READY`);
}

function verifyActivationEvidence(value, targetSha) {
  assert(value?.schemaVersion === 'paper-forward-natural-cycle-no-deploy-evidence-v2', 'ACTIVATION_SCHEMA_INVALID');
  assert(value?.status === 'passed', 'ACTIVATION_STATUS_INVALID');
  assert(value?.targetSha === targetSha, 'ACTIVATION_TARGET_SHA_MISMATCH');
  assert(value?.productionAppSha === targetSha, 'ACTIVATION_PRODUCTION_SHA_MISMATCH');
  const checks = value?.checks ?? {};
  for (const key of [
    'exactPaperRuntime', 'noAppDeploy', 'naturalCron', 'completed', 'oneMutation',
    'accumulating', 'outcomeModeEnabled', 'simulatedAdaptersEnabled',
    'externalFinancialMutationOff', 'fourReadyProviders', 'scheduleActive',
    'stateCyclePersisted', 'stateArraysValid', 'noPrivate', 'noFinancialMutation',
    'noOrders', 'liveOff', 'oneCronEntry', 'disableSentinelAbsent',
  ]) assert(checks[key] === true, `ACTIVATION_CHECK_FAILED:${key}`);
  assert(value?.invocation?.status === 'COMPLETED', 'ACTIVATION_INVOCATION_INCOMPLETE');
  assertFourReadyLanes(value?.invocation?.providerLanes, 'ACTIVATION');
  assert(Number.isFinite(Number(value?.invocation?.completedAtMs)), 'ACTIVATION_COMPLETED_AT_INVALID');
  assertZeroAuthority(value, 'ACTIVATION');
}

function verifyRuntimeEvidence(value, targetSha) {
  assert(value?.schemaVersion === 'production-paper-forward-runtime-readiness-v1', 'RUNTIME_SCHEMA_INVALID');
  assert(value?.status === 'passed', 'RUNTIME_STATUS_INVALID');
  assert(value?.targetSha === targetSha, 'RUNTIME_TARGET_SHA_MISMATCH');
  assert(value?.productionSha === targetSha, 'RUNTIME_PRODUCTION_SHA_MISMATCH');
  assert(value?.paperRuntimeSha === targetSha, 'RUNTIME_PAPER_SHA_MISMATCH');
  assert(value?.scheduleActive === true, 'RUNTIME_SCHEDULE_INACTIVE');
  assert(value?.oneCronEntry === true, 'RUNTIME_CRON_COUNT_INVALID');
  assert(value?.freshWithinMinutes === 30, 'RUNTIME_FRESHNESS_POLICY_INVALID');
  assert(value?.invocationFresh === true, 'RUNTIME_INVOCATION_STALE');
  assert(value?.handoffFresh === true, 'RUNTIME_HANDOFF_STALE');
  assert(value?.handoffStatus === 'READY', 'RUNTIME_HANDOFF_NOT_READY');
  assert(Number.isInteger(value?.handoffEntryCount) && value.handoffEntryCount >= 0, 'RUNTIME_HANDOFF_ENTRY_COUNT_INVALID');
  assert(SHA64.test(String(value?.handoffDigest ?? '')), 'RUNTIME_HANDOFF_DIGEST_INVALID');
  assert(value?.handoffValidatedByCanonicalModule === true, 'RUNTIME_HANDOFF_CANONICAL_VALIDATION_MISSING');
  assertFourReadyLanes(value?.providerLanes, 'RUNTIME');
  assertZeroAuthority(value, 'RUNTIME');
  assert(value?.disabledSentinelPresent === false, 'RUNTIME_DISABLED_SENTINEL_PRESENT');
  assert(value?.rawCredentialsExposed === false, 'RUNTIME_CREDENTIAL_EXPOSURE');
}

const [mode, file, targetRaw] = process.argv.slice(2);
const targetSha = String(targetRaw ?? '').trim().toLowerCase();
assert(SHA40.test(targetSha), 'TARGET_SHA_INVALID');
const value = readJson(file);
if (mode === '--activation-artifact') verifyActivationEvidence(value, targetSha);
else if (mode === '--runtime-artifact') verifyRuntimeEvidence(value, targetSha);
else throw new Error('usage: --activation-artifact|--runtime-artifact <file> <40-char-sha>');
process.stdout.write(`${JSON.stringify({ ok: true, mode, targetSha })}\n`);
