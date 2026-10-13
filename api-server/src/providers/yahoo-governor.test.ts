import assert from 'node:assert/strict';
import test from 'node:test';

import {
  getGovernedYahooJson,
  getQuote,
  resetYahooProviderRuntimeForTests,
  yahooProviderDiagnostics,
} from './yahoo';

const originalFetch = globalThis.fetch;

function chart(price = 250) {
  const timestamp = Math.floor((Date.now() - 1_000) / 1_000);
  return {
    chart: {
      result: [{
        meta: { regularMarketPrice: price, regularMarketTime: timestamp, previousClose: price - 1 },
        timestamp: [timestamp],
        indicators: { quote: [{
          open: [price - 1], high: [price + 1], low: [price - 2], close: [price], volume: [100],
        }] },
      }],
    },
  };
}

function ok(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

test.beforeEach(() => {
  resetYahooProviderRuntimeForTests({
    minimumStartIntervalMs: 0,
    rateLimitCooldownMs: 60_000,
    transportFallbackDelayMs: 0,
  });
});

test.afterEach(() => {
  globalThis.fetch = originalFetch;
  resetYahooProviderRuntimeForTests();
});

test('deduplicates concurrent Yahoo chart requests and reuses the fresh cache', async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    await Promise.resolve();
    return ok(chart());
  };

  const [first, second] = await Promise.all([getQuote('AAPL'), getQuote('AAPL')]);
  const cached = await getQuote('AAPL');

  assert.equal(first.price, 250);
  assert.equal(second.price, 250);
  assert.equal(cached.price, 250);
  assert.equal(calls, 1);
  assert.equal(yahooProviderDiagnostics().deduplicatedRequests, 1);
  assert.equal(yahooProviderDiagnostics().cacheHits, 1);
});

test('a Yahoo 429 opens one global cooldown across chart and screener consumers without query2 bypass', async () => {
  const urls: string[] = [];
  globalThis.fetch = async (input) => {
    urls.push(String(input));
    return new Response('Edge: Too Many Requests', { status: 429 });
  };

  await assert.rejects(getQuote('AAPL'), /YAHOO_CHART_HTTP_429/u);
  await assert.rejects(
    getGovernedYahooJson('/v1/finance/screener/predefined/saved?scrIds=day_gainers'),
    /YAHOO_CHART_HTTP_429/u,
  );

  assert.equal(urls.length, 1);
  assert.match(urls[0], /^https:\/\/query1\.finance\.yahoo\.com\//u);
  const diagnostics = yahooProviderDiagnostics();
  assert.equal(diagnostics.rateLimitResponses, 1);
  assert.equal(diagnostics.causeAssessment.providerLimitConfirmed, true);
  assert.equal(diagnostics.causeAssessment.sharedEgressIpSuspected, true);
  assert.ok(diagnostics.rateLimitCooldownUntil);
});

test('uses the second Yahoo host only after a bounded transport/server failure', async () => {
  const urls: string[] = [];
  globalThis.fetch = async (input) => {
    urls.push(String(input));
    return urls.length === 1
      ? new Response('temporary', { status: 503 })
      : ok(chart(300));
  };

  const quote = await getQuote('NVDA');
  assert.equal(quote.price, 300);
  assert.equal(urls.length, 2);
  assert.match(urls[0], /^https:\/\/query1\.finance\.yahoo\.com\//u);
  assert.match(urls[1], /^https:\/\/query2\.finance\.yahoo\.com\//u);
  assert.equal(yahooProviderDiagnostics().transportFallbacks, 1);
});
