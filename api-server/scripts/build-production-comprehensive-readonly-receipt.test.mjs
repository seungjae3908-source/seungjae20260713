import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildProductionComprehensiveReadonlyReceipt } from './build-production-comprehensive-readonly-receipt.mjs';

const SHA = 'a'.repeat(40);

function fixture(overrides = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'comprehensive-receipt-'));
  fs.writeFileSync(path.join(directory, 'prod-desktop-1440-routes.json'), JSON.stringify({
    project: 'prod-desktop-1440',
    complete: true,
    blocked: [],
    audits: [{
      route: '/recommendations',
      loadMs: 240,
      navigationError: null,
      fallbackTimedOut: false,
      busyAfter5s: 0,
      ...overrides,
    }],
  }));
  fs.writeFileSync(path.join(directory, 'production-four-market-signal-scanner.json'), JSON.stringify({
    complete: true,
    executionAuthority: 'NONE',
    actualOrders: 0,
    blockedMutationRequests: 0,
    validZeroSignalAccepted: true,
    lanes: ['KR_STOCK', 'US_STOCK', 'CRYPTO_SPOT', 'CRYPTO_FUTURES'].map((lane) => ({
      lane,
      status: 200,
      outcome: 'VALID_ZERO_SIGNAL',
      dataState: 'complete',
      universeCount: 10,
      timeoutCount: 0,
      orderSubmitted: false,
      exchangeRequestSent: false,
    })),
  }));
  return directory;
}

test('builds zero-authority exact-SHA comprehensive receipt', () => {
  const receipt = buildProductionComprehensiveReadonlyReceipt({
    artifactDir: fixture(),
    targetSha: SHA,
    productionDeployRunId: '123',
    generatedAt: '2026-10-04T00:00:00.000Z',
  });
  assert.equal(receipt.targetSha, SHA);
  assert.equal(receipt.productionDeployRunId, 123);
  assert.equal(receipt.recommendationsDesktop1440.fallbackTimedOut, false);
  assert.deepEqual(receipt.fourMarketSignalScanner.lanes, ['KR_STOCK', 'US_STOCK', 'CRYPTO_SPOT', 'CRYPTO_FUTURES']);
  assert.equal(receipt.orderRequests, 0);
  assert.equal(receipt.realOrderSubmitted, false);
  assert.equal(receipt.liveTradingAuthorityGranted, false);
});

test('rejects a four-market scanner lane with a provider failure', () => {
  const directory = fixture();
  const scannerPath = path.join(directory, 'production-four-market-signal-scanner.json');
  const scanner = JSON.parse(fs.readFileSync(scannerPath, 'utf8'));
  scanner.lanes[2].outcome = 'PROVIDER_FAILURE';
  fs.writeFileSync(scannerPath, JSON.stringify(scanner));
  assert.throws(() => buildProductionComprehensiveReadonlyReceipt({
    artifactDir: directory,
    targetSha: SHA,
    productionDeployRunId: '123',
  }), /COMPREHENSIVE_QA_SIGNAL_SCANNER_LANE_INVALID:CRYPTO_SPOT/);
});

test('rejects a lingering recommendations fallback instead of weakening the budget', () => {
  assert.throws(() => buildProductionComprehensiveReadonlyReceipt({
    artifactDir: fixture({ loadMs: 4_800, fallbackTimedOut: true, busyAfter5s: 1 }),
    targetSha: SHA,
    productionDeployRunId: '123',
  }), /COMPREHENSIVE_QA_ROUTE_NOT_READY/);
});
