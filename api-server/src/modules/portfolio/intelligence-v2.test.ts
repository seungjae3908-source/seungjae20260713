import test from 'node:test';
import assert from 'node:assert/strict';
import {
  aggregatePortfolioProviderSnapshots,
  boundPortfolioMentorConversation,
  buildMonthlyInvestmentPlan,
  buildPortfolioAssetSummary,
  buildPortfolioMentorV2Context,
  calculateAlignedCorrelation,
  calculateAllocation,
  calculateCashPlan,
  comparePortfolioAllocation,
  normalizeMoneyToKRW,
  simulateAdditionalInvestment,
} from './index.ts';
import { loadFreePublicFxQuotes } from '../../services/public-fx.service.ts';

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

test('free public FX collector preserves source and partial failure', async () => {
  const mockFetch = (async (url: string | URL | Request) => {
    const text = String(url);
    if (text.includes('finance.yahoo.com')) {
      return new Response(JSON.stringify({ chart: { result: [{ meta: { regularMarketPrice: 1402.5, regularMarketTime: 1786596900 } }] } }), { status: 200 });
    }
    return new Response('upstream unavailable', { status: 503 });
  }) as typeof fetch;
  const result = await loadFreePublicFxQuotes(mockFetch);
  assert.equal(result.quotes.length, 1);
  assert.equal(result.quotes[0].currency, 'USD');
  assert.equal(result.quotes[0].krwRate, 1402.5);
  assert.equal(result.quotes[0].source, 'yahoo-public:KRW=X');
  assert.deepEqual(result.missing, ['FX:USDT_KRW:UNAVAILABLE']);
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

test('provider snapshots aggregate KRW USD and USDT with explicit provenance', () => {
  const result = aggregatePortfolioProviderSnapshots([
    { provider: 'cash-ledger', source: 'canonical-cash', asOf: now.toISOString(), quality: 'LIVE', status: 'READY', assets: [{ bucket: 'CASH', amount: 1_000_000, currency: 'KRW' }] },
    { provider: 'us-broker', source: 'readonly-broker-snapshot', asOf: now.toISOString(), quality: 'LIVE', status: 'READY', assets: [{ bucket: 'US_STOCKS', amount: 100, currency: 'USD' }] },
    { provider: 'bitget', source: 'readonly-account-equity', asOf: now.toISOString(), quality: 'DELAYED', status: 'READY', assets: [{ bucket: 'CRYPTO_FUTURES_EQUITY', amount: 1000, currency: 'USDT' }] },
  ], freshFx, { now });
  assert.equal(result.status, 'READY');
  assert.equal(result.assets.totalNormalizedKRWAmount, 2_535_000);
  assert.equal(result.provenance.providerCount, 3);
  assert.equal(result.provenance.includedProviderCount, 3);
  assert.equal(result.provenance.fxQuotes[0].source, 'validated-fx');
});

test('provider failure preserves known subtotal but never presents it as complete total', () => {
  const result = aggregatePortfolioProviderSnapshots([
    { provider: 'cash-ledger', source: 'canonical-cash', asOf: now.toISOString(), quality: 'LIVE', status: 'READY', assets: [{ bucket: 'CASH', amount: 1_000_000, currency: 'KRW' }] },
    { provider: 'us-broker', source: 'readonly-broker-snapshot', asOf: now.toISOString(), quality: 'UNAVAILABLE', status: 'UNAVAILABLE', errorCode: 'PROVIDER_TIMEOUT', assets: [] },
  ], freshFx, { now });
  assert.equal(result.status, 'PARTIAL');
  assert.equal(result.assets.knownNormalizedKRWAmount, 1_000_000);
  assert.equal(result.assets.totalNormalizedKRWAmount, null);
  assert.ok(result.missing.includes('PROVIDER:us-broker:PROVIDER_TIMEOUT'));
});

test('future-dated provider provenance is excluded fail-closed', () => {
  const result = aggregatePortfolioProviderSnapshots([
    { provider: 'future-provider', source: 'readonly-snapshot', asOf: '2026-08-14T00:00:00.000Z', quality: 'LIVE', status: 'READY', assets: [{ bucket: 'CASH', amount: 9_999_999, currency: 'KRW' }] },
  ], freshFx, { now });
  assert.equal(result.status, 'UNAVAILABLE');
  assert.equal(result.assets.knownNormalizedKRWAmount, 0);
  assert.equal(result.assets.totalNormalizedKRWAmount, null);
  assert.ok(result.missing.some((item) => item.includes('INVALID_PROVENANCE')));
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

test('deterministic allocation policy classifies known weights without AI-generated targets', () => {
  const result = comparePortfolioAllocation('BALANCED', { CASH: 8, KR_STOCKS: 30, US_STOCKS: 52, CRYPTO: null });
  assert.equal(result.status, 'PARTIAL');
  assert.equal(result.comparison.find((row) => row.assetClass === 'CASH')?.state, 'UNDERWEIGHT');
  assert.equal(result.comparison.find((row) => row.assetClass === 'KR_STOCKS')?.state, 'BALANCED');
  assert.equal(result.comparison.find((row) => row.assetClass === 'US_STOCKS')?.state, 'OVERWEIGHT');
  assert.equal(result.comparison.find((row) => row.assetClass === 'CRYPTO')?.state, 'UNAVAILABLE');
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
  assert.equal('futureValue' in result, false);
  assert.equal('cagr' in result, false);
});

test('AI Mentor V2 keeps only bounded recent conversation and never grants order authority', () => {
  const portfolio = aggregatePortfolioProviderSnapshots([
    { provider: 'cash-ledger', source: 'canonical-cash', asOf: now.toISOString(), quality: 'LIVE', status: 'READY', assets: [{ bucket: 'CASH', amount: 1_000_000, currency: 'KRW' }] },
  ], freshFx, { now });
  const conversation = Array.from({ length: 12 }, (_, index) => ({ role: index % 2 === 0 ? 'user' as const : 'assistant' as const, content: `message-${index}-${'x'.repeat(50)}` }));
  const bounded = boundPortfolioMentorConversation(conversation, { maxMessages: 4, maxMessageChars: 32, maxTotalChars: 100 });
  assert.ok(bounded.length <= 4);
  assert.ok(bounded.reduce((sum, item) => sum + item.content.length, 0) <= 100);
  assert.ok(bounded.every((item) => item.content.length <= 32));
  const context = buildPortfolioMentorV2Context({ portfolio, conversation, userPrompt: '내 포트폴리오의 데이터 품질을 설명해줘', now });
  assert.equal(context.safety.liveTrading, false);
  assert.equal(context.safety.liveOrderAllowed, false);
  assert.equal(context.safety.privateTradingRequestAllowed, false);
  assert.equal(context.safety.orderAuthority, 'none');
  assert.equal(context.safety.externalAiCalled, false);
  assert.ok(context.limitations.includes('NO_FABRICATED_FUTURE_RETURN'));
});

test('AI Mentor V2 rejects nested private credential material', () => {
  const portfolio = aggregatePortfolioProviderSnapshots([
    { provider: 'cash-ledger', source: 'canonical-cash', asOf: now.toISOString(), quality: 'LIVE', status: 'READY', assets: [{ bucket: 'CASH', amount: 1_000_000, currency: 'KRW' }] },
  ], freshFx, { now });
  assert.throws(() => buildPortfolioMentorV2Context({
    portfolio,
    conversation: [{ role: 'user', content: 'authorization: Bearer abcdefghijklmnop' }],
    now,
  }), /private data/i);
});
