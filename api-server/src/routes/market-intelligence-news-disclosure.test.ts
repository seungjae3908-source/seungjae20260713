import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import test from 'node:test';
import express from 'express';
import {
  clearChartMarketIntelligenceCacheForTests,
  createMarketIntelligenceNewsDisclosureRouter,
} from './market-intelligence-news-disclosure';
import type { StockNewsDisclosureIntelligenceResult } from '../services/news-disclosure-market-intelligence.service';

function fixture(ticker = '005930'): StockNewsDisclosureIntelligenceResult {
  return {
    contract: 'StockNewsDisclosureIntelligenceV1',
    status: 'READY',
    ticker,
    market: 'KR',
    collectedAt: '2026-08-27T02:00:00.000Z',
    events: [],
    sourceStatus: { news: 'READY', filings: 'READY' },
    budget: {
      maxEvents: 5,
      maxAiEvents: 1,
      routedEvents: 0,
      aiEligibleEvents: 0,
      aiAttemptedEvents: 0,
      aiDeferredEvents: 0,
    },
    warnings: [],
    safety: {
      publicEvidenceOnly: true,
      generatedFactsAllowed: false,
      executionAuthority: 'NONE',
      orderAllowed: false,
    },
  };
}

async function withServer(
  router: ReturnType<typeof createMarketIntelligenceNewsDisclosureRouter>,
  run: (baseUrl: string) => Promise<void>,
) {
  const app = express();
  app.use(router);
  const server = http.createServer(app);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

test('AI Chart route requests CHART scope with one-AI-event budget and zero authority', async () => {
  clearChartMarketIntelligenceCacheForTests();
  const calls: unknown[] = [];
  const router = createMarketIntelligenceNewsDisclosureRouter({
    now: () => Date.parse('2026-08-27T02:00:00.000Z'),
    collect: async (input) => {
      calls.push(input);
      return fixture(input.ticker);
    },
  });
  await withServer(router, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/market-intelligence/news-disclosure?market=KR&ticker=005930`);
    assert.equal(response.status, 200);
    const payload = await response.json() as any;
    assert.equal(payload.ok, true);
    assert.equal(payload.chartPolicy.evidenceOnly, true);
    assert.equal(payload.chartPolicy.scoreImpact, 0);
    assert.equal(payload.chartPolicy.probabilityImpact, 0);
    assert.equal(payload.chartPolicy.executionAuthority, 'NONE');
    assert.equal(payload.chartPolicy.orderAllowed, false);
    assert.equal(payload.chartPolicy.maxAiEvents, 1);
    assert.equal(payload.result.safety.orderAllowed, false);
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], {
    ticker: '005930',
    market: 'KR',
    analysisScope: 'CHART',
    maxEvents: 5,
    maxAiEvents: 1,
  });
});

test('AI Chart route reuses one-minute public evidence cache', async () => {
  clearChartMarketIntelligenceCacheForTests();
  let calls = 0;
  const router = createMarketIntelligenceNewsDisclosureRouter({
    now: () => Date.parse('2026-08-27T02:00:00.000Z'),
    collect: async () => {
      calls += 1;
      return fixture();
    },
  });
  await withServer(router, async (baseUrl) => {
    const url = `${baseUrl}/market-intelligence/news-disclosure?market=KR&ticker=005930`;
    const first = await (await fetch(url)).json() as any;
    const second = await (await fetch(url)).json() as any;
    assert.equal(first.cache, 'MISS');
    assert.equal(second.cache, 'HIT');
  });
  assert.equal(calls, 1);
});

test('unsafe collector response fails closed instead of exposing chart evidence', async () => {
  clearChartMarketIntelligenceCacheForTests();
  const router = createMarketIntelligenceNewsDisclosureRouter({
    collect: async () => ({
      ...fixture(),
      safety: {
        publicEvidenceOnly: true,
        generatedFactsAllowed: false,
        executionAuthority: 'NONE',
        orderAllowed: true,
      },
    } as unknown as StockNewsDisclosureIntelligenceResult),
  });
  await withServer(router, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/market-intelligence/news-disclosure?market=KR&ticker=005930`);
    assert.equal(response.status, 502);
    const payload = await response.json() as any;
    assert.equal(payload.ok, false);
    assert.equal(payload.available, false);
    assert.equal(payload.result, null);
    assert.equal(payload.chartPolicy.orderAllowed, false);
    assert.equal(payload.chartPolicy.executionAuthority, 'NONE');
  });
});

test('invalid market never invokes the collector', async () => {
  clearChartMarketIntelligenceCacheForTests();
  let calls = 0;
  const router = createMarketIntelligenceNewsDisclosureRouter({
    collect: async () => {
      calls += 1;
      return fixture();
    },
  });
  await withServer(router, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/market-intelligence/news-disclosure?market=BITGET&ticker=BTCUSDT`);
    assert.equal(response.status, 400);
    assert.equal((await response.json() as any).error, 'MARKET_REQUIRED');
  });
  assert.equal(calls, 0);
});
