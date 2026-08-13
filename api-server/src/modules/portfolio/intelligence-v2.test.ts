import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildMonthlyInvestmentPlan,
  buildPortfolioAssetSummary,
  calculateAlignedCorrelation,
  calculateAllocation,
  calculateCashPlan,
  normalizeMoneyToKRW,
  simulateAdditionalInvestment,
} from './intelligence-v2.ts';

const now = new Date('2026-08-13T06:00:00.000Z');
const freshFx = [
  { currency: 'USD' as const, krwRate: 1400, source: 'validated-fx', asOf: '2026-08-13T05:55:00.000Z', quality: 'LIVE' as const },
  { currency: 'USDT' as const, krwRate: 1395, source: 'validated-fx', asOf: '2026-08-13T05:55:00.000Z', quality: 'DELAYED' as const },
];

test('currency normalization keeps native amount and validated FX provenance', () => {
  const result = normalizeMoneyToKRW({ amount: 100, currency: 'USD', source: 'broker', asOf: '2026-08-13T05:59:00.000Z', quality: 'LIVE' }, freshFx, { now });
  assert.equal(result.normalizedKRWAmount, 140_000);
  assert.equal(result.fxRate, 1400);
  assert.equal(result.fxSource, 'validated-fx');
  assert.equal(result.status, 'READY');
});

test('stale or missing FX fails closed instead of inventing KRW value', () => {
  const result = normalizeMoneyToKRW({ amount: 100, currency: 'USD', source: 'broker', asOf: '2026-08-13T05:59:00.000Z', quality: 'LIVE' }, [
    { currency: 'USD', krwRate: 1400, source: 'stale-fx', asOf: '2026-08-12T00:00:00.000Z', quality: 'STALE' },
  ], { now });
  assert.equal(result.normalizedKRWAmount, null);
  assert.equal(result.status, 'FX_UNAVAILABLE');
});

test('portfolio total is partial when one currency cannot be normalized', () => {
  const result = buildPortfolioAssetSummary([
    { bucket: 'CASH', amount: 1_000_000, currency: 'KRW', source: 'cash', asOf: now.toISOString(), quality: 'LIVE' },
    { bucket: 'US_STOCKS', amount: 100, currency: 'USD', source: 'broker', asOf: now.toISOString(), quality: 'LIVE' },
  ], [], { now });
  assert.equal(result.status, 'PARTIAL');
  assert.equal(result.knownNormalizedKRWAmount, 1_000_000);
  assert.equal(result.totalNormalizedKRWAmount, null);
  assert.deepEqual(result.missing, ['US_STOCKS:USD:FX_UNAVAILABLE']);
});

test('portfolio futures component uses supplied account equity without notional synthesis', () => {
  const result = buildPortfolioAssetSummary([
    { bucket: 'CRYPTO_FUTURES_EQUITY', amount: 1000, currency: 'USDT', source: 'bitget-account-equity', asOf: now.toISOString(), quality: 'LIVE' },
  ], freshFx, { now });
  assert.equal(result.totalNormalizedKRWAmount, 1_395_000);
  assert.equal(result.components[0].source, 'bitget-account-equity');
});

test('cash buffer clamps investable cash to zero', () => {
  const result = calculateCashPlan({ totalCashKRW: 1_000_000, availableCashKRW: 100_000, minimumCashBufferRatio: 0.2 });
  assert.equal(result.minimumCashBufferKRW, 200_000);
  assert.equal(result.investableCashKRW, 0);
});

test('allocation reports top five concentration and preserves partial status', () => {
  const result = calculateAllocation([
    { key: 'A', normalizedKRWAmount: 500 },
    { key: 'B', normalizedKRWAmount: 300 },
    { key: 'UNKNOWN', normalizedKRWAmount: null },
    { key: 'C', normalizedKRWAmount: 200 },
  ]);
  assert.equal(result.status, 'PARTIAL');
  assert.equal(result.knownTotalKRW, 1000);
  assert.equal(result.top5ConcentrationPercent, 100);
  assert.equal(result.weights.find((row) => row.key === 'UNKNOWN')?.weightPercent, null);
});

test('correlation requires aligned return samples and fails closed when history does not align', () => {
  const left = Array.from({ length: 30 }, (_, index) => ({ timestamp: `L-${index}`, value: index / 100 }));
  const right = Array.from({ length: 30 }, (_, index) => ({ timestamp: `R-${index}`, value: index / 100 }));
  const result = calculateAlignedCorrelation(left, right, 30);
  assert.equal(result.status, 'PARTIAL_MARKET_DATA');
  assert.equal(result.correlation, null);
});

test('aligned correlation computes only from matching timestamp returns', () => {
  const left = Array.from({ length: 30 }, (_, index) => ({ timestamp: String(index), value: index }));
  const right = Array.from({ length: 30 }, (_, index) => ({ timestamp: String(index), value: index * 2 }));
  const result = calculateAlignedCorrelation(left, right, 30);
  assert.equal(result.status, 'READY');
  assert.ok(result.correlation != null && Math.abs(result.correlation - 1) < 1e-12);
});

test('additional investment exposes stop and target calculations only when evidence prices exist', () => {
  const withoutEvidence = simulateAdditionalInvestment({ currentQuantity: 10, currentAveragePrice: 100, currentPrice: 120, currentPositionValueKRW: 1200, portfolioValueKRW: 5000, additionalAmountKRW: 600 });
  assert.equal(withoutEvidence.status, 'READY');
  assert.equal(withoutEvidence.estimatedMaxLossKRW, null);
  assert.ok(withoutEvidence.missing.includes('STOP_UNAVAILABLE'));
  const withEvidence = simulateAdditionalInvestment({ currentQuantity: 10, currentAveragePrice: 100, currentPrice: 120, currentPositionValueKRW: 1200, portfolioValueKRW: 5000, additionalAmountKRW: 600, stopLoss: 90, targets: [140, 160] });
  assert.ok(withEvidence.estimatedMaxLossKRW != null && withEvidence.estimatedMaxLossKRW > 0);
  assert.equal(withEvidence.targetProfitsKRW.length, 2);
});

test('monthly plan contains contributions only and does not fabricate future returns', () => {
  const result = buildMonthlyInvestmentPlan({ monthlyAmountKRW: 1_000_000, months: 12, allocation: [{ key: 'STOCKS', weight: 0.7 }, { key: 'CASH', weight: 0.3 }] });
  assert.ok(result);
  assert.equal(result.cumulativeInvestmentKRW, 12_000_000);
  assert.deepEqual(result.allocations, [
    { key: 'STOCKS', weight: 0.7, cumulativeContributionKRW: 8_400_000 },
    { key: 'CASH', weight: 0.3, cumulativeContributionKRW: 3_600_000 },
  ]);
});