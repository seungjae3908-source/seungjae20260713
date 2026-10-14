import assert from 'node:assert/strict';
import test from 'node:test';
import { UpbitExternalPilotPublicDataClient } from './upbit-external-pilot-public-data.service';

const NOW = Date.parse('2026-10-13T23:37:00.000Z');

function candles(minutes: number) {
  const duration = minutes * 60_000;
  return Array.from({ length: 90 }, (_, index) => {
    const start = NOW - duration * (index + 1);
    return {
      candle_date_time_utc: new Date(start).toISOString().replace('.000Z', ''),
      opening_price: 10_000 + index,
      high_price: 10_010 + index,
      low_price: 9_990 + index,
      trade_price: 10_005 + index,
      candle_acc_trade_volume: 10 + index / 10,
      candle_acc_trade_price: 100_000 + index,
    };
  });
}

function response(value: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json', ...headers } });
}

test('public client retains only confirmed candles and actual orderbook sizes', async () => {
  const calls: string[] = [];
  const client = new UpbitExternalPilotPublicDataClient(async (input) => {
    const url = String(input);
    calls.push(url);
    if (url.includes('/orderbook')) return response([{
      timestamp: NOW - 500,
      total_bid_size: 12,
      total_ask_size: 10,
      orderbook_units: [
        { bid_price: 10_000, ask_price: 10_010, bid_size: 2, ask_size: 3 },
        { bid_price: 9_990, ask_price: 10_020, bid_size: 4, ask_size: 5 },
      ],
    }]);
    const minutes = Number(url.match(/minutes\/(\d+)/u)?.[1]);
    return response(candles(minutes));
  }, async () => {}, () => NOW, 0);

  const snapshot = await client.snapshot('KRW-BTC');
  assert.equal(calls.length, 4);
  assert.equal(snapshot.symbol, 'KRW-BTC');
  assert.equal(snapshot.candles5m.length, 90);
  assert.ok(snapshot.candles5m.every((row) => row.time + 5 * 60_000 <= NOW));
  assert.deepEqual(snapshot.orderbook.askLevels, [
    { price: 10_010, size: 3 },
    { price: 10_020, size: 5 },
  ]);
  assert.equal(snapshot.orderbook.bidSize, 2);
  assert.equal(snapshot.orderbook.askSize, 3);
});
test('public client retries 429 and never accepts stale top of book', async () => {
  let orderbookCalls = 0;
  const waits: number[] = [];
  const client = new UpbitExternalPilotPublicDataClient(async (input) => {
    const url = String(input);
    if (!url.includes('/orderbook')) {
      const minutes = Number(url.match(/minutes\/(\d+)/u)?.[1]);
      return response(candles(minutes));
    }
    orderbookCalls += 1;
    if (orderbookCalls === 1) return response({ error: 'rate' }, 429, { 'retry-after': '0' });
    return response([{
      timestamp: NOW - 31_000,
      total_bid_size: 12,
      total_ask_size: 10,
      orderbook_units: [{ bid_price: 10_000, ask_price: 10_010, bid_size: 2, ask_size: 3 }],
    }]);
  }, async (ms) => { waits.push(ms); }, () => NOW, 0);

  await assert.rejects(client.snapshot('KRW-BTC'), /ORDERBOOK_INVALID_OR_STALE/);
  assert.equal(orderbookCalls, 2);
  assert.ok(waits.length >= 1);
});
