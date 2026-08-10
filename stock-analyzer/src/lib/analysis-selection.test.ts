import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeAnalysisSelection,
  selectionFromSearch,
  selectionQuery,
} from './analysis-selection';

test('analysis selection keeps the shared search-to-chart contract', () => {
  const selection = normalizeAnalysisSelection({
    assetType: 'stock',
    market: 'KR',
    ticker: '005930',
    displayName: '삼성전자',
    timeframe: '15m',
    searchRunId: 'scan:KR:15m:1',
    signalScore: 87,
    signalRank: 2,
    confidence: 78,
    riskLevel: 'LOW',
    action: 'BUY',
    pricePlan: {
      entryZone: { from: 65080, to: 65120 },
      invalidation: 64790,
      stopLoss: 64780,
      targets: [65650, 66100],
      riskReward: 1.8,
    },
    matchedSignals: ['거래량 증가'],
    reasons: ['거래량이 평균보다 증가'],
    selectedAt: '2026-08-03T00:00:00.000Z',
  });
  assert.ok(selection);
  assert.equal(selection.symbol, '005930');
  assert.equal(selection.signalScore, 87);
  assert.equal(selection.action, 'BUY');
  assert.deepEqual(selection.pricePlan?.entryZone, { from: 65080, to: 65120 });
  assert.equal(selection.pricePlan?.stopLoss, 64780);
  assert.deepEqual(selection.pricePlan?.targets, [65650, 66100]);
  assert.equal(selection.pricePlan?.riskReward, 1.8);
  assert.deepEqual(selection.matchedSignals, ['거래량 증가']);
});

test('analysis selection preserves missing plan values without inventing zero', () => {
  const selection = normalizeAnalysisSelection({
    assetType: 'coin_futures',
    market: 'BITGET',
    ticker: 'BTCUSDT',
    displayName: 'BTCUSDT',
    timeframe: '5m',
    action: 'SHORT',
    pricePlan: { entryZone: null, invalidation: null, stopLoss: null, targets: [], riskReward: null },
    selectedAt: '2026-08-10T00:00:00.000Z',
  });
  assert.ok(selection);
  assert.equal(selection.action, 'SHORT');
  assert.equal(selection.pricePlan?.entryZone, null);
  assert.equal(selection.pricePlan?.stopLoss, null);
  assert.deepEqual(selection.pricePlan?.targets, []);
  assert.equal(selection.pricePlan?.riskReward, null);
});

test('analysis selection URL contains identity fields but not plan or free-form reasons', () => {
  const selection = normalizeAnalysisSelection({
    market: 'US', ticker: 'nvda', displayName: 'NVIDIA', timeframe: '1D',
    searchRunId: 'scan:US:1D:1', action: 'BUY',
    pricePlan: { entryZone: { from: 120, to: 121 }, stopLoss: 115, targets: [130], riskReward: 1.8 },
    reasons: ['private-free-form'],
  });
  assert.ok(selection);
  const query = selectionQuery(selection);
  assert.match(query, /ticker=NVDA/);
  assert.doesNotMatch(query, /private-free-form/);
  assert.doesNotMatch(query, /stopLoss|targets|riskReward/);
  const restored = selectionFromSearch(query);
  assert.equal(restored?.ticker, 'NVDA');
  assert.equal(restored?.searchRunId, 'scan:US:1D:1');
});