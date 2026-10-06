import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const SHA = 'a'.repeat(40);
const RUN_ID = 42;
const script = path.resolve('ops/verify-production-telegram-runtime-readiness.mjs');

function fixture() {
  return {
    schemaVersion: 'production-telegram-runtime-readiness-v1',
    status: 'ACTIVE_VERIFIED',
    targetSha: SHA,
    productionDeployRunId: RUN_ID,
    identityMatch: true,
    workerStarted: true,
    personalWorkerStarted: true,
    signalSubscriberStarted: true,
    telegramConfigured: true,
    telegramBotIdentityVerified: true,
    telegramRoomsVerified: true,
    telegramWebhookVerified: true,
    telegramRoomDeliveryVerified: true,
    autoTradingRoomVerified: true,
    memberLinkRequiredForRuntimeActivation: false,
    telegramAccepted: true,
    telegramEditInPlaceAccepted: true,
    orderSubmitted: false,
    orderRequests: 0,
    cancelRequests: 0,
    amendRequests: 0,
    transferRequests: 0,
    withdrawalRequests: 0,
    financialMutationCount: 0,
    privateTradingApiCount: 0,
    liveTradingAuthorityGranted: false,
    autoTradingAuthorityGranted: false,
    secretValuesRecorded: false,
  };
}

function verify(value) {
  const root = mkdtempSync(path.join(tmpdir(), 'telegram-runtime-readiness-'));
  const file = path.join(root, 'receipt.json');
  try {
    writeFileSync(file, JSON.stringify(value), { mode: 0o600 });
    return spawnSync(process.execPath, [script, '--artifact', file, SHA, String(RUN_ID)], { encoding: 'utf8' });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('accepts exact-SHA Telegram runtime and AUTO room proof without a personal member link', () => {
  const result = verify(fixture());
  assert.equal(result.status, 0, result.stderr);
});

test('rejects missing automatic-trading notification room proof', () => {
  const value = fixture();
  value.autoTradingRoomVerified = false;
  assert.notEqual(verify(value).status, 0);
});

test('rejects any financial mutation or authority elevation', () => {
  const value = fixture();
  value.orderRequests = 1;
  assert.notEqual(verify(value).status, 0);
  value.orderRequests = 0;
  value.autoTradingAuthorityGranted = true;
  assert.notEqual(verify(value).status, 0);
});
