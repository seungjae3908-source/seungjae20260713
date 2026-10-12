import test from 'node:test';
import assert from 'node:assert/strict';
import { getHistoricalCandles, yahooHistoricalChartParams } from './yahoo';

const before = Date.parse('2026-09-10T12:00:00.000Z');

test('Yahoo history uses a real exclusive prior-to cursor for stock 1D and intraday 3m/4H', () => {
  for (const [tf, interval, days] of [
    ['1D', '1d', 500], ['5m', '5m', 28], ['3m', '1m', 6],
    ['4H', '60m', 365], ['60m', '60m', 180],
  ] as const) {
    const params = yahooHistoricalChartParams(tf, before);
    assert.equal(params.period2, before / 1000);
    assert.equal(params.period1, before / 1000 - days * 86_400);
    assert.equal(params.interval, interval);
  }
  assert.throws(() => yahooHistoricalChartParams('1D', Number.NaN), /CURSOR_INVALID/);
  assert.throws(() => yahooHistoricalChartParams('INVALID', before), /UNSUPPORTED_TIMEFRAME/);
});

test('Yahoo older history actually sends period1/period2 to public hosts and excludes cursor overlap', async () => {
  const originalFetch = globalThis.fetch;
  const queries: URL[] = [];
  const times = [-2, -1, 0, 1].map((day) => before / 1000 + day * 86_400);
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    queries.push(url);
    return new Response(JSON.stringify({
      chart: { result: [{
        timestamp: times,
        indicators: { quote: [{
          open: [100, 101, 102, 103], high: [105, 106, 107, 108],
          low: [95, 96, 97, 98], close: [102, 103, 104, 105],
          volume: [1, 2, 3, 4],
        }] },
      }] },
    }), { status: 200 });
  };
  try {
    const rows = await getHistoricalCandles('AAPL', '1D', before);
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map((row) => Date.parse(String(row.time))),
      [before - 2 * 86_400_000, before - 86_400_000]);
    assert.ok(queries.length >= 1);
    for (const url of queries) {
      assert.ok(url.pathname.endsWith('/AAPL'));
      assert.equal(url.searchParams.get('interval'), '1d');
      assert.equal(url.searchParams.get('period2'), String(before / 1000));
      assert.equal(url.searchParams.get('period1'), String(before / 1000 - 500 * 86_400));
      assert.equal(url.searchParams.has('range'), false);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Yahoo derived 3m history uses only three actually observed contiguous source minutes', async () => {
  const originalFetch = globalThis.fetch;
  const times = [-180, -120, -60].map((seconds) => before / 1000 + seconds);
  globalThis.fetch = async () => new Response(JSON.stringify({
    chart: { result: [{
      timestamp: times,
      indicators: { quote: [{
        open: [100, 101, 102], high: [101, 103, 104],
        low: [99, 100, 101], close: [101, 102, 103], volume: [5, 6, 7],
      }] },
    }] },
  }), { status: 200 });
  try {
    const rows = await getHistoricalCandles('AAPL', '3m', before);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].time, new Date(before - 180_000).toISOString());
    assert.equal(rows[0].open, 100);
    assert.equal(rows[0].high, 104);
    assert.equal(rows[0].low, 99);
    assert.equal(rows[0].close, 103);
    assert.equal(rows[0].volume, 18);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
