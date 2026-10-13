import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const SHA = 'a'.repeat(40);
const DIGEST = 'b'.repeat(64);
const script = path.resolve('ops/verify-production-paper-forward-readiness.mjs');
const markets = ['KR_STOCK', 'US_STOCK', 'CRYPTO_SPOT', 'CRYPTO_FUTURES'];
const lanes = markets.map((market) => ({ market, provider: market, status: 'READY' }));

function activationFixture() {
  return {
    schemaVersion: 'paper-forward-natural-cycle-no-deploy-evidence-v2',
    status: 'passed',
    targetSha: SHA,
    productionAppSha: SHA,
    checks: Object.fromEntries([
      'exactPaperRuntime', 'noAppDeploy', 'naturalCron', 'completed', 'oneMutation',
      'accumulating', 'outcomeModeEnabled', 'simulatedAdaptersEnabled',
      'externalFinancialMutationOff', 'fourReadyProviders', 'scheduleActive',
      'stateCyclePersisted', 'stateArraysValid', 'noPrivate', 'noFinancialMutation',
      'noOrders', 'liveOff', 'oneCronEntry', 'disableSentinelAbsent',
    ].map((key) => [key, true])),
    invocation: { status: 'COMPLETED', completedAtMs: Date.now(), providerLanes: lanes },
    privateRequestCount: 0,
    financialMutationCount: 0,
    orderCount: 0,
    liveTrading: false,
  };
}

function runtimeFixture() {
  return {
    schemaVersion: 'production-paper-forward-runtime-readiness-v1',
    status: 'passed',
    targetSha: SHA,
    productionSha: SHA,
    paperRuntimeSha: SHA,
    scheduleActive: true,
    oneCronEntry: true,
    freshWithinMinutes: 30,
    invocationFresh: true,
    handoffFresh: true,
    handoffStatus: 'READY',
    handoffEntryCount: 4,
    handoffDigest: DIGEST,
    handoffValidatedByCanonicalModule: true,
    providerLanes: lanes,
    privateRequestCount: 0,
    financialMutationCount: 0,
    orderCount: 0,
    liveTrading: false,
    disabledSentinelPresent: false,
    rawCredentialsExposed: false,
  };
}

function verify(mode, fixture) {
  const root = mkdtempSync(path.join(tmpdir(), 'paper-forward-readiness-'));
  const file = path.join(root, 'evidence.json');
  try {
    writeFileSync(file, JSON.stringify(fixture), { mode: 0o600 });
    return spawnSync(process.execPath, [script, mode, file, SHA], { encoding: 'utf8' });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('accepts exact-SHA zero-authority Paper Forward activation evidence', () => {
  const result = verify('--activation-artifact', activationFixture());
  assert.equal(result.status, 0, result.stderr);
});

test('rejects activation evidence with a stale SHA or incomplete market lanes', () => {
  const stale = activationFixture();
  stale.productionAppSha = 'c'.repeat(40);
  assert.notEqual(verify('--activation-artifact', stale).status, 0);

  const incomplete = activationFixture();
  incomplete.invocation.providerLanes = incomplete.invocation.providerLanes.slice(0, 3);
  assert.notEqual(verify('--activation-artifact', incomplete).status, 0);
});

test('accepts fresh canonically validated runtime handoff evidence', () => {
  const result = verify('--runtime-artifact', runtimeFixture());
  assert.equal(result.status, 0, result.stderr);
});

test('rejects stale, noncanonical, or authority-bearing runtime evidence', () => {
  const stale = runtimeFixture();
  stale.invocationFresh = false;
  assert.notEqual(verify('--runtime-artifact', stale).status, 0);

  const noncanonical = runtimeFixture();
  noncanonical.handoffValidatedByCanonicalModule = false;
  assert.notEqual(verify('--runtime-artifact', noncanonical).status, 0);

  const authority = runtimeFixture();
  authority.orderCount = 1;
  assert.notEqual(verify('--runtime-artifact', authority).status, 0);
});
