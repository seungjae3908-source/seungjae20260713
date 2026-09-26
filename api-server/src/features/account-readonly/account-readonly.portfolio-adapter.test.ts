import assert from 'node:assert/strict';
import test from 'node:test';
import { emptySnapshot, type CanonicalAccountSnapshot } from './account-readonly.contract';
import { accountSourcesToPortfolioEvidence } from './account-readonly.portfolio-adapter';

const NOW = '2026-09-25T01:00:00.000Z';

function connected(provider: CanonicalAccountSnapshot['provider'], overrides: Partial<CanonicalAccountSnapshot> = {}): CanonicalAccountSnapshot {
  return {
    ...emptySnapshot(provider, 'CONNECTED', NOW),
    connected: true,
    accounts: [],
    balances: [],
    positions: [],
    openOrders: [],
    lastGoodAt: NOW,
    ...overrides,
  };
}

test('unconfigured providers do not fabricate assets or missing-value failures', () => {
  const result = accountSourcesToPortfolioEvidence([
    { provider: 'toss', configured: false, snapshot: null, errorCode: null },
    { provider: 'upbit', configured: false, snapshot: null, errorCode: null },
  ]);
  assert.deepEqual(result.providerSnapshots, []);
  assert.deepEqual(result.linkedPositions, []);
  assert.deepEqual(result.missing, []);
  assert.deepEqual(result.coverage, { cash: false, cryptoSpot: false, cryptoFuturesEquity: false });
});

test('Kiwoom cash is included but stock positions stay separate to prevent manual-portfolio double counting', () => {
  const snapshot = connected('kiwoom', {
    balances: [
      { currency: 'KRW', available: 900_000, locked: null, total: 1_000_000, estimatedKrwValue: 1_000_000 },
      { currency: 'USD', available: 50, locked: null, total: 75, estimatedKrwValue: null },
    ],
    positions: [{
      market: 'KR', symbol: '005930', quantity: 3, availableQuantity: 3,
      averageEntryPrice: 70_000, currentPrice: 71_000, marketValue: 213_000,
      unrealizedPnl: 3_000, unrealizedPnlPercent: 1.4285,
      leverage: null, liquidationPrice: null, marginMode: null, side: null,
    }],
  });
  const result = accountSourcesToPortfolioEvidence([
    { provider: 'kiwoom', configured: true, snapshot, errorCode: null },
  ]);
  assert.equal(result.coverage.cash, true);
  assert.equal(result.providerSnapshots.length, 1);
  assert.equal(result.providerSnapshots[0]?.status, 'PARTIAL');
  assert.deepEqual(result.providerSnapshots[0]?.assets.map((row) => [row.bucket, row.amount, row.currency]), [
    ['CASH', 1_000_000, 'KRW'],
    ['CASH', 75, 'USD'],
  ]);
  assert.equal(result.linkedPositions[0]?.symbol, '005930');
  assert.ok(result.missing.includes('ACCOUNT:kiwoom:STOCK_POSITIONS_EXCLUDED_FROM_TOTAL_TO_AVOID_DOUBLE_COUNT'));
  assert.equal(result.providerSnapshots[0]?.assets.some((row) => row.bucket === 'KR_STOCKS'), false);
});

test('Upbit proves KRW cash while unknown crypto valuation stays partial instead of becoming zero', () => {
  const snapshot = connected('upbit', {
    balances: [
      { currency: 'KRW', available: 10_000, locked: 0, total: 10_000, estimatedKrwValue: 10_000 },
      { currency: 'BTC', available: 0.01, locked: 0, total: 0.01, estimatedKrwValue: null },
    ],
    positions: [{
      market: 'UPBIT', symbol: 'BTC', quantity: 0.01, availableQuantity: 0.01,
      averageEntryPrice: 90_000_000, currentPrice: null, marketValue: null,
      unrealizedPnl: null, unrealizedPnlPercent: null, leverage: null,
      liquidationPrice: null, marginMode: null, side: null,
    }],
  });
  const result = accountSourcesToPortfolioEvidence([
    { provider: 'upbit', configured: true, snapshot, errorCode: null },
  ]);
  assert.equal(result.coverage.cash, true);
  assert.equal(result.coverage.cryptoSpot, true);
  assert.equal(result.providerSnapshots[0]?.status, 'PARTIAL');
  assert.deepEqual(result.providerSnapshots[0]?.assets.map((row) => [row.bucket, row.amount, row.currency]), [
    ['CASH', 10_000, 'KRW'],
  ]);
  assert.ok(result.missing.includes('ACCOUNT:upbit:BTC:VALUATION_UNAVAILABLE'));
  assert.equal(result.linkedPositions[0]?.symbol, 'BTC');
});

test('Bitget account equity becomes futures-equity evidence without using position notional', () => {
  const snapshot = connected('bitget', {
    balances: [{ currency: 'USDT', available: 80, locked: 20, total: 100, estimatedKrwValue: null }],
    positions: [{
      market: 'BITGET', symbol: 'BTCUSDT', quantity: 0.01, availableQuantity: 0.01,
      averageEntryPrice: 60_000, currentPrice: 61_000, marketValue: null,
      unrealizedPnl: 10, unrealizedPnlPercent: null, leverage: 2,
      liquidationPrice: 30_000, marginMode: 'isolated', side: 'long',
    }],
  });
  const result = accountSourcesToPortfolioEvidence([
    { provider: 'bitget', configured: true, snapshot, errorCode: null },
  ]);
  assert.equal(result.coverage.cryptoFuturesEquity, true);
  assert.deepEqual(result.providerSnapshots[0]?.assets.map((row) => [row.bucket, row.amount, row.currency]), [
    ['CRYPTO_FUTURES_EQUITY', 100, 'USDT'],
  ]);
  assert.equal(result.linkedPositions[0]?.marketValue, null);
  assert.equal(result.linkedPositions[0]?.unrealizedPnl, 10);
});

test('configured provider failure remains unavailable evidence and never becomes a zero balance', () => {
  const snapshot = emptySnapshot('upbit', 'AUTH_FAILED', NOW, 'UPBIT_AUTH_FAILED');
  const result = accountSourcesToPortfolioEvidence([
    { provider: 'upbit', configured: true, snapshot, errorCode: 'UPBIT_AUTH_FAILED' },
  ]);
  assert.equal(result.providerSnapshots[0]?.status, 'UNAVAILABLE');
  assert.equal(result.providerSnapshots[0]?.assets.length, 0);
  assert.equal(result.coverage.cryptoSpot, false);
  assert.equal(result.coverage.cash, false);
});
