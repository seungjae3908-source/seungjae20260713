import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const SHA = 'a'.repeat(40);
const RUN_ID = 42;
const script = path.resolve('ops/verify-production-telegram-active-readiness.mjs');

function fixture() {
  return {
    schemaVersion: 'production-trading-core-qa-v5',
    targetSha: SHA,
    productionDeployRunId: RUN_ID,
    generatedAt: '2026-10-06T00:00:00.000Z',
    officialProductionOrigin: true,
    authenticatedProductionSession: true,
    providers: { toss: 'PASS', kiwoom: 'PASS', upbit: 'PASS', bitget: 'PASS' },
    paperAutomaticTriggered: true,
    paperFilled: true,
    journalVisible: true,
    executionSyncInserted: 1,
    telegramActivationState: 'ACTIVE_VERIFIED',
    telegramActivationReady: true,
    telegramUserConnectionRequired: false,
    telegramPersonalActivationRequired: false,
    telegramConnectedBefore: true,
    telegramRuntimeReady: true,
    telegramDeliveryQueued: 1,
    telegramTestDelivered: true,
    policyRestored: true,
    memberAutoPolicyReady: true,
    memberAutoPolicyBlockers: [],
    memberAutoDomesticBroker: 'kiwoom',
    memberAutoBitgetLeverage: 7,
    memberAutoPilotStage: 'validated',
    backgroundWorkerSourceReady: true,
    backgroundWorkerReadinessBlockers: [],
    backgroundHandoffState: 'READY',
    backgroundEligibleMembers: 1,
    backgroundPaperAccountsReady: 1,
    memberAutoStrategyAllowlistReady: true,
    realOrderSubmitted: false,
    liveTradingAuthorityGranted: false,
    autoTradingAuthorityGranted: false,
    orderRequests: 0,
    cancelRequests: 0,
    amendRequests: 0,
    transferRequests: 0,
    withdrawalRequests: 0,
    secretValuesRecorded: false,
    accountValuesRecorded: false,
  };
}

function verify(value) {
  const root = mkdtempSync(path.join(tmpdir(), 'telegram-active-readiness-'));
  const file = path.join(root, 'receipt.json');
  try {
    writeFileSync(file, JSON.stringify(value), { mode: 0o600 });
    return spawnSync(process.execPath, [script, '--artifact', file, SHA, String(RUN_ID)], { encoding: 'utf8' });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('accepts exact-SHA member-connected Telegram evidence with zero trading authority', () => {
  const result = verify(fixture());
  assert.equal(result.status, 0, result.stderr);
});

test('rejects globally ready Telegram evidence when the member is not linked', () => {
  const value = fixture();
  Object.assign(value, {
    telegramActivationState: 'READY_FOR_ACTIVATION',
    telegramUserConnectionRequired: true,
    telegramPersonalActivationRequired: true,
    telegramConnectedBefore: false,
    telegramDeliveryQueued: 0,
    telegramTestDelivered: false,
  });
  assert.notEqual(verify(value).status, 0);
});

test('rejects nonzero financial mutation evidence', () => {
  const value = fixture();
  value.orderRequests = 1;
  assert.notEqual(verify(value).status, 0);
});
