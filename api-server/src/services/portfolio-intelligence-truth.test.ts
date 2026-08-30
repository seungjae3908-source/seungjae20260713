import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPortfolioIntelligence } from './portfolio-intelligence.service';
import { loadFreePublicFxQuotes } from './public-fx.service';
import { normalizeMoneyToKRW, simulateAdditionalInvestment, buildMonthlyInvestmentPlan } from '../modules/portfolio/intelligence-v2';
import type { QuoteRow } from './market-data.service';
import { MarketDataService } from './market-data.service';
import express from 'express';
import { once } from 'node:events';
import { request } from 'node:http';
import portfolioRouter from '../routes/portfolio-intelligence';
import type { AuthenticatedRequest } from '../middleware/auth';

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

test('portfolio position calculations combine lots once and preserve original holding identities', async () => {
  let quoteCalls = 0;
  let historyCalls = 0;
  const result = await buildPortfolioIntelligence({ accessToken: 'fixture', now, fetchImpl: noFx,
    loadHoldings: async () => [holding, { ...holding, id: 'second-lot', quantity: 3, average_price: 200 }],
    loadQuote: async () => { quoteCalls++; return quote; },
    loadCandles: async () => { historyCalls++; return []; },
  });
  assert.equal(quoteCalls, 1);
  assert.equal(historyCalls, 0, 'one asset cannot correlate with another lot of itself');
  assert.equal(result.holdings.length, 1);
  assert.deepEqual(result.holdings[0].sourceHoldingIds, ['kr-lot', 'second-lot']);
  assert.equal(result.holdings[0].quantity, 5);
  assert.equal(result.holdings[0].averagePrice, 160);
  assert.equal(result.holdings[0].nativeValue, 550);
  assert.equal(result.holdings[0].normalizedCostKRW, 800);
  assert.equal(result.top5Concentration.percent, 100);
  assert.equal(result.dataQuality.requestedHoldingCount, 2);
  assert.equal(result.dataQuality.knownHoldingCount, 2);
  assert.equal(result.dataQuality.aggregatedAssetCount, 1);
});

