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
    matchedSignals: ['거래량 증가'],
    reasons: ['거래량이 평균보다 증가'],
    selectedAt: '2026-08-03T00:00:00.000Z',
  });
  assert.ok(selection);
  assert.equal(selection.symbol, '005930');
  assert.equal(selection.signalScore, 87);
  assert.deepEqual(selection.matchedSignals, ['거래량 증가']);
});

test('analysis selection URL contains identity fields but not free-form reasons', () => {
  const selection = normalizeAnalysisSelection({
    market: 'US', ticker: 'nvda', displayName: 'NVIDIA', timeframe: '1D',
    searchRunId: 'scan:US:1D:1', reasons: ['private-free-form'],
  });
  assert.ok(selection);
  const query = selectionQuery(selection);
  assert.match(query, /ticker=NVDA/);
  assert.doesNotMatch(query, /private-free-form/);
  const restored = selectionFromSearch(query);
  assert.equal(restored?.ticker, 'NVDA');
  assert.equal(restored?.searchRunId, 'scan:US:1D:1');
});
