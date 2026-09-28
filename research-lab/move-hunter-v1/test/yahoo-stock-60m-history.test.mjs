import test from 'node:test';
import assert from 'node:assert/strict';
import { collectYahooStock60mHistory } from '../src/yahoo-stock-60m-history.mjs';

const HOUR_MS = 60 * 60 * 1000;

function responsePayload(startTime, count = 140) {
  const timestamp = [];
  const open = [];
  const high = [];
  const low = [];
  const close = [];
  const volume = [];
  for (let index = 0; index < count; index += 1) {
    const base = 100 + index * 0.1;
    timestamp.push(Math.floor((startTime + index * HOUR_MS) / 1000));
    open.push(base);
    high.push(base + 1);
    low.push(base - 1);
    close.push(base + 0.2);
    volume.push(1000 + index);
  }
  return {
    chart: {
      error: null,
      result: [{
        timestamp,
        indicators: { quote: [{ open, high, low, close, volume }] },
      }],
    },
  };
}

test('Yahoo 60m adapter preserves exact 60m identity and stays research-only', async () => {
  const startTime = Date.parse('2026-01-01T00:00:00Z');
  const endTime = startTime + 200 * HOUR_MS;
  const history = await collectYahooStock60mHistory({
    market: 'US_STOCK',
    symbol: 'AAPL',
    startTime,
    endTime,
    fetchImpl: async (url) => {
      assert.match(String(url), /interval=60m/);
      return {
        ok: true,
        status: 200,
        json: async () => responsePayload(startTime),
      };
    },
  });
  assert.equal(history.timeframe, '60m');
  assert.equal(history.candleCount, 140);
  assert.equal(history.historicalReplayOnly, true);
  assert.equal(history.canonicalProviderAuthority, false);
  assert.equal(history.economicSampleCredit, 0);
  assert.equal(history.executionAuthority, 'NONE');
});

test('Yahoo 60m adapter rejects oversized historical windows', async () => {
  const endTime = Date.parse('2026-09-27T00:00:00Z');
  const startTime = endTime - 730 * 24 * HOUR_MS;
  await assert.rejects(
    collectYahooStock60mHistory({
      market: 'US_STOCK',
      symbol: 'AAPL',
      startTime,
      endTime,
      fetchImpl: async () => { throw new Error('must not fetch'); },
    }),
    /729_DAYS/,
  );
});
