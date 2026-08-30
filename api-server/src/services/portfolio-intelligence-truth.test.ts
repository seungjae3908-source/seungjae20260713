import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPortfolioIntelligence } from './portfolio-intelligence.service';
import { loadFreePublicFxQuotes } from './public-fx.service';
import { normalizeMoneyToKRW } from '../modules/portfolio/intelligence-v2';
import type { QuoteRow } from './market-data.service';

const now = new Date('2026-08-30T10:30:00Z');
const holding = { id: 'kr-lot', ticker: '005930', name: 'fixture', market: 'KR', currency: 'KRW', quantity: 2, average_price: 100 };
const quote: QuoteRow = { ticker: '005930', name: 'fixture', market: 'KR', currency: 'KRW', assetType: 'STOCK',
  price: 110, changeAmount: 0, changePercent: 0, volume: 0, tradingValue: 0, rating: null,
  source: 'fixture-only', updatedAt: '2026-08-30T10:29:00Z' };
const noFx: typeof fetch = async () => new Response('{}', { status: 503 });

test('portfolio intelligence rejects malformed holdings and never creates zero from missing facts', async () => {
  const base = { accessToken: 'isolated-fixture', now, fetchImpl: noFx };
  await assert.rejects(buildPortfolioIntelligence({ ...base, loadHoldings: async () => ({}) }), /INVALID_SHAPE/);
  for (const rows of [[{ ...holding, quantity: undefined }], [{ ...holding, quantity: true }], [{ ...holding, currency: undefined }],
    [{ ...holding, currency: 'USD' }], [{ ...holding, id: null }], [holding, holding]]) {
    let quoteCalls = 0;
    const result = await buildPortfolioIntelligence({ ...base, loadHoldings: async () => rows, loadQuote: async () => { quoteCalls++; return quote; } });
    assert.equal(quoteCalls, 0);
    assert.equal(result.totalAssets.knownNormalizedKRW, null);
    assert.equal(result.valuationPnl.normalizedKRW, null);
    assert.ok(result.dataQuality.invalidHoldingRows > 0);
    assert.equal(result.assets.krStocks, null);
    assert.equal(result.nativeBalances.KRW.amount, null);
  }
});

test('portfolio intelligence binds quote identity and source time instead of relabeling polling time LIVE', async () => {
  const base = { accessToken: 'isolated-fixture', now, fetchImpl: noFx, loadHoldings: async () => [holding] };
  for (const value of [null, { ...quote, currency: 'USD' }, { ...quote, ticker: 'AAPL' }, { ...quote, updatedAt: null },
    { ...quote, source: undefined }, { ...quote, updatedAt: '2020-01-01T00:00:00Z' }, { ...quote, updatedAt: '2099-01-01T00:00:00Z' }]) {
    const result = await buildPortfolioIntelligence({ ...base, loadQuote: async () => value });
    assert.deepEqual(result.holdings, []);
    assert.equal(result.assets.krStocks, null);
    assert.equal(result.totalAssets.knownNormalizedKRW, null);
    assert.equal(result.valuationPnl.returnPercent, null);
    assert.equal(result.nativeBalances.KRW.amount, null);
  }
  const result = await buildPortfolioIntelligence({ ...base, loadQuote: async () => quote });
  assert.equal(result.holdings[0].asOf, '2026-08-30T10:29:00.000Z');
  assert.equal(result.holdings[0].source, 'fixture-only');
  assert.equal(result.holdings[0].nativeValue, 220);
  assert.equal(result.valuationPnl.normalizedKRW, 20);
  assert.equal(result.valuationPnl.returnPercent, 10);
  assert.equal(result.safety.realOrderCount, 0);
});

test('FX collectors require exact currency pair, numeric values and explicit source time', async () => {
  const validYahoo = { chart: { result: [{ meta: { symbol: 'KRW=X', currency: 'KRW', regularMarketPrice: 1400, regularMarketTime: now.getTime() / 1000 - 60 } }] } };
  const validUpbit = [{ market: 'KRW-USDT', trade_price: 1390, timestamp: now.getTime() - 60_000 }];
  const collect = (yahoo: unknown, upbit: unknown) => loadFreePublicFxQuotes(async (url) => new Response(JSON.stringify(String(url).includes('yahoo') ? yahoo : upbit)), now);
  const good = await collect(validYahoo, validUpbit);
  assert.deepEqual(good.missing, []);
  assert.equal(good.quotes.every((row) => row.quality === 'DELAYED'), true);
  for (const upbit of [[{ ...validUpbit[0], market: 'KRW-BTC' }], [{ ...validUpbit[0], trade_price: true }],
    [{ ...validUpbit[0], timestamp: now.getTime() / 1000 }], [{ ...validUpbit[0], timestamp: now.getTime() + 1 }], []]) {
    const result = await collect(validYahoo, upbit);
    assert.deepEqual(result.quotes.map((row) => row.currency), ['USD']);
    assert.deepEqual(result.missing, ['FX:USDT_KRW:UNAVAILABLE']);
  }
  const invalidYahoo = { chart: { result: [{ meta: { ...validYahoo.chart.result[0].meta, symbol: 'JPY=X' } }] } };
  assert.deepEqual((await collect(invalidYahoo, validUpbit)).quotes.map((row) => row.currency), ['USDT']);
});

test('money normalization rejects future or malformed source time, stale money, ambiguous FX and overflow', () => {
  const native = { amount: 100, currency: 'KRW' as const, source: 'fixture', asOf: now.toISOString(), quality: 'DELAYED' as const };
  for (const money of [{ ...native, asOf: '2099-01-01T00:00:00Z' }, { ...native, asOf: '2026-02-30T00:00:00Z' },
    { ...native, quality: 'STALE' as const }, { ...native, source: '' }]) {
    assert.equal(normalizeMoneyToKRW(money, [], { now }).normalizedKRWAmount, null);
  }
  const fx = { currency: 'USD' as const, krwRate: 1400, source: 'fixture', asOf: now.toISOString(), quality: 'DELAYED' as const };
  assert.equal(normalizeMoneyToKRW({ ...native, currency: 'USD' }, [fx, fx], { now }).normalizedKRWAmount, null);
  assert.equal(normalizeMoneyToKRW({ ...native, currency: 'USD', amount: Number.MAX_VALUE }, [fx], { now }).normalizedKRWAmount, null);
});