test('additional-buy HTTP binds explicit market/currency and calculates the entire authenticated asset position', async (t) => {
  const savedUrl = process.env.SUPABASE_URL;
  const savedKey = process.env.SUPABASE_ANON_KEY;
  process.env.SUPABASE_URL = 'http://portfolio-storage.invalid';
  process.env.SUPABASE_ANON_KEY = 'fixture-public';
  t.mock.method(MarketDataService, 'getQuoteRow', async () => ({ ...quote, updatedAt: new Date().toISOString() }));
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (new URL(url).hostname === 'portfolio-storage.invalid') return new Response(JSON.stringify([
      holding, { ...holding, id: 'second-lot', quantity: 3, average_price: 200 },
    ]), { headers: { 'Content-Type': 'application/json' } });
    return new Response('{}', { status: 503 });
  });
  const app = express();
  app.use(express.json());
  app.use((req: AuthenticatedRequest, _res, next) => { req.accessToken = 'fixture-member-token'; next(); });
  app.use(portfolioRouter);
  const server = app.listen(0, '127.0.0.1');
  try {
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('fixture server unavailable');
    const post = (body: unknown) => new Promise<{ status: number; body: Record<string, unknown> }>((resolve, reject) => {
      const req = request({ hostname: '127.0.0.1', port: address.port, path: '/portfolio/intelligence/additional-buy',
        method: 'POST', headers: { 'Content-Type': 'application/json' } }, (response) => {
        let text = '';
        response.setEncoding('utf8'); response.on('data', (chunk: string) => { text += chunk; });
        response.on('end', () => { try { resolve({ status: response.statusCode ?? 0, body: JSON.parse(text) }); } catch (error) { reject(error); } });
      });
      req.on('error', reject); req.end(JSON.stringify(body));
    });
    const input = { ticker: '005930', market: 'KR', currency: 'KRW', additionalQuantity: 1 };
    const good = await post(input);
    assert.equal(good.status, 200);
    const facts = good.body.holding as Record<string, unknown>;
    const simulation = good.body.result as Record<string, unknown>;
    assert.equal(facts.quantity, 5);
    assert.equal(facts.currentAveragePriceNative, 160);
    assert.equal(facts.currentPositionValueKRW, 550);
    assert.equal(simulation.newAveragePrice, 910 / 6);
    assert.equal(simulation.currentWeightPercent, 100);
    assert.equal(simulation.stopLoss, null);
    assert.deepEqual(simulation.targets, []);
    for (const invalid of [{ ...input, market: undefined }, { ...input, market: ['KR'] }, { ...input, currency: 'USD' },
      { ...input, additionalAmountKRW: 'bad' }, { ...input, ticker: ['005930'] }]) assert.equal((await post(invalid)).status, 400);
    assert.equal((await post({ ...input, market: 'US', currency: 'USD' })).status, 404);
  } finally {
    if (savedUrl === undefined) delete process.env.SUPABASE_URL; else process.env.SUPABASE_URL = savedUrl;
    if (savedKey === undefined) delete process.env.SUPABASE_ANON_KEY; else process.env.SUPABASE_ANON_KEY = savedKey;
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test('known native USD values without FX never become zero KRW assets or cost', async () => {
  const result = await buildPortfolioIntelligence({ accessToken: 'fixture', now, fetchImpl: noFx,
    loadHoldings: async () => [{ ...holding, ticker: 'AAPL', market: 'US', currency: 'USD' }],
    loadQuote: async () => ({ ...quote, ticker: 'AAPL', market: 'US', currency: 'USD' }),
  });
  assert.equal(result.nativeBalances.USD.amount, 220);
  assert.equal(result.totalAssets.knownNormalizedKRW, null);
  assert.equal(result.investmentPrincipal.knownNormalizedKRW, null);
  assert.equal(result.allocation.knownTotalKRW, null);
  assert.equal(result.valuationPnl.normalizedKRW, null);
});

test('large finite user inputs cannot become READY simulations with infinite results', () => {
  const result = simulateAdditionalInvestment({ currentQuantity: 5, currentAveragePrice: 160, currentPrice: 110,
    currentPositionValueKRW: 550, portfolioValueKRW: 550, additionalQuantity: Number.MAX_VALUE });
  assert.equal(result.status, 'UNAVAILABLE');
  assert.equal(result.additionalInvestmentKRW, null);
  assert.equal(result.newAveragePrice, null);
  assert.deepEqual(result.missing, ['SIMULATION_NUMERIC_OVERFLOW']);
  assert.equal(buildMonthlyInvestmentPlan({ monthlyAmountKRW: Number.MAX_VALUE, months: 120, allocation: [{ key: 'KR_STOCKS', weight: 1 }] }), null);
});

test('portfolio quote orchestration caps concurrent work and reports timed-out or unstarted assets', async () => {
  let started = 0;
  const rows = Array.from({ length: 8 }, (_, index) => ({ ...holding, id: `lot-${index}`, ticker: String(index + 1).padStart(6, '0') }));
  const before = performance.now();
  const result = await buildPortfolioIntelligence({ accessToken: 'fixture', now, fetchImpl: noFx,
    loadHoldings: async () => rows, loadQuote: () => { started++; return new Promise<null>(() => {}); }, loadCandles: async () => [],
  });
  assert.equal(started, 4);
  assert.equal(result.dataQuality.quoteWork.maxConcurrency, 4);
  assert.equal(result.dataQuality.quoteWork.timedOutAssets, 4);
  assert.equal(result.dataQuality.quoteWork.deadlineReached, true);
  assert.equal(result.missingSources.filter((item) => item.startsWith('QUOTE:')).length, 8);
  assert.equal(result.totalAssets.knownNormalizedKRW, null);
  assert.ok(performance.now() - before < 5_000);
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
